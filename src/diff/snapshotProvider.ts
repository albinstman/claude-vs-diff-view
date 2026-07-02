import * as vscode from 'vscode';
import { SessionStore } from '../core/sessionStore';

export const SNAPSHOT_SCHEME = 'claude-snapshot';

/**
 * Serves pre-edit snapshot content for the left side of diffs. The URI keeps
 * the original file path (so language/syntax detection works) and encodes
 * the snapshot timestamp in the query.
 */
export class SnapshotProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly store: SessionStore) {}

  static makeUri(filePath: string, timestamp: number, baseline: string): vscode.Uri {
    return vscode.Uri.file(filePath).with({
      scheme: SNAPSHOT_SCHEME,
      query: `ts=${timestamp}&baseline=${baseline}`,
    });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const ts = Number(params.get('ts'));
    const entry = this.store.getSnapshotByTimestamp(uri.fsPath, ts);
    if (!entry) {
      return '';
    }
    return this.store.readSnapshotText(entry);
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
