import * as vscode from 'vscode';
import { EventBus } from './core/events';
import { Config } from './core/config';
import { SessionStore } from './core/sessionStore';
import { HttpBridge } from './bridge/httpBridge';
import { FsWatcherFallback } from './bridge/fsWatcher';
import { SnapshotProvider, SNAPSHOT_SCHEME } from './diff/snapshotProvider';
import { DiffController } from './diff/diffController';
import { ExplorerFollower } from './ui/explorerFollower';
import { StatusBarUi } from './ui/statusBar';
import { showQuickSettings } from './ui/quickSettings';
import { installHooksCommand, scheduleFirstRunNudge } from './core/hooksInstaller';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('Claude Bridge');
  context.subscriptions.push(log);
  log.appendLine('[extension] activating');

  await vscode.workspace.fs.createDirectory(context.globalStorageUri);

  const config = new Config();
  const bus = new EventBus();
  const store = new SessionStore(bus, config, context.globalStorageUri, log);
  const bridge = new HttpBridge(bus, config, store, context.globalStorageUri, log);
  const snapshotProvider = new SnapshotProvider(store);
  const diffController = new DiffController(bus, config, store, log);
  const follower = new ExplorerFollower(bus, config, diffController, log);
  const statusBar = new StatusBarUi(config, bus, diffController, bridge, store);
  const watcher = new FsWatcherFallback(bus, config, store, log);

  context.subscriptions.push(
    config,
    bus,
    store,
    bridge,
    snapshotProvider,
    diffController,
    follower,
    statusBar,
    watcher,
    vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, snapshotProvider)
  );

  // ── commands ─────────────────────────────────────────────────────────────
  const cmd = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  cmd('claudeBridge.resume', () => diffController.releaseCurrent('resume'));
  cmd('claudeBridge.skip', () => diffController.releaseCurrent('skip'));
  cmd('claudeBridge.skipBurst', () => diffController.skipBurst());
  cmd('claudeBridge.freeze', () => diffController.freezeCurrent());
  cmd('claudeBridge.toggleFollow', () => follower.toggle());
  cmd('claudeBridge.resetSession', () => store.resetSession());
  cmd('claudeBridge.quickSettings', () => showQuickSettings(config));
  cmd('claudeBridge.openLastDiff', () => diffController.openLastDiff());
  cmd('claudeBridge.installHooks', () => installHooksCommand(config, log));
  cmd('claudeBridge.statusBarClick', () => {
    if (diffController.holding) {
      diffController.releaseCurrent('status bar click');
    } else {
      void showQuickSettings(config);
    }
  });
  // ── config reactions ─────────────────────────────────────────────────────
  context.subscriptions.push(
    config.onDidChange((e) => {
      if (e.affectsConfiguration('claudeBridge.port')) {
        log.appendLine('[extension] port changed — restarting bridge');
        bridge.queueRestart();
      }
      if (
        e.affectsConfiguration('claudeBridge.statusBar') ||
        e.affectsConfiguration('claudeBridge.follow.enabled')
      ) {
        statusBar.render();
      }
    })
  );

  // ── initial context keys + server ────────────────────────────────────────
  void vscode.commands.executeCommand('setContext', 'claudeBridge.holding', false);
  void vscode.commands.executeCommand('setContext', 'claudeBridge.frozen', false);

  await bridge.start();
  statusBar.render();
  scheduleFirstRunNudge(context, config, log, () => bridge.lastEventAt > 0);
  log.appendLine('[extension] activated');
}

export function deactivate(): void {
  // Pending holds are released by HttpBridge.dispose(); Claude Code fails
  // open on its own hook timeout if the extension host dies uncleanly.
}
