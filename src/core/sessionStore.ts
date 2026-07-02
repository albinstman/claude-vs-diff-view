import * as vscode from 'vscode';
import * as crypto from 'crypto';
import {
  EventBus,
  EditStartedEvent,
  EditCompletedEvent,
  ExternalChangeEvent,
} from './events';
import { Config } from './config';

export type SnapshotSkipReason = 'tooLarge' | 'binary';

export interface SnapshotEntry {
  timestamp: number;
  /** In-memory content; undefined when spilled to disk (see spilledUri) or for created-file null snapshots. */
  content?: Uint8Array;
  /** Set when the pre-image didn't exist (file created by Claude). */
  isNull: boolean;
  byteLength: number;
  spilledUri?: vscode.Uri;
}

export interface FileRecord {
  filePath: string;
  uri: vscode.Uri;
  editCount: number;
  externalChangeCount: number;
  firstEventAt: number;
  lastEditAt: number;
  editTimestamps: number[];
  /** snapshots[0] is the session-start baseline. */
  snapshots: SnapshotEntry[];
  createdByClaude: boolean;
  external: boolean;
  deleted: boolean;
  snapshotSkippedReason?: SnapshotSkipReason;
  lastToolName?: string;
  sessionId?: string;
  /** Set while a PreToolUse has been seen but its PostToolUse hasn't. */
  pendingSince?: number;
}

const PENDING_DISCARD_MS = 60_000;

/**
 * Session state: which files Claude touched, how often, and pre-edit
 * snapshots. Subscribes to the event bus; UI components read from here and
 * refresh on `onDidChangeFiles`.
 */
export class SessionStore implements vscode.Disposable {
  private readonly files = new Map<string, FileRecord>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingTimers = new Map<string, NodeJS.Timeout>();
  private totalSnapshotBytes = 0;
  private spillDir: vscode.Uri;
  private spillCounter = 0;
  /** Timestamps of recent hook events per file (for watcher correlation). */
  private readonly recentHookEvents = new Map<string, number>();
  lastHookEventAt = 0;

  private readonly _onDidChangeFiles = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFiles = this._onDidChangeFiles.event;

  constructor(
    private readonly bus: EventBus,
    private readonly config: Config,
    storageUri: vscode.Uri,
    private readonly log: vscode.OutputChannel
  ) {
    this.spillDir = vscode.Uri.joinPath(storageUri, 'snapshots');
    this.disposables.push(
      bus.onEditStarted((e) => this.handleEditStarted(e)),
      bus.onEditCompleted((e) => this.handleEditCompleted(e)),
      bus.onExternalChange((e) => this.handleExternalChange(e))
    );
  }

  // ── queries ────────────────────────────────────────────────────────────

  getRecord(filePath: string): FileRecord | undefined {
    return this.files.get(filePath);
  }

  getAllRecords(): FileRecord[] {
    return [...this.files.values()];
  }

  get fileCount(): number {
    return this.files.size;
  }

  wasRecentHookEvent(filePath: string, withinMs: number): boolean {
    const t = this.recentHookEvents.get(filePath);
    return t !== undefined && Date.now() - t <= withinMs;
  }

  get sessionPresumedActive(): boolean {
    return (
      this.lastHookEventAt > 0 &&
      Date.now() - this.lastHookEventAt <= this.config.watcherSessionActiveWindowMs
    );
  }

  /**
   * Take the pre-edit snapshot for a file. Called by HttpBridge on
   * PreToolUse BEFORE it responds (the edit happens only after we answer).
   */
  async snapshotFile(filePath: string): Promise<{ existed: boolean }> {
    const uri = vscode.Uri.file(filePath);
    const record = this.ensureRecord(filePath);
    this.noteHookEvent(filePath);

    let content: Uint8Array | undefined;
    let existed = false;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      existed = true;
      if (stat.size > this.config.snapshotsMaxFileBytes) {
        record.snapshotSkippedReason = 'tooLarge';
        this.log.appendLine(`[snapshots] skip (too large ${stat.size}B): ${filePath}`);
        return { existed };
      }
      content = await vscode.workspace.fs.readFile(uri);
      if (looksBinary(content)) {
        record.snapshotSkippedReason = 'binary';
        this.log.appendLine(`[snapshots] skip (binary): ${filePath}`);
        return { existed };
      }
    } catch {
      existed = false; // Write creating a new file
    }

