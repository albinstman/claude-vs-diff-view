import * as vscode from 'vscode';
import { EventBus } from '../core/events';
import { Config } from '../core/config';
import { DiffController } from '../diff/diffController';
import { SNAPSHOT_SCHEME } from '../diff/snapshotProvider';

/** How long after a bridge-initiated UI action editor events are attributed to us, not the user. */
const SELF_ACTIVITY_WINDOW_MS = 1000;

/**
 * Reveals+selects files in the Explorer as Claude touches them.
 * Best-effort anti-fight: if the user recently interacted with the
 * editor/Explorer themselves, the reveal is skipped.
 */
export class ExplorerFollower implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private lastRevealAt = 0;
  private lastUserActivityAt = 0;

  constructor(
    bus: EventBus,
    private readonly config: Config,
    private readonly diffController: DiffController,
    private readonly log: vscode.OutputChannel
  ) {
    this.disposables.push(
      bus.onEditStarted((e) => {
        if (e.fileExisted) {
          void this.reveal(e.filePath);
        }
      }),
      bus.onEditCompleted((e) => {
        if (e.created) {
          // New file exists only after PostToolUse.
          void this.reveal(e.filePath);
        }
      }),
      // User-activity approximation (documented as best-effort).
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && !this.isBridgeCaused(editor.document.uri)) {
          this.lastUserActivityAt = Date.now();
        }
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (!this.isBridgeCaused(e.textEditor.document.uri)) {
          this.lastUserActivityAt = Date.now();
        }
      })
    );
  }

  private isBridgeCaused(uri: vscode.Uri): boolean {
    if (uri.scheme === SNAPSHOT_SCHEME) {
      return true;
    }
    return Date.now() - this.diffController.lastBridgeUiActionAt < SELF_ACTIVITY_WINDOW_MS;
  }

  private async reveal(filePath: string): Promise<void> {
    if (!this.config.followEnabled) {
      return;
    }
    const uri = vscode.Uri.file(filePath);
    if (!vscode.workspace.getWorkspaceFolder(uri)) {
      return; // outside the workspace — revealInExplorer would no-op/misbehave
    }
    const now = Date.now();
    if (now - this.lastRevealAt < this.config.followDebounceMs) {
      return;
    }
    if (now - this.lastUserActivityAt < this.config.followUserActivityGraceMs) {
      return;
    }
    this.lastRevealAt = now;
    this.diffController.lastBridgeUiActionAt = now;
    try {
      await vscode.commands.executeCommand('revealInExplorer', uri);
    } catch (err) {
      this.log.appendLine(`[follow] reveal failed for ${filePath}: ${String(err)}`);
    }
  }

  async toggle(): Promise<void> {
    await this.config.update('follow.enabled', !this.config.followEnabled);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
