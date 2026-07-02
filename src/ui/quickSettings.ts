import * as vscode from 'vscode';
import { Config } from '../core/config';

interface QuickItem extends vscode.QuickPickItem {
  action: () => Promise<void>;
}

/** Quick-pick for the most-tuned settings; writes to workspace settings. */
export async function showQuickSettings(config: Config): Promise<void> {
  const dwell = config.holdDwellMs;
  const dwellLabel =
    dwell === 0 ? 'off' : dwell === -1 ? 'until manual resume' : `${dwell / 1000}s`;

  const items: QuickItem[] = [
    {
      label: '$(watch) Dwell: off',
      description: dwell === 0 ? '● current' : 'never hold Claude',
      action: () => config.update('hold.dwellMs', 0),
    },
    {
      label: '$(watch) Dwell: 1.5s',
      description: dwell === 1500 ? '● current' : 'hold each edit briefly',
      action: () => config.update('hold.dwellMs', 1500),
    },
    {
      label: '$(watch) Dwell: 3s',
      description: dwell === 3000 ? '● current' : 'hold each edit',
      action: () => config.update('hold.dwellMs', 3000),
    },
    {
      label: '$(watch) Dwell: hold until resume',
      description: dwell === -1 ? '● current' : 'hold every edit until you press ⏎',
      action: () => config.update('hold.dwellMs', -1),
    },
    {
      label: `$(eye) Follow: turn ${config.followEnabled ? 'off' : 'on'}`,
      description: `Explorer reveal is ${config.followEnabled ? 'on' : 'off'} (currently dwell ${dwellLabel})`,
      action: () => config.update('follow.enabled', !config.followEnabled),
    },
    {
      label: `$(diff) Diff open: ${nextDiffOpen(config.diffOpen)}`,
      description: `currently '${config.diffOpen}' — click to cycle`,
      action: () => config.update('diff.open', nextDiffOpen(config.diffOpen)),
    },
    {
      label: `$(git-compare) Baseline: switch to ${config.diffBaseline === 'lastEdit' ? 'sessionStart' : 'lastEdit'}`,
      description: `currently '${config.diffBaseline}'`,
      action: () =>
        config.update(
          'diff.baseline',
          config.diffBaseline === 'lastEdit' ? 'sessionStart' : 'lastEdit'
        ),
    },
    {
      label: '$(clear-all) Reset session state',
      description: 'clear all tracked files, badges and snapshots',
      action: async () => {
        await vscode.commands.executeCommand('claudeBridge.resetSession');
      },
    },
    {
      label: '$(settings-gear) Open all Claude Bridge settings',
      description: '',
      action: async () => {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'claudeBridge');
      },
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Claude Bridge — Quick Settings',
    placeHolder: 'Tune the live-follow workflow',
  });
  if (picked) {
    await picked.action();
  }
}

function nextDiffOpen(current: string): 'always' | 'firstEditPerFile' | 'never' {
  switch (current) {
    case 'always':
      return 'firstEditPerFile';
    case 'firstEditPerFile':
      return 'never';
    default:
      return 'always';
  }
}
