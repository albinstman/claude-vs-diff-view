import * as vscode from 'vscode';
import * as path from 'path';
import { Config } from '../core/config';
import { EventBus } from '../core/events';
import { DiffController } from '../diff/diffController';
import { HttpBridge } from '../bridge/httpBridge';
import { SessionStore } from '../core/sessionStore';

/** Show a countdown in the status bar when this close to the safety release. */
const SAFETY_COUNTDOWN_WINDOW_MS = 30_000;
const ACTIVE_EDIT_FLASH_MS = 2000;
/** Matches SessionStore's pending-Pre discard window. */
const STALE_IN_FLIGHT_MS = 60_000;

/**
 * Primary status bar item (idle / editing / dwelling / frozen) plus a
 * Follow on/off segment.
 */
export class StatusBarUi implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly main: vscode.StatusBarItem;
  private readonly follow: vscode.StatusBarItem;
  private tick?: NodeJS.Timeout;
  private lastEditedFile?: string;
  private lastEditAt = 0;
  /** Edits whose PreToolUse arrived but whose PostToolUse hasn't (spinner state). */
  private readonly inFlight = new Map<string, number>();

  constructor(
    private readonly config: Config,
    bus: EventBus,
    private readonly diffController: DiffController,
    private readonly bridge: HttpBridge,
    private readonly store: SessionStore
  ) {
    this.main = vscode.window.createStatusBarItem('claudeBridge.main', vscode.StatusBarAlignment.Left, 100);
    this.main.name = 'Claude Bridge';
    this.main.command = 'claudeBridge.statusBarClick';
    this.follow = vscode.window.createStatusBarItem('claudeBridge.follow', vscode.StatusBarAlignment.Left, 99);
    this.follow.name = 'Claude Bridge: Follow';
    this.follow.command = 'claudeBridge.toggleFollow';

    this.disposables.push(
      this.main,
      this.follow,
      diffController.onDidChangeHolds(() => this.render()),
      bridge.onDidChangeState(() => this.render()),
      config.onDidChange(() => this.render()),
      bus.onEditStarted((e) => {
        this.inFlight.set(e.filePath, e.timestamp);
        // Backstop for a Pre whose Post never arrives (discarded after 60s).
        setTimeout(() => {
          if (this.inFlight.get(e.filePath) === e.timestamp) {
            this.inFlight.delete(e.filePath);
            this.render();
          }
        }, STALE_IN_FLIGHT_MS);
        this.render();
      }),
      bus.onEditCompleted((e) => {
        this.inFlight.delete(e.filePath);
        this.lastEditedFile = e.filePath;
        this.lastEditAt = e.timestamp;
        this.render();
        setTimeout(() => this.render(), ACTIVE_EDIT_FLASH_MS + 50);
      })
    );
    this.render();
  }

  render(): void {
    if (!this.config.statusBarEnabled) {
      this.main.hide();
      this.follow.hide();
      this.stopTicking();
      return;
    }

    const hold = this.diffController.currentHold;
    if (hold) {
      const now = Date.now();
      const untilSafety = hold.safetyDeadline - now;
      const safetyNote =
        untilSafety <= SAFETY_COUNTDOWN_WINDOW_MS
          ? ` · auto-release ${Math.max(0, Math.ceil(untilSafety / 1000))}s`
          : '';
      if (hold.mode === 'frozen') {
        this.main.text = `$(debug-pause) Frozen — ▶ Resume (⏎)${safetyNote}`;
        this.main.tooltip = this.holdTooltip(hold.filePath, 'Frozen until you resume');
      } else {
        const countdown = hold.dwellDeadline
          ? ` · ${Math.max(0, Math.ceil((hold.dwellDeadline - now) / 1000))}s`
          : '';
        this.main.text = `⏭ Skip (⏎) · ⏸ Freeze (space)${countdown}${safetyNote}`;
        this.main.tooltip = this.holdTooltip(hold.filePath, 'Holding Claude while you look at the diff');
      }
      this.main.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.startTicking();
    } else {
      this.main.backgroundColor = undefined;
      this.stopTicking();
      const now = Date.now();
      const editing = [...this.inFlight.entries()].sort((a, b) => b[1] - a[1])[0];
      if (editing) {
        this.main.text = `$(loading~spin) editing ${path.basename(editing[0])}`;
      } else if (this.lastEditedFile && now - this.lastEditAt < ACTIVE_EDIT_FLASH_MS) {
        this.main.text = `✻ edited ${path.basename(this.lastEditedFile)}`;
      } else {
        this.main.text = '✻ Claude Bridge';
      }
      this.main.tooltip = this.idleTooltip();
    }
    this.main.show();

    this.follow.text = `✻ Follow: ${this.config.followEnabled ? 'on' : 'off'}`;
    this.follow.tooltip = 'Toggle revealing files in the Explorer as Claude edits them';
    this.follow.show();
  }

  private idleTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown('**Claude Bridge**\n\n');
    md.appendMarkdown(
      this.bridge.running
        ? `Listening on \`127.0.0.1:${this.bridge.port}\`\n\n`
        : `⚠ Bridge not running${this.bridge.lastError ? ` — ${this.bridge.lastError}` : ''}\n\n`
    );
    md.appendMarkdown(
      this.bridge.lastEventAt
        ? `Last hook event: ${new Date(this.bridge.lastEventAt).toLocaleTimeString()}\n\n`
        : 'No hook events yet — are the Claude Code hooks installed?\n\n'
    );
    md.appendMarkdown(`Files touched: ${this.store.fileCount}\n\n`);
    md.appendMarkdown('_Click for quick settings_');
    return md;
  }

  private holdTooltip(filePath: string, headline: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${headline}**\n\n\`${filePath}\`\n\n`);
    md.appendMarkdown('⏎ resume · space freeze · shift+⏎ skip burst\n\n_Click to resume_');
    return md;
  }

  private startTicking(): void {
    if (this.tick) {
      return;
    }
    this.tick = setInterval(() => this.render(), 1000);
  }

  private stopTicking(): void {
    if (this.tick) {
      clearInterval(this.tick);
      this.tick = undefined;
    }
  }

  dispose(): void {
    this.stopTicking();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
