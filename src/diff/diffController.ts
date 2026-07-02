import * as vscode from 'vscode';
import * as path from 'path';
import { EventBus, EditCompletedEvent, HoldHandle } from '../core/events';
import { Config, DiffBaseline } from '../core/config';
import { SessionStore, SnapshotEntry } from '../core/sessionStore';
import { SnapshotProvider } from './snapshotProvider';
import { matchesAnyGlob } from '../core/glob';
import { countLineDiff } from '../core/lineDiff';

export type HoldMode = 'dwelling' | 'frozen';

export interface ActiveHold {
  requestId: string;
  filePath: string;
  hold: HoldHandle;
  mode: HoldMode;
  startedAt: number;
  /** When the dwell timer fires (absent for dwellMs = -1 or frozen). */
  dwellDeadline?: number;
  /** Hard deadline: hook timeout minus safety margin. */
  safetyDeadline: number;
  dwellTimer?: NodeJS.Timeout;
  safetyTimer?: NodeJS.Timeout;
}

interface BurstState {
  quietDeadline: number;
  filePath: string;
}

/**
 * Opens diffs on completed edits and runs the hold state machine
 * (dwelling → frozen → released) against the pending PostToolUse response.
 */
export class DiffController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly holds: ActiveHold[] = [];
  private burst?: BurstState;
  /** Diff tabs we opened, oldest first, keyed by left-side URI string. */
  private ownedDiffs: { key: string; filePath: string }[] = [];
  private lastDiff?: { filePath: string; snapshot: SnapshotEntry; baseline: DiffBaseline };
  /** Timestamp of the last UI action we initiated (ExplorerFollower uses this to ignore self-caused "user activity"). */
  lastBridgeUiActionAt = 0;

  private readonly _onDidChangeHolds = new vscode.EventEmitter<void>();
  readonly onDidChangeHolds = this._onDidChangeHolds.event;

  constructor(
    bus: EventBus,
    private readonly config: Config,
    private readonly store: SessionStore,
    private readonly log: vscode.OutputChannel
  ) {
    this.disposables.push(
      bus.onEditCompleted((e) => this.handleEditCompleted(e)),
      bus.onSessionReset(() => this.releaseAll('session reset'))
    );
  }

  get currentHold(): ActiveHold | undefined {
    return this.holds[0];
  }

  get holding(): boolean {
    return this.holds.length > 0;
  }

  // ── event handling ─────────────────────────────────────────────────────

  private handleEditCompleted(e: EditCompletedEvent): void {
    this.noteBurstEdit(e.filePath);

    const record = this.store.getRecord(e.filePath);
    const snapshot = this.store.getBaselineSnapshot(e.filePath, this.config.diffBaseline);
    const diffable = !!record && !record.snapshotSkippedReason && !!snapshot;

    if (diffable && this.shouldOpenDiff(e)) {
      void this.openDiff(e.filePath, snapshot!, this.config.diffBaseline);
    }

    if (this.shouldHold(e)) {
      e.hold.claim();
      this.beginHold(e);
      // The minChangedLines filter needs post-edit content — check async and
      // release early if the edit is below the threshold.
      if (this.config.holdMinChangedLines > 0 && diffable) {
        void this.checkMinChangedLines(e, snapshot!);
      }
    }
  }

  private shouldOpenDiff(e: EditCompletedEvent): boolean {
    const mode = this.config.diffOpen;
    if (mode === 'never') {
      return false;
    }
    if (mode === 'firstEditPerFile') {
      const record = this.store.getRecord(e.filePath);
      return (record?.editCount ?? 0) <= 1;
    }
    return true;
  }

  private shouldHold(e: EditCompletedEvent): boolean {
    const dwellMs = this.config.holdDwellMs;
    if (dwellMs === 0) {
      return false;
    }
    if (this.config.holdOnlyWhenFocused && !vscode.window.state.focused) {
      return false;
    }
    if (this.config.holdOnlyFirstEditPerFile) {
      const record = this.store.getRecord(e.filePath);
      if ((record?.editCount ?? 0) > 1) {
        return false;
      }
    }
    const include = this.config.holdInclude;
    if (include.length > 0 && !matchesAnyGlob(e.filePath, include)) {
      return false;
    }
    if (matchesAnyGlob(e.filePath, this.config.holdExclude)) {
      return false;
    }
    if (this.isBurstActive(e.filePath)) {
      return false;
    }
    return true;
  }

  private async checkMinChangedLines(e: EditCompletedEvent, snapshot: SnapshotEntry): Promise<void> {
    try {
      const before = await this.store.readSnapshotText(snapshot);
      const afterBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(e.filePath));
      const after = new TextDecoder('utf-8').decode(afterBytes);
      const { added, deleted } = countLineDiff(before, after);
      if (added + deleted < this.config.holdMinChangedLines) {
        this.releaseHoldById(e.requestId, 'below minChangedLines');
      }
    } catch (err) {
      this.log.appendLine(`[diff] minChangedLines check failed: ${String(err)}`);
    }
  }

  // ── hold state machine ─────────────────────────────────────────────────

  private beginHold(e: EditCompletedEvent): void {
    const now = Date.now();
    const dwellMs = this.config.holdDwellMs;
    const safetyDeadline =
      now + this.config.holdHookTimeoutSeconds * 1000 - this.config.holdTimeoutSafetyMs;

    const active: ActiveHold = {
      requestId: e.requestId,
      filePath: e.filePath,
      hold: e.hold,
      mode: 'dwelling',
      startedAt: now,
      safetyDeadline,
    };

    if (dwellMs > 0) {
      active.dwellDeadline = now + dwellMs;
      active.dwellTimer = setTimeout(
        () => this.releaseHoldById(e.requestId, 'dwell elapsed'),
        dwellMs
      );
    }
    // dwellMs === -1 → no dwell timer, manual resume (safety timer still applies).
    const safetyMs = safetyDeadline - now;
    if (safetyMs > 0) {
      active.safetyTimer = setTimeout(
        () => this.releaseHoldById(e.requestId, 'hook timeout safety'),
        safetyMs
      );
    }

    this.holds.push(active);
    this.log.appendLine(
      `[hold] holding ${e.requestId} for ${path.basename(e.filePath)} (dwellMs=${dwellMs})`
    );
    this.updateContexts();
  }

  freezeCurrent(): void {
    const hold = this.currentHold;
    if (!hold || hold.mode === 'frozen') {
      return;
    }
    hold.mode = 'frozen';
    if (hold.dwellTimer) {
      clearTimeout(hold.dwellTimer);
      hold.dwellTimer = undefined;
    }
    hold.dwellDeadline = undefined;
    this.log.appendLine(`[hold] frozen ${hold.requestId}`);
    this.updateContexts();
  }

  /** resume and skip are functionally identical in v1 (separate commands for future divergence). */
  releaseCurrent(reason: string): void {
    const hold = this.currentHold;
    if (hold) {
      this.releaseHoldById(hold.requestId, reason);
    }
  }

  skipBurst(): void {
    const hold = this.currentHold;
    const filePath = hold?.filePath ?? '';
    this.burst = {
      quietDeadline: Date.now() + this.config.holdBurstQuietMs,
      filePath,
    };
    this.log.appendLine(`[hold] burst skip engaged (scope=${this.config.holdBurstScope})`);
    if (hold) {
      this.releaseHoldById(hold.requestId, 'burst skip');
    }
  }

  private isBurstActive(incomingFile: string): boolean {
    if (!this.burst) {
      return false;
    }
    if (Date.now() > this.burst.quietDeadline) {
      this.burst = undefined;
      return false;
    }
    if (this.config.holdBurstScope === 'file' && incomingFile !== this.burst.filePath) {
      this.burst = undefined;
      this.log.appendLine('[hold] burst ended (different file)');
      return false;
    }
    return true;
  }

  /** Every edit event slides the burst quiet deadline. */
  private noteBurstEdit(filePath: string): void {
    if (!this.burst) {
      return;
    }
    if (Date.now() > this.burst.quietDeadline) {
      this.burst = undefined;
      return;
    }
    if (this.config.holdBurstScope === 'file' && filePath !== this.burst.filePath) {
      return; // isBurstActive will end the burst for this event
    }
    this.burst.quietDeadline = Date.now() + this.config.holdBurstQuietMs;
  }

  private releaseHoldById(requestId: string, reason: string): void {
    const idx = this.holds.findIndex((h) => h.requestId === requestId);
    if (idx === -1) {
      return;
    }
    const [hold] = this.holds.splice(idx, 1);
    if (hold.dwellTimer) {
      clearTimeout(hold.dwellTimer);
    }
    if (hold.safetyTimer) {
      clearTimeout(hold.safetyTimer);
    }
    hold.hold.release(reason);
    if (this.config.diffCloseOnRelease) {
      void this.closeDiffsForFile(hold.filePath);
    }
    this.updateContexts();
  }

  private releaseAll(reason: string): void {
    while (this.holds.length > 0) {
      this.releaseHoldById(this.holds[0].requestId, reason);
    }
  }

  private updateContexts(): void {
    const holding = this.holding;
    const frozen = this.currentHold?.mode === 'frozen';
    void vscode.commands.executeCommand('setContext', 'claudeBridge.holding', holding);
    void vscode.commands.executeCommand('setContext', 'claudeBridge.frozen', frozen);
    this._onDidChangeHolds.fire();
  }

  // ── diff tabs ──────────────────────────────────────────────────────────

  async openDiff(filePath: string, snapshot: SnapshotEntry, baseline: DiffBaseline): Promise<void> {
    const fileUri = vscode.Uri.file(filePath);
    const leftUri = SnapshotProvider.makeUri(filePath, snapshot.timestamp, baseline);
    const relPath = vscode.workspace.asRelativePath(fileUri, false);
    const suffix = snapshot.isNull ? ' — created' : '';
    const title = `✻ ${relPath} (Claude${suffix})`;
    this.lastBridgeUiActionAt = Date.now();
    this.lastDiff = { filePath, snapshot, baseline };
    try {
      await vscode.commands.executeCommand('vscode.diff', leftUri, fileUri, title, {
        preview: this.config.diffPreview,
        preserveFocus: this.config.diffPreserveFocus,
      });
    } catch (err) {
      this.log.appendLine(`[diff] failed to open diff for ${filePath}: ${String(err)}`);
      return;
    }
    const key = leftUri.toString();
    this.ownedDiffs = this.ownedDiffs.filter((d) => d.key !== key);
    this.ownedDiffs.push({ key, filePath });
    await this.enforceMaxOpenDiffs();
  }

  /** Open a diff for a file using a specific baseline (tree/commands entry point). */
  async openDiffForFile(filePath: string, baseline?: DiffBaseline): Promise<void> {
    const kind = baseline ?? this.config.diffBaseline;
    const snapshot = this.store.getBaselineSnapshot(filePath, kind);
    const record = this.store.getRecord(filePath);
    if (!snapshot || record?.snapshotSkippedReason) {
      void vscode.window.showInformationMessage(
        `Claude Bridge: no diff available for ${path.basename(filePath)}${
          record?.snapshotSkippedReason ? ` (${record.snapshotSkippedReason})` : ''
        }`
      );
      return;
    }
    await this.openDiff(filePath, snapshot, kind);
  }

  async openLastDiff(): Promise<void> {
    if (!this.lastDiff) {
      void vscode.window.showInformationMessage('Claude Bridge: no diff opened yet this session.');
      return;
    }
    await this.openDiff(this.lastDiff.filePath, this.lastDiff.snapshot, this.lastDiff.baseline);
  }

  private async enforceMaxOpenDiffs(): Promise<void> {
    const max = this.config.diffMaxOpenDiffs;
    if (max <= 0) {
      return;
    }
    const openOwned = this.collectOwnedTabs();
    // Prune bookkeeping for tabs the user closed themselves.
    const openKeys = new Set(openOwned.map(({ key }) => key));
    this.ownedDiffs = this.ownedDiffs.filter((d) => openKeys.has(d.key));
    while (this.ownedDiffs.length > max) {
      const oldest = this.ownedDiffs.shift()!;
      const tab = openOwned.find(({ key }) => key === oldest.key)?.tab;
      if (tab) {
        try {
          await vscode.window.tabGroups.close(tab);
        } catch (err) {
          this.log.appendLine(`[diff] failed to close tab: ${String(err)}`);
        }
      }
    }
  }

  private async closeDiffsForFile(filePath: string): Promise<void> {
    const owned = this.collectOwnedTabs().filter(
      ({ key }) => this.ownedDiffs.some((d) => d.key === key && d.filePath === filePath)
    );
    for (const { tab, key } of owned) {
      try {
        await vscode.window.tabGroups.close(tab);
      } catch {
        /* already closed */
      }
      this.ownedDiffs = this.ownedDiffs.filter((d) => d.key !== key);
    }
  }

  /** Only tabs whose diff-original URI matches one we opened — never touch other tabs. */
  private collectOwnedTabs(): { key: string; tab: vscode.Tab }[] {
    const ownedKeys = new Set(this.ownedDiffs.map((d) => d.key));
    const result: { key: string; tab: vscode.Tab }[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputTextDiff) {
          const key = tab.input.original.toString();
          if (ownedKeys.has(key)) {
            result.push({ key, tab });
          }
        }
      }
    }
    return result;
  }

  dispose(): void {
    this.releaseAll('extension disposed');
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeHolds.dispose();
  }
}
