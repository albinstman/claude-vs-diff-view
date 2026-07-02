import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { Config } from './config';

const EDIT_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
const HOOK_EVENTS = ['PreToolUse', 'PostToolUse'] as const;
const NUDGE_DISMISSED_KEY = 'claudeBridge.hooksNudgeDismissed';
const NUDGE_DELAY_MS = 15_000;

interface HttpHook {
  type: string;
  url?: string;
  timeout?: number;
  [k: string]: unknown;
}
interface HookMatcherEntry {
  matcher?: string;
  hooks?: HttpHook[];
  [k: string]: unknown;
}
type ClaudeSettings = {
  hooks?: Record<string, HookMatcherEntry[]>;
  [k: string]: unknown;
};

function bridgeUrlPattern(): RegExp {
  return /^http:\/\/127\.0\.0\.1:\d+\/event$/;
}

function userSettingsUri(): vscode.Uri {
  return vscode.Uri.file(path.join(os.homedir(), '.claude', 'settings.json'));
}

function projectSettingsUri(): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? vscode.Uri.joinPath(folder.uri, '.claude', 'settings.json') : undefined;
}

async function readSettings(uri: vscode.Uri): Promise<ClaudeSettings> {
  let raw: string;
  try {
    raw = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return {}; // file doesn't exist yet
  }
  const parsed = JSON.parse(raw); // parse errors propagate — never clobber a file we can't read
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('settings root is not an object');
  }
  return parsed as ClaudeSettings;
}

/** True if any Pre/Post entry already POSTs to the bridge URL. */
function findBridgeHooks(settings: ClaudeSettings): HttpHook[] {
  const found: HttpHook[] = [];
  for (const event of HOOK_EVENTS) {
    for (const entry of settings.hooks?.[event] ?? []) {
      for (const hook of entry.hooks ?? []) {
        if (hook.type === 'http' && typeof hook.url === 'string' && bridgeUrlPattern().test(hook.url)) {
          found.push(hook);
        }
      }
    }
  }
  return found;
}

/**
 * Idempotently merge the bridge hooks into a Claude settings file. Existing
 * unrelated hooks are preserved; existing bridge hooks are updated in place
 * (port/timeout) rather than duplicated.
 */
export async function installHooks(
  uri: vscode.Uri,
  config: Config,
  log: vscode.OutputChannel
): Promise<'installed' | 'updated' | 'unchanged'> {
  const settings = await readSettings(uri);
  const url = `http://127.0.0.1:${config.port}/event`;
  const timeout = config.holdHookTimeoutSeconds;

  const existing = findBridgeHooks(settings);
  if (existing.length > 0) {
    let changed = false;
    for (const hook of existing) {
      if (hook.url !== url) {
        hook.url = url;
        changed = true;
      }
      if (hook.timeout !== timeout) {
        hook.timeout = timeout;
        changed = true;
      }
    }
    if (!changed) {
      return 'unchanged';
    }
    await writeSettings(uri, settings);
    log.appendLine(`[hooks] updated bridge hooks in ${uri.fsPath}`);
    return 'updated';
  }

  settings.hooks = settings.hooks ?? {};
  for (const event of HOOK_EVENTS) {
    const entries = (settings.hooks[event] = settings.hooks[event] ?? []);
    entries.push({
      matcher: EDIT_MATCHER,
      hooks: [{ type: 'http', url, timeout }],
    });
  }
  await writeSettings(uri, settings);
  log.appendLine(`[hooks] installed bridge hooks in ${uri.fsPath}`);
  return 'installed';
}

async function writeSettings(uri: vscode.Uri, settings: ClaudeSettings): Promise<void> {
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
  await vscode.workspace.fs.writeFile(
    uri,
    new TextEncoder().encode(JSON.stringify(settings, null, 2) + '\n')
  );
}

/** The "Claude Bridge: Install Claude Code Hooks" command. */
export async function installHooksCommand(config: Config, log: vscode.OutputChannel): Promise<void> {
  const project = projectSettingsUri();
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: '$(account) User settings (recommended)',
        description: '~/.claude/settings.json — applies to every project on this machine',
        target: userSettingsUri(),
      },
      ...(project
        ? [
            {
              label: '$(root-folder) This project',
              description: vscode.workspace.asRelativePath(project, true),
              target: project,
            },
          ]
        : []),
    ],
    { title: 'Install Claude Code hooks for Claude Bridge', placeHolder: 'Where should the hooks live?' }
  );
  if (!picked) {
    return;
  }
  try {
    const result = await installHooks(picked.target, config, log);
    const message =
      result === 'unchanged'
        ? 'Claude Bridge hooks were already installed and up to date.'
        : `Claude Bridge hooks ${result} in ${picked.target.fsPath}. Restart any running claude session to pick them up.`;
    void vscode.window.showInformationMessage(message);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Claude Bridge: could not update ${picked.target.fsPath}: ${String(err)}. The file was left untouched.`
    );
  }
}

/**
 * One-time nudge: if the bridge never received an event and no bridge hooks
 * exist in user or project settings, offer to install them.
 */
export function scheduleFirstRunNudge(
  context: vscode.ExtensionContext,
  config: Config,
  log: vscode.OutputChannel,
  hasReceivedEvent: () => boolean
): void {
  if (context.globalState.get<boolean>(NUDGE_DISMISSED_KEY)) {
    return;
  }
  setTimeout(async () => {
    if (hasReceivedEvent()) {
      return;
    }
    try {
      const targets = [userSettingsUri(), projectSettingsUri()].filter(
        (u): u is vscode.Uri => !!u
      );
      for (const uri of targets) {
        const settings = await readSettings(uri).catch(() => ({}) as ClaudeSettings);
        if (findBridgeHooks(settings).length > 0) {
          return; // hooks exist; the session just hasn't edited anything yet
        }
      }
    } catch {
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      'Claude Bridge is running, but no Claude Code hooks are installed — edits will not be visible. Install them now?',
      'Install Hooks…',
      "Don't Ask Again"
    );
    if (choice === 'Install Hooks…') {
      await installHooksCommand(config, log);
    } else if (choice === "Don't Ask Again") {
      await context.globalState.update(NUDGE_DISMISSED_KEY, true);
    }
  }, NUDGE_DELAY_MS);
}
