# Claude Bridge — live edit visibility for Claude Code in VS Code

Follow Claude Code's work **while it happens** instead of reviewing at the end:

- **Explorer follow (default on):** every file Claude edits is revealed and
  selected in the Explorer as it's touched.
- **Persistent marks:** files get `✻` badges and colors while being edited,
  then an edit-count badge for the rest of the session (Explorer, tabs, quick
  open). Changes made via Bash (`sed -i`, …) get a `◦` badge via a watcher
  fallback.
- **Native diffs:** each edit opens a VS Code diff of the pre-edit snapshot vs
  the current file.
- **Transport controls:** optionally hold Claude after each edit for a dwell
  time with a status-bar countdown — resume (⏎), freeze (space), or skip a
  burst (shift+⏎).
- **Session tree:** a `✻` Activity Bar view lists everything Claude changed,
  grouped by directory or by recency, with `+added −deleted` counts.

Architecture: Claude Code `PreToolUse`/`PostToolUse` HTTP hooks POST to a
localhost server inside this extension; the PostToolUse response is the hold
point. See `claude-hooks/README.md`.

## Install

```bash
npm install
npm run build
npx vsce package --allow-missing-repository   # produces claude-bridge-0.1.0.vsix
code --install-extension claude-bridge-0.1.0.vsix
```

Then install the Claude Code hooks — see
`claude-hooks/README.md`. Quick version:

1. Merge `claude-hooks/settings-snippet.json` into `.claude/settings.json`.
2. Start a Claude Code session and ask it to edit something.

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
| `follow.userActivityGraceMs` | `2000` | skip reveals right after you interacted with the UI (best-effort) |
| `diff.open` | `always` | `always` \| `firstEditPerFile` \| `never` |
| `diff.baseline` | `lastEdit` | left side: snapshot before this edit, or `sessionStart` |
| `diff.preview` | `true` | open diffs as preview tabs |
| `diff.preserveFocus` | `true` | don't steal focus from the terminal |
| `diff.maxOpenDiffs` | `3` | close oldest bridge-owned diff tabs beyond this (0 = unlimited) |
| `diff.closeOnRelease` | `false` | close the diff when the hold releases |
| `hold.dwellMs` | `0` | `0` never hold · `>0` hold that long · `-1` hold until manual resume |
| `hold.onlyFirstEditPerFile` | `false` | hold only on a file's first edit |
| `hold.minChangedLines` | `0` | hold only if the edit changed ≥ N lines |
| `hold.onlyWhenFocused` | `true` | hold only while the VS Code window is focused |
| `hold.include` / `hold.exclude` | `[]` / lockfiles+generated | glob filters for holding |
| `hold.burstQuietMs` | `4000` | quiet period ending a burst skip |
| `hold.burstScope` | `file` | burst ends on a different file (`file`) or only on quiet (`time`) |
| `hold.hookTimeoutSeconds` | `600` | must mirror the hooks config `timeout` |
| `hold.timeoutSafetyMs` | `5000` | auto-release holds this early before the hook timeout |
| `decorations.enabled` | `true` | badges/colors on touched files |
| `decorations.lingerMs` | `2500` | how long the "just edited" highlight lasts |
| `decorations.propagateToFolders` | `true` | parent folders show activity |
| `statusBar.enabled` | `true` | show the status bar items |
| `tree.grouping` | `directory` | tree view grouping (`directory` \| `recency`) |
| `watcher.enabled` | `true` | fallback watcher for Bash-made changes |
| `watcher.exclude` | node_modules, .git, … | globs the watcher ignores (merged with `files.exclude`) |
| `watcher.sessionActiveWindowMs` | `600000` | how long a session counts as active after the last hook event |
| `snapshots.maxTotalMB` | `200` | in-memory snapshot cap; oldest spill to disk beyond it |
| `snapshots.maxFileMB` | `5` | larger files are not snapshotted (no diff) |

Everything hot-reloads except `port` (which restarts the bridge server).

Theme colors (override in `workbench.colorCustomizations`):
`claudeBridge.activeEditColor`, `claudeBridge.lingeringEditColor`,
`claudeBridge.touchedColor`, `claudeBridge.externalChangeColor`.

## Behavior notes & limitations (v1)

- **View-only.** No accept/reject — rejecting edits stays Claude Code's job.
- **New files:** created files diff against an empty left side and are revealed
  after PostToolUse (they don't exist before it).
- **MultiEdit** = one snapshot pair, one diff, one hold.
- **Parallel subagents:** interleaved Pre/Post events are held per-request; a
  Pre without its Post for 60s is discarded.
- **Files outside the workspace** are tracked in the tree with absolute paths;
  Explorer reveal is skipped for them.
- **Deleted files** keep a `(deleted)` tree entry until you clear them.
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