    const entry: SnapshotEntry = {
      timestamp: Date.now(),
      content,
      isNull: !existed,
      byteLength: content?.byteLength ?? 0,
    };
    record.snapshots.push(entry);
    if (!existed && record.snapshots.length === 1) {
      record.createdByClaude = true;
    }
    this.totalSnapshotBytes += entry.byteLength;
    void this.enforceMemoryCap();
    return { existed };
  }

  /** Baseline snapshot for diffing: last pre-edit snapshot or the session-start one. */
  getBaselineSnapshot(filePath: string, baseline: 'lastEdit' | 'sessionStart'): SnapshotEntry | undefined {
    const record = this.files.get(filePath);
    if (!record || record.snapshots.length === 0) {
      return undefined;
    }
    return baseline === 'sessionStart'
      ? record.snapshots[0]
      : record.snapshots[record.snapshots.length - 1];
  }

  getSnapshotByTimestamp(filePath: string, timestamp: number): SnapshotEntry | undefined {
    return this.files.get(filePath)?.snapshots.find((s) => s.timestamp === timestamp);
  }

  /** Decode a snapshot to text, reading back from disk if it was spilled. */
  async readSnapshotText(entry: SnapshotEntry): Promise<string> {
    if (entry.isNull) {
      return '';
    }
    let bytes = entry.content;
    if (!bytes && entry.spilledUri) {
      bytes = await vscode.workspace.fs.readFile(entry.spilledUri);
    }
    return bytes ? new TextDecoder('utf-8').decode(bytes) : '';
  }

  // ── event handling ─────────────────────────────────────────────────────

  private handleEditStarted(e: EditStartedEvent): void {
    const record = this.ensureRecord(e.filePath);
    record.lastToolName = e.toolName;
    record.sessionId = e.sessionId ?? record.sessionId;
    record.pendingSince = e.timestamp;
    record.deleted = false;
    this.noteHookEvent(e.filePath);

    // A Pre without a matching Post within 60s → discard pending state.
    this.clearPendingTimer(e.filePath);
    const timer = setTimeout(() => {
      const r = this.files.get(e.filePath);
      if (r && r.pendingSince === e.timestamp) {
        this.log.appendLine(
          `[store] PreToolUse for ${e.filePath} never completed within ${PENDING_DISCARD_MS}ms — discarding pending state`
        );
        r.pendingSince = undefined;
        if (r.editCount === 0 && r.snapshots.length > 0) {
          // Drop the orphan snapshot so baselines stay meaningful.
          const orphan = r.snapshots.pop()!;
          this.totalSnapshotBytes -= orphan.byteLength;
        }
        this.fireChanged([r.uri]);
      }
      this.pendingTimers.delete(e.filePath);
    }, PENDING_DISCARD_MS);
    this.pendingTimers.set(e.filePath, timer);

    this.fireChanged([record.uri]);
  }

  private handleEditCompleted(e: EditCompletedEvent): void {
    const record = this.ensureRecord(e.filePath);
    record.editCount += 1;
    record.editTimestamps.push(e.timestamp);
    record.lastEditAt = e.timestamp;
    record.lastToolName = e.toolName;
    record.sessionId = e.sessionId ?? record.sessionId;
    record.pendingSince = undefined;
    record.deleted = false;
    if (e.created) {
      record.createdByClaude = true;
    }
    this.noteHookEvent(e.filePath);
    this.clearPendingTimer(e.filePath);

    this.fireChanged([record.uri]);
  }

  private handleExternalChange(e: ExternalChangeEvent): void {
    const record = this.ensureRecord(e.filePath);
    record.external = true;
    record.externalChangeCount += 1;
    if (e.changeType === 'delete') {
      record.deleted = true;
    } else {
      record.deleted = false;
    }
    this.fireChanged([record.uri]);
  }

  // ── management ─────────────────────────────────────────────────────────

  clearEntry(filePath: string): void {
    const record = this.files.get(filePath);
    if (!record) {
      return;
    }
    for (const s of record.snapshots) {
      this.totalSnapshotBytes -= s.byteLength;
      if (s.spilledUri) {
        void vscode.workspace.fs.delete(s.spilledUri).then(undefined, () => undefined);
      }
    }
    this.files.delete(filePath);
    this.clearPendingTimer(filePath);
    this.fireChanged([record.uri]);
  }

  async resetSession(): Promise<void> {
    const uris = [...this.files.values()].map((r) => r.uri);
    this.files.clear();
    this.recentHookEvents.clear();
    this.totalSnapshotBytes = 0;
    for (const t of this.pendingTimers.values()) {
      clearTimeout(t);
    }
    this.pendingTimers.clear();
    try {
      await vscode.workspace.fs.delete(this.spillDir, { recursive: true });
    } catch {
      // spill dir may not exist
    }
    this.bus.emitSessionReset();
    this.fireChanged(uris);
    this.log.appendLine('[store] session reset');
  }

  // ── internals ──────────────────────────────────────────────────────────

  private ensureRecord(filePath: string): FileRecord {
    let record = this.files.get(filePath);
    if (!record) {
      record = {
        filePath,
        uri: vscode.Uri.file(filePath),
        editCount: 0,
        externalChangeCount: 0,
        firstEventAt: Date.now(),
        lastEditAt: 0,
        editTimestamps: [],
        snapshots: [],
        createdByClaude: false,
        external: false,
        deleted: false,
      };
      this.files.set(filePath, record);
    }
    return record;
  }

  private noteHookEvent(filePath: string): void {
    const now = Date.now();
    this.recentHookEvents.set(filePath, now);
    this.lastHookEventAt = now;
  }

  private async enforceMemoryCap(): Promise<void> {
    const cap = this.config.snapshotsMaxTotalBytes;
    if (this.totalSnapshotBytes <= cap) {
      return;
    }
    // Spill oldest in-memory snapshots to disk until under the cap.
    const all: SnapshotEntry[] = [];
    for (const r of this.files.values()) {
      for (const s of r.snapshots) {
        if (s.content && s.byteLength > 0) {
          all.push(s);
        }
      }
    }
    all.sort((x, y) => x.timestamp - y.timestamp);
    for (const entry of all) {
      if (this.totalSnapshotBytes <= cap) {
        break;
      }
      try {
        const name = `${entry.timestamp}-${this.spillCounter++}-${crypto
          .randomBytes(4)
          .toString('hex')}.snap`;
        const target = vscode.Uri.joinPath(this.spillDir, name);
        await vscode.workspace.fs.writeFile(target, entry.content!);
        entry.spilledUri = target;
        this.totalSnapshotBytes -= entry.byteLength;
        entry.content = undefined;
        this.log.appendLine(`[snapshots] spilled ${entry.byteLength}B to disk (${name})`);
      } catch (err) {
        this.log.appendLine(`[snapshots] spill failed: ${String(err)}`);
        return;
      }
    }
  }

  private clearPendingTimer(filePath: string): void {
    const t = this.pendingTimers.get(filePath);
    if (t) {
      clearTimeout(t);
      this.pendingTimers.delete(filePath);
    }
  }

  private fireChanged(uris: vscode.Uri[]): void {
    this._onDidChangeFiles.fire(uris);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    for (const t of this.pendingTimers.values()) {
      clearTimeout(t);
    }
    this._onDidChangeFiles.dispose();
  }
}

/** Heuristic: NUL byte in the first 8 KB → binary. */
function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) {
      return true;
    }
  }
  return false;
}
