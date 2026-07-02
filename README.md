# Claude Bridge — live edit visibility for Claude Code in VS Code

Follow Claude Code's work **while it happens** instead of reviewing at the end:

- **Explorer follow (default on):** every file Claude edits is revealed and
  selected in the Explorer as it's touched — the moving selection *is* the
  "Claude is here" marker. The extension adds no Explorer decorations of its
  own; git's colors/badges (green for new, orange for modified) stay
  authoritative.
- **Status bar activity:** a spinner (`editing greeter.py`) while an edit is
  in flight, a brief `✻ edited …` afterward.
- **Native diffs:** each edit opens a VS Code diff of the pre-edit snapshot vs
  the current file.
- **Transport controls:** each edit holds Claude for 3s by default while the
  diff is up, with a status-bar countdown — resume (⏎), freeze (space), or
  skip a burst (shift+⏎). Diffs stay open after release until newer ones push
  them past `diff.maxOpenDiffs`. Set `hold.dwellMs: 0` for no holding.

There is deliberately no extra Explorer decoration or activity-bar view: the
regular Explorer (selection + git badges) is the UI, plus the status bar and
the diffs themselves.

Architecture: Claude Code `PreToolUse`/`PostToolUse` HTTP hooks POST to a
localhost server inside this extension; the PostToolUse response is the hold
point. See `claude-hooks/README.md`.

## Install (once per machine — new projects need nothing)

1. Install **Claude Bridge** from the VS Code Marketplace
   (`Albinstman.claude-bridge`).
2. Run **Claude Bridge: Install Claude Code Hooks** from the command palette
   and pick **User settings** — this merges the hooks into
   `~/.claude/settings.json`, so they apply to *every* project. (If you skip
   this, the extension notices the missing hooks and offers to install them.)
3. Start a Claude Code session and ask it to edit something.

That's the whole setup. The hooks fail open, so projects/machines without the
extension running are completely unaffected. For devcontainers, add the
extension ID to `devcontainer.json` so each container comes up ready:

```jsonc
"customizations": { "vscode": { "extensions": ["Albinstman.claude-bridge"] } }
```

Manual/offline install from source:

```bash
npm install && npm run build && npx vsce package
code --install-extension claude-bridge-*.vsix
```

The hooks JSON is documented in `claude-hooks/README.md` if you prefer to
merge it by hand (project-level `.claude/settings.json` works too — just don't
install both levels, or every edit fires twice).

## Everyday controls

| Surface | What it does |
|---|---|
| `✻ Claude Bridge` status item | idle: click for quick settings; holding: click to resume |
| `✻ Follow: on/off` status item | toggle Explorer follow |
| `⏎` (Enter) | resume Claude (while holding, when no input is focused) |
| `space` | freeze on the current diff (until you resume) |
| `shift+⏎` | skip burst — no holds until Claude moves to another file / goes quiet |
| `ctrl+alt+enter` | skip (works even while an editor has focus) |
| Quick settings (status bar click) | dwell presets 0 / 1.5s / 3s / hold, follow, diff mode, baseline |

## Settings (all under `claudeBridge.`)

| Setting | Default | Meaning |
|---|---|---|
| `port` | `38217` | bridge port (restarts server on change; probes +10 if busy) |
| `follow.enabled` | `true` | reveal+select files in the Explorer as Claude edits |
| `follow.debounceMs` | `500` | max one reveal per this interval |
| `follow.userActivityGraceMs` | `0` | skip reveals right after you interacted with the UI (0 = always reveal) |
| `diff.open` | `always` | `always` \| `firstEditPerFile` \| `never` |
| `diff.baseline` | `lastEdit` | left side: snapshot before this edit, or `sessionStart` |
| `diff.preview` | `true` | open diffs as preview tabs |
| `diff.preserveFocus` | `true` | don't steal focus from the terminal |
| `diff.maxOpenDiffs` | `3` | close oldest bridge-owned diff tabs beyond this (0 = unlimited) |
| `diff.closeOnRelease` | `false` | close the diff when the hold releases (off: diffs stay until pushed out by `maxOpenDiffs`) |
| `hold.dwellMs` | `3000` | `0` never hold · `>0` hold that long · `-1` hold until manual resume |
| `hold.onlyFirstEditPerFile` | `false` | hold only on a file's first edit |
| `hold.minChangedLines` | `0` | hold only if the edit changed ≥ N lines |
| `hold.onlyWhenFocused` | `true` | hold only while the VS Code window is focused |
| `hold.include` / `hold.exclude` | `[]` / lockfiles+generated | glob filters for holding |
| `hold.burstQuietMs` | `4000` | quiet period ending a burst skip |
| `hold.burstScope` | `file` | burst ends on a different file (`file`) or only on quiet (`time`) |
| `hold.hookTimeoutSeconds` | `600` | must mirror the hooks config `timeout` |
| `hold.timeoutSafetyMs` | `5000` | auto-release holds this early before the hook timeout |
| `statusBar.enabled` | `true` | show the status bar items |
| `watcher.enabled` | `true` | fallback watcher for Bash-made changes |
| `watcher.exclude` | node_modules, .git, … | globs the watcher ignores (merged with `files.exclude`) |
| `watcher.sessionActiveWindowMs` | `600000` | how long a session counts as active after the last hook event |
| `snapshots.maxTotalMB` | `200` | in-memory snapshot cap; oldest spill to disk beyond it |
| `snapshots.maxFileMB` | `5` | larger files are not snapshotted (no diff) |

