import * as vscode from 'vscode';
import { Config } from '../core/config';
import { SessionStore } from '../core/sessionStore';

/**
 * Badges/colors for files Claude touches: ✻ while active/lingering, an edit
 * count once settled, ◦ for changes seen only by the fallback watcher.
 */
export class DecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly config: Config,
    private readonly store: SessionStore
  ) {
    this.disposables.push(
      vscode.window.registerFileDecorationProvider(this),
      store.onDidChangeFiles((uris) => {
        // Refresh everything when propagation is on so parent folders update too.
        this._onDidChangeFileDecorations.fire(
          this.config.decorationsPropagateToFolders ? undefined : uris
        );
      })
    );
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!this.config.decorationsEnabled || uri.scheme !== 'file') {
      return undefined;
    }
    const record = this.store.getRecord(uri.fsPath);
    if (!record) {
      return undefined;
    }

    if (record.editCount === 0 && record.external) {
      const deco = new vscode.FileDecoration(
        '◦',
        'Changed outside Edit tools (Bash?) during a Claude session',
        new vscode.ThemeColor('claudeBridge.externalChangeColor')
      );
      deco.propagate = this.config.decorationsPropagateToFolders;
      return deco;
    }
    if (record.editCount === 0 && !record.pendingSince && record.state !== 'active') {
      return undefined;
    }

    let badge: string;
    let color: vscode.ThemeColor;
    let tooltip: string;
    switch (record.state) {
      case 'active':
        badge = '✻';
        color = new vscode.ThemeColor('claudeBridge.activeEditColor');
        tooltip = 'Claude is editing this file right now';
        break;
      case 'lingering':
        badge = '✻';
        color = new vscode.ThemeColor('claudeBridge.lingeringEditColor');
        tooltip = 'Claude just edited this file';
        break;
      default:
        badge = String(Math.min(record.editCount, 9));
        color = new vscode.ThemeColor('claudeBridge.touchedColor');
        tooltip = `Claude edited this file ${record.editCount} time${record.editCount === 1 ? '' : 's'} this session`;
        break;
    }
    const deco = new vscode.FileDecoration(badge, tooltip, color);
    deco.propagate = this.config.decorationsPropagateToFolders;
    return deco;
  }

  refreshAll(): void {
    this._onDidChangeFileDecorations.fire(undefined);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeFileDecorations.dispose();
  }
}
