import * as vscode from 'vscode';
import * as path from 'path';
import { Config } from '../core/config';
import { SessionStore, FileRecord } from '../core/sessionStore';
import { countLineDiff } from '../core/lineDiff';

type TreeNode = DirNode | FileNode;

interface DirNode {
  kind: 'dir';
  label: string;
  files: FileRecord[];
}

interface FileNode {
  kind: 'file';
  record: FileRecord;
}

interface DiffCounts {
  added: number;
  deleted: number;
  approximate: boolean;
  /** lastEditAt the counts were computed for (cache key). */
  editStamp: number;
}

const REFRESH_INTERVAL_MS = 30_000;

/** "Claude Session Changes" tree: all touched files, grouped by directory or flat by recency. */
export class ChangesTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly view: vscode.TreeView<TreeNode>;
  private readonly diffCache = new Map<string, DiffCounts>();
  private refreshTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: Config,
    private readonly store: SessionStore,
    private readonly onUserInteraction: () => void
  ) {
    this.view = vscode.window.createTreeView('claudeBridge.changes', {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    this.disposables.push(
      this.view,
      store.onDidChangeFiles(() => this.refresh()),
      this.view.onDidChangeSelection(() => this.onUserInteraction()),
      this.view.onDidChangeVisibility((e) => {
        if (e.visible) {
          this.startRelativeTimeRefresh();
        } else {
          this.stopRelativeTimeRefresh();
        }
      })
    );
  }

  refresh(): void {
    this.view.badge =
      this.store.fileCount > 0
        ? { value: this.store.fileCount, tooltip: `${this.store.fileCount} files touched by Claude` }
        : undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      return this.config.treeGrouping === 'directory' ? this.rootByDirectory() : this.rootByRecency();
    }
    if (element.kind === 'dir') {
      return element.files
        .slice()
        .sort((a, b) => path.basename(a.filePath).localeCompare(path.basename(b.filePath)))
        .map((record) => ({ kind: 'file', record }));
    }
    return [];
  }

  private rootByDirectory(): TreeNode[] {
    const byDir = new Map<string, FileRecord[]>();
    for (const record of this.store.getAllRecords()) {
      const rel = vscode.workspace.asRelativePath(record.uri, false);
      const isOutside = path.isAbsolute(rel);
      const dir = isOutside ? path.dirname(record.filePath) : path.dirname(rel);
      const label = dir === '.' ? './' : dir;
      const list = byDir.get(label) ?? [];
      list.push(record);
      byDir.set(label, list);
    }
    return [...byDir.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, files]) => ({ kind: 'dir' as const, label, files }));
  }

  private rootByRecency(): TreeNode[] {
    return this.store
      .getAllRecords()
      .slice()
      .sort((a, b) => (b.lastEditAt || b.firstEventAt) - (a.lastEditAt || a.firstEventAt))
      .map((record) => ({ kind: 'file' as const, record }));
  }

  async getTreeItem(element: TreeNode): Promise<vscode.TreeItem> {
    if (element.kind === 'dir') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = vscode.ThemeIcon.Folder;
      item.description = `${element.files.length} file${element.files.length === 1 ? '' : 's'}`;
      item.contextValue = 'claudeBridgeDir';
      return item;
    }

    const record = element.record;
    const name = path.basename(record.filePath);
    const item = new vscode.TreeItem(
      record.deleted ? `${name} (deleted)` : name,
      vscode.TreeItemCollapsibleState.None
    );
    item.resourceUri = record.uri;
    item.iconPath = vscode.ThemeIcon.File;
    item.id = record.filePath;

    const diffable = record.snapshots.length > 0 && !record.snapshotSkippedReason;
    item.contextValue = diffable ? 'claudeBridgeFile.diffable' : 'claudeBridgeFile.plain';
    item.command = diffable
      ? {
          command: 'claudeBridge.openDiffForFile',
          title: 'Open Claude Diff',
          arguments: [record.filePath],
        }
      : {
          command: 'vscode.open',
          title: 'Open File',
          arguments: [record.uri],
        };

    item.description = await this.buildDescription(record, diffable);
    item.tooltip = this.buildTooltip(record);
    return item;
  }

  private async buildDescription(record: FileRecord, diffable: boolean): Promise<string> {
    const parts: string[] = [];
    if (diffable && !record.deleted) {
      const counts = await this.getDiffCounts(record);
      if (counts) {
        const approx = counts.approximate ? '~' : '';
        parts.push(`+${approx}${counts.added} −${approx}${counts.deleted}`);
      }
    } else if (record.snapshotSkippedReason) {
      parts.push(record.snapshotSkippedReason === 'binary' ? 'binary — no diff' : 'too large — no diff');
    }
    if (record.editCount > 0) {
      parts.push(`${record.editCount} edit${record.editCount === 1 ? '' : 's'}`);
    }
    if (record.external && record.editCount === 0) {
      parts.push('◦ external change');
    }
    const last = record.lastEditAt || record.firstEventAt;
    parts.push(`${formatAgo(Date.now() - last)} ago`);
    return parts.join(' · ');
  }

  private buildTooltip(record: FileRecord): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${record.filePath}**\n\n`);
    if (record.createdByClaude) {
      md.appendMarkdown('Created by Claude this session\n\n');
    }
    if (record.sessionId) {
      md.appendMarkdown(`Session: \`${record.sessionId}\`\n\n`);
    }
    if (record.editTimestamps.length > 0) {
      md.appendMarkdown('Edits:\n');
      for (const t of record.editTimestamps.slice(-15)) {
        md.appendMarkdown(`- ${new Date(t).toLocaleTimeString()}\n`);
      }
      if (record.editTimestamps.length > 15) {
        md.appendMarkdown(`- … ${record.editTimestamps.length - 15} earlier\n`);
      }
    }
    if (record.external) {
      md.appendMarkdown(
        `\n◦ ${record.externalChangeCount} change${record.externalChangeCount === 1 ? '' : 's'} outside Edit tools (Bash?) — no diff available for these\n`
      );
    }
    if (record.snapshotSkippedReason) {
      md.appendMarkdown(
        `\nSnapshot skipped (${record.snapshotSkippedReason}) — diff unavailable\n`
      );
    }
    return md;
  }

  private async getDiffCounts(record: FileRecord): Promise<DiffCounts | undefined> {
    const cached = this.diffCache.get(record.filePath);
    if (cached && cached.editStamp === record.lastEditAt) {
      return cached;
    }
    try {
      const baseline = record.snapshots[0]; // session start — matches "session changes" framing
      const before = await this.store.readSnapshotText(baseline);
      const afterBytes = await vscode.workspace.fs.readFile(record.uri);
      const after = new TextDecoder('utf-8').decode(afterBytes);
      const counts = { ...countLineDiff(before, after), editStamp: record.lastEditAt };
      this.diffCache.set(record.filePath, counts);
      return counts;
    } catch {
      return undefined; // file unreadable (deleted?) — no counts
    }
  }

  private startRelativeTimeRefresh(): void {
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = setInterval(() => {
      if (this.store.fileCount > 0) {
        this._onDidChangeTreeData.fire(undefined);
      }
    }, REFRESH_INTERVAL_MS);
  }

  private stopRelativeTimeRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  async toggleGrouping(): Promise<void> {
    const next = this.config.treeGrouping === 'directory' ? 'recency' : 'directory';
    await this.config.update('tree.grouping', next);
    this.refresh();
  }

  dispose(): void {
    this.stopRelativeTimeRefresh();
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}

function formatAgo(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