Everything hot-reloads except `port` (which restarts the bridge server).

## Behavior notes & limitations (v1)

- **View-only.** No accept/reject — rejecting edits stays Claude Code's job.
- **No Explorer decorations or side views.** By design the extension leaves
  file badges and colors to git; live activity shows as Explorer selection
  (follow) and the status bar spinner. Changes made via Bash are tracked
  internally (watcher) but have no UI beyond the status bar file count.
- **New files:** created files diff against an empty left side and are revealed
  after PostToolUse (they don't exist before it).
- **MultiEdit** = one snapshot pair, one diff, one hold.
- **Parallel subagents:** interleaved Pre/Post events are held per-request; a
  Pre without its Post for 60s is discarded.
- **Files outside the workspace** still get diffs and holds; Explorer reveal
  is skipped for them.
- **`.ipynb`** files are snapshotted as raw JSON; diffs are noisy, so they're
  in the default `hold.exclude`.
- **Extension reload mid-hold:** the pending hook request dies and Claude Code
  fails open — the session recovers by itself.
- **Multiple windows:** the second window's bridge lands on a probed port
  (+1…+10); v1 assumes a single session per window.
- **Remote/devcontainer:** the extension must run where the `claude` CLI runs
  (the workspace/remote side), which is the default for workspace extensions.
  If you sideload into a remote, `code --install-extension` from the remote's
  integrated terminal installs it in the right place.
- **Security:** the server binds `127.0.0.1` only and has **no
  authentication** — anything that can reach that port in the same
  environment can post events. Intended for sandboxed/devcontainer setups
  where the container is the security boundary. Request bodies (which contain
  file contents) are never logged.

## Releasing (maintainers)

Publishing is automated via `.github/workflows/publish.yml`. Per release: bump
`version` in `package.json`, commit, then `git tag v<version> && git push
--tags`. CI typechecks, packages, publishes to the Marketplace, and attaches
the `.vsix` to a GitHub release. The workflow fails fast if the tag and
`package.json` version disagree.

Authentication (one-time setup, workflow supports both):

- **Entra ID / workload identity federation — preferred.** Azure DevOps
  global PATs retire on 2026-12-01. Setup: create a Microsoft Entra
  app registration (or user-assigned managed identity), add a **federated
  credential** trusting this repo's GitHub Actions OIDC
  (issuer `https://token.actions.githubusercontent.com`, subject
  `repo:albinstman/claude-vs-diff-view:ref:refs/tags/v*` or `:ref:refs/heads/main`),
  then add that identity as a **member of the `Albinstman` publisher** with
  the Contributor role (marketplace.visualstudio.com → Manage publisher →
  Members). Finally set repo **variables** `AZURE_CLIENT_ID`,
  `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`. The workflow then uses
  `azure/login` + `vsce publish --azure-credential`.
- **Classic PAT — fallback until 2026-12-01.** dev.azure.com → User settings →
  Personal Access Tokens → organization "All accessible organizations", scope
  **Marketplace → Manage**; store as the `VSCE_PAT` repository secret. Used
  automatically when `AZURE_CLIENT_ID` is not configured.
