import * as vscode from 'vscode';

export type DiffOpenMode = 'always' | 'firstEditPerFile' | 'never';
export type DiffBaseline = 'lastEdit' | 'sessionStart';
export type BurstScope = 'file' | 'time';
export type TreeGrouping = 'directory' | 'recency';

/**
 * Typed accessor for all claudeBridge.* settings. Values are read live so
 * every setting hot-reloads; `onDidChange` lets components react (the
 * bridge restarts on port changes, others just re-read).
 */
export class Config implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.ConfigurationChangeEvent>();
  readonly onDidChange = this._onDidChange.event;
  private readonly sub: vscode.Disposable;

  constructor() {
    this.sub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeBridge')) {
        this._onDidChange.fire(e);
      }
    });
  }

  private get cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('claudeBridge');
  }

  get port(): number {
    return this.cfg.get<number>('port', 38217);
  }

  get followEnabled(): boolean {
    return this.cfg.get<boolean>('follow.enabled', true);
  }
  get followDebounceMs(): number {
    return this.cfg.get<number>('follow.debounceMs', 500);
  }
  get followUserActivityGraceMs(): number {
    return this.cfg.get<number>('follow.userActivityGraceMs', 2000);
  }

  get diffOpen(): DiffOpenMode {
    return this.cfg.get<DiffOpenMode>('diff.open', 'always');
  }
  get diffBaseline(): DiffBaseline {
    return this.cfg.get<DiffBaseline>('diff.baseline', 'lastEdit');
  }
  get diffPreview(): boolean {
    return this.cfg.get<boolean>('diff.preview', true);
  }
  get diffPreserveFocus(): boolean {
    return this.cfg.get<boolean>('diff.preserveFocus', true);
  }
  get diffMaxOpenDiffs(): number {
    return this.cfg.get<number>('diff.maxOpenDiffs', 3);
  }
  get diffCloseOnRelease(): boolean {
    return this.cfg.get<boolean>('diff.closeOnRelease', false);
  }

  get holdDwellMs(): number {
    return this.cfg.get<number>('hold.dwellMs', 0);
  }
  get holdOnlyFirstEditPerFile(): boolean {
    return this.cfg.get<boolean>('hold.onlyFirstEditPerFile', false);
  }
  get holdMinChangedLines(): number {
    return this.cfg.get<number>('hold.minChangedLines', 0);
  }
  get holdOnlyWhenFocused(): boolean {
    return this.cfg.get<boolean>('hold.onlyWhenFocused', true);
  }
  get holdInclude(): string[] {
    return this.cfg.get<string[]>('hold.include', []);
  }
  get holdExclude(): string[] {
    return this.cfg.get<string[]>('hold.exclude', []);
  }
  get holdBurstQuietMs(): number {
    return this.cfg.get<number>('hold.burstQuietMs', 4000);
  }
  get holdBurstScope(): BurstScope {
    return this.cfg.get<BurstScope>('hold.burstScope', 'file');
  }
  get holdHookTimeoutSeconds(): number {
    return this.cfg.get<number>('hold.hookTimeoutSeconds', 600);
  }
  get holdTimeoutSafetyMs(): number {
    return this.cfg.get<number>('hold.timeoutSafetyMs', 5000);
  }

  get decorationsEnabled(): boolean {
    return this.cfg.get<boolean>('decorations.enabled', true);
  }
  get decorationsLingerMs(): number {
    return this.cfg.get<number>('decorations.lingerMs', 2500);
  }
  get decorationsPropagateToFolders(): boolean {
    return this.cfg.get<boolean>('decorations.propagateToFolders', true);
  }

  get statusBarEnabled(): boolean {
    return this.cfg.get<boolean>('statusBar.enabled', true);
  }

  get treeGrouping(): TreeGrouping {
    return this.cfg.get<TreeGrouping>('tree.grouping', 'directory');
  }

  get watcherEnabled(): boolean {
    return this.cfg.get<boolean>('watcher.enabled', true);
  }
  get watcherExclude(): string[] {
    return this.cfg.get<string[]>('watcher.exclude', []);
  }
  get watcherSessionActiveWindowMs(): number {
    return this.cfg.get<number>('watcher.sessionActiveWindowMs', 600000);
  }

  get snapshotsMaxTotalBytes(): number {
    return this.cfg.get<number>('snapshots.maxTotalMB', 200) * 1024 * 1024;
  }
  get snapshotsMaxFileBytes(): number {
    return this.cfg.get<number>('snapshots.maxFileMB', 5) * 1024 * 1024;
  }

  /** Write a setting to workspace settings when a workspace is open, else user settings. */
  async update(key: string, value: unknown): Promise<void> {
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await this.cfg.update(key, value, target);
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChange.dispose();
  }
}
