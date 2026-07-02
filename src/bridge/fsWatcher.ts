import * as vscode from 'vscode';
import { EventBus } from '../core/events';
import { Config } from '../core/config';
import { SessionStore } from '../core/sessionStore';
import { matchesAnyGlob } from '../core/glob';

/** Hook events within this window of an fs change mean the change was Claude's own Edit. */
const HOOK_CORRELATION_MS = 1500;

/**
 * Fallback watcher for edits made outside the Edit tools (e.g. `sed -i`
 * via Bash). Only reports while a Claude session is presumed active, and
 * only for changes not explained by a recent hook event.
 */
export class FsWatcherFallback implements vscode.Disposable {
  private watcher?: vscode.FileSystemWatcher;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly bus: EventBus,
    private readonly config: Config,
    private readonly store: SessionStore,
    private readonly log: vscode.OutputChannel
  ) {
    this.disposables.push(
      config.onDidChange((e) => {
        if (e.affectsConfiguration('claudeBridge.watcher.enabled')) {
          this.sync();
        }
      })
    );
    this.sync();
  }

  private sync(): void {
    if (this.config.watcherEnabled && !this.watcher) {
      this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
      this.watcher.onDidChange((uri) => this.handle(uri, 'change'));
      this.watcher.onDidCreate((uri) => this.handle(uri, 'create'));
      this.watcher.onDidDelete((uri) => this.handle(uri, 'delete'));
      this.log.appendLine('[watcher] enabled');
    } else if (!this.config.watcherEnabled && this.watcher) {
      this.watcher.dispose();
      this.watcher = undefined;
      this.log.appendLine('[watcher] disabled');
    }
  }

  private handle(uri: vscode.Uri, changeType: 'change' | 'create' | 'delete'): void {
    if (uri.scheme !== 'file') {
      return;
    }
    const filePath = uri.fsPath;
    if (this.isExcluded(uri)) {
      return;
    }
    // Deletions of files Claude touched are always interesting (stale tree entries).
    const known = this.store.getRecord(filePath);
    if (changeType === 'delete' && known) {
      this.bus.emitExternalChange({ filePath, changeType, timestamp: Date.now() });
      return;
    }
    if (!this.store.sessionPresumedActive) {
      return;
    }
    if (this.store.wasRecentHookEvent(filePath, HOOK_CORRELATION_MS)) {
      return; // Claude's own Edit/Write — already tracked via hooks
    }
    this.bus.emitExternalChange({ filePath, changeType, timestamp: Date.now() });
  }

  private isExcluded(uri: vscode.Uri): boolean {
    const globs = [...this.config.watcherExclude];
    // Merge files.exclude entries that are enabled.
    const filesExclude = vscode.workspace.getConfiguration('files').get<Record<string, boolean>>('exclude', {});
    for (const [glob, on] of Object.entries(filesExclude)) {
      if (on) {
        globs.push(glob.endsWith('/**') || glob.includes('*') ? glob : `${glob}/**`);
        globs.push(glob);
      }
    }
    return matchesAnyGlob(uri.fsPath, globs);
  }

  dispose(): void {
    this.watcher?.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
