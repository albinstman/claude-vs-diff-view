# Implementation Plan: "Claude Bridge" — Live Edit Visibility for Claude Code in VS Code

## 1. Purpose & Vision

I run the Claude Code CLI in the VS Code integrated terminal, usually with edit permissions granted (auto-accept). I want to **follow Claude's work live while it happens** instead of reviewing everything at the end. Concretely:

1. When Claude edits or creates a file, VS Code should **reveal and select that file in the Explorer** (like clicking it) — this is **default behavior**.
2. Files Claude is editing / has edited get **persistent visual marks** (badges + colors) in the Explorer, tabs, and a dedicated tree view.
3. Each edit opens a **native VS Code diff** (pre-edit snapshot vs. current content), and Claude is **held from resuming** for a configurable dwell time, with **transport controls**: resume/skip, freeze, and burst-skip.
4. A **tree view** groups all session changes by directory so I can glance where in the repo Claude is working.
5. **Every behavior gets a setting** so I can tune the workflow from within VS Code without code changes.

The system has two halves connected by localhost HTTP:

- **Claude Code side**: hooks configuration (PreToolUse/PostToolUse HTTP hooks on file-editing tools).
- **VS Code side**: a new extension (TypeScript) that receives hook events and drives all UI.

## 2. Architecture

```
Claude Code CLI (in VS Code terminal)
  │  PreToolUse / PostToolUse hooks (type: "http")
  ▼  POST http://127.0.0.1:<port>/event   (blocking: CC waits for response)
VS Code Extension ("claude-bridge")
  ├─ HttpBridge        — localhost server, auth token, request hold/release
  ├─ SessionStore      — event bus + state: touched files, edit counts, snapshots
  ├─ SnapshotProvider  — TextDocumentContentProvider, scheme `claude-snapshot:`
  ├─ DiffController    — opens vscode.diff, dwell/freeze/skip state machine
  ├─ ExplorerFollower  — revealInExplorer on edit events (default ON)
  ├─ DecorationProvider— FileDecorationProvider (badges/colors)
  ├─ ChangesTreeView   — TreeDataProvider grouped by directory
  ├─ StatusBarUi       — current file, hold state, resume/freeze affordances
  └─ FsWatcherFallback — FileSystemWatcher for edits made via Bash tool
```

Core principle: **one internal event bus**. `HttpBridge` and `FsWatcherFallback` emit normalized events (`editStarted`, `editCompleted`, `fileCreated`, `externalChange`); every UI component subscribes independently. Components must be individually toggleable via settings without affecting the others.

## 3. Repository Layout (deliverables)

```
claude-bridge/
├─ package.json               # manifest: contributes.{configuration,commands,views,menus,colors,keybindings}
├─ src/
│  ├─ extension.ts            # activate(): wire everything, register disposables
│  ├─ bridge/httpBridge.ts
│  ├─ bridge/fsWatcher.ts
│  ├─ core/sessionStore.ts
│  ├─ core/config.ts          # typed accessor for all settings, onDidChangeConfiguration
│  ├─ diff/snapshotProvider.ts
│  ├─ diff/diffController.ts  # hold state machine: dwelling → frozen → released
│  ├─ ui/explorerFollower.ts
│  ├─ ui/decorations.ts
│  ├─ ui/changesTree.ts
│  └─ ui/statusBar.ts
├─ claude-hooks/
│  ├─ settings-snippet.json   # ready-to-merge hooks block for .claude/settings.json
│  └─ README.md               # how to install the hooks, incl. timeout guidance
└─ README.md                  # install (vsix sideload), usage, all settings explained
```

Also provide packaging: build with esbuild or tsc, `npx @vscode/vsce package` producing a `.vsix`. No marketplace publishing needed.

## 4. Claude Code Hook Configuration (claude-hooks/settings-snippet.json)

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:38217/event",
            "headers": { "X-Claude-Bridge-Token": "$CLAUDE_BRIDGE_TOKEN" },
            "allowedEnvVars": ["CLAUDE_BRIDGE_TOKEN"],
            "timeout": 600
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:38217/event",
            "headers": { "X-Claude-Bridge-Token": "$CLAUDE_BRIDGE_TOKEN" },
            "allowedEnvVars": ["CLAUDE_BRIDGE_TOKEN"],
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

Notes for the implementer:
- Verify the exact HTTP hook config schema against current Claude Code docs (https://code.claude.com/docs/en/hooks) at implementation time; field names have evolved across versions. If env interpolation in headers proves unsupported in the installed CLI version, fall back to a token embedded in the URL path, generated per machine.
- The **PostToolUse hook is the blocking hold point**. Its `timeout` bounds the maximum freeze duration — document this in claude-hooks/README.md.
- The PreToolUse hook must be answered **immediately** (it exists only to trigger snapshot + reveal); never apply dwell logic to it.
- Do NOT add hooks on other tools (Bash, Read, etc.) in v1.

## 5. VS Code Extension — Component Specs

### 5.1 HttpBridge
- HTTP server bound to `127.0.0.1` only. Default port `38217`, setting-overridable. If the port is busy, increment up to +10 and surface the actual port (status bar tooltip + output channel); write the active port to a well-known file (`<globalStorageUri>/port`) so hook setup docs can reference it.
- Auth: on first activation generate a random token, store in `context.secrets` (SecretStorage) AND write to `<globalStorageUri>/token` with a documented path, plus a command `claudeBridge.copyTokenExport` that copies `export CLAUDE_BRIDGE_TOKEN=...` to the clipboard. Reject requests with missing/wrong token (401). Handle requests without assuming order (Pre and Post for different files may interleave when subagents run in parallel — key held responses by a request id, not a single global).
- Parse hook JSON: `hook_event_name`, `tool_name`, `tool_input.file_path`, `tool_input.content` / `old_string` / `new_string`, `session_id`. Tolerate unknown fields and missing optional fields.
- PreToolUse handling: emit `editStarted`, respond `200 {}` immediately.
- PostToolUse handling: emit `editCompleted`, then delegate the *response completion* to DiffController (this is the hold). Response body on release: `{}` (empty JSON, no decision fields).
- Robustness: if the extension is reloading or errors, hooks fail open on the CC side; also add a top-level try/catch that always responds within 100ms on internal error, logging to the output channel. Never let a bug in UI code wedge the response.

### 5.2 SessionStore
- Tracks per-file: state (`active | lingering | touched`), edit count, timestamps, snapshot ref, created-by-Claude flag.
- Snapshots: on `editStarted`, read current file bytes (`workspace.fs.readFile`) into an in-memory map (path → array of {timestamp, content}); file may not exist (Write creating a new file) → record `null` snapshot, mark as "created".
- Two diff baselines, per setting: `lastEdit` (snapshot taken at this edit's PreToolUse) and `sessionStart` (first snapshot ever taken for this file this session).
- Memory guard: cap total snapshot bytes (setting, default 200 MB); on overflow, spill oldest to `<globalStorageUri>/snapshots/` on disk transparently. Skip snapshotting files larger than a size setting (default 5 MB) and binary files (heuristic: NUL byte in first 8 KB) — for those, diff falls back to disabled with a tree-item note.
- `resetSession` command clears everything.

### 5.3 SnapshotProvider
- `TextDocumentContentProvider` for scheme `claude-snapshot:`; URI encodes file path + snapshot timestamp + baseline kind. Serves content from SessionStore.

### 5.4 DiffController (the heart)
- On `editCompleted` (when diff opening is enabled and the file passes filters): open `vscode.diff(snapshotUri, fileUri, "✻ <relpath> (Claude)")` with `preview: true, preserveFocus: true` (settings for both), then enter the hold state machine:
  - **dwelling**: timer = `dwellMs`. On expiry → release.
  - **frozen**: entered via freeze command; timer cancelled; auto-release safety margin: release at `hookTimeoutSafetyMs` before the configured hook timeout, with a status bar countdown in the final 30s.
  - **released**: respond to the pending HTTP request.
- `dwellMs` semantics: `0` = never hold (open diff, respond immediately); `> 0` = hold that long; `-1` = always hold until manual resume (still subject to timeout safety release).
- Conditional dwell filters (all settings, all combinable): only first edit per file; only if changed lines ≥ N; only when window focused (`vscode.window.state.focused`); include/exclude globs.
- **Burst skip**: `skipBurst` command releases current hold and suppresses further holds until `burstQuietMs` (default 4000) with no edit events, or an edit targets a different file (setting: `burstScope: "file" | "time"`).
- Tab hygiene: track diff tabs we opened (via `window.tabGroups`); setting `maxOpenDiffs` (default 3) — closing oldest bridge-owned diff tabs beyond the cap; `closeDiffsOnRelease` option. Never touch tabs we didn't open.
- Context keys via `setContext`: `claudeBridge.holding`, `claudeBridge.frozen` (drive keybinding when-clauses and status bar states).

### 5.5 ExplorerFollower — DEFAULT ON
- On `editStarted` (file exists) or `editCompleted` (file was just created): `vscode.commands.executeCommand('revealInExplorer', uri)`.
- Debounce: at most one reveal per `revealDebounceMs` (default 500).
- Anti-fight heuristic: skip reveal if the user interacted with the Explorer/editor within the last `userActivityGraceMs` (default 2000) — approximate user activity via `window.onDidChangeActiveTextEditor`, `onDidChangeTextEditorSelection` for non-bridge editors, and tree view selection events; document this as best-effort.
- Toggle command `claudeBridge.toggleFollow` + status bar segment `✻ Follow: on/off`. Setting `follow.enabled` default **true**.
- Note: `revealInExplorer` changes Explorer selection/focus context; ensure it does not steal keyboard focus from the terminal (use it as-is; if focus-stealing is observed, investigate `list.automaticKeyboardNavigation` interplay and document findings).

### 5.6 DecorationProvider
- `FileDecorationProvider` registered globally.
- States: `active` → badge `✻`, color `claudeBridge.activeEditColor`; `lingering` (post-edit, `lingerMs` default 2500) → same badge, dimmer color; `touched` → badge = min(editCount, 9), color `claudeBridge.touchedColor`.
- `contributes.colors`: define `claudeBridge.activeEditColor` (default e.g. `#E06C75`-ish, theme-aware defaults for light/dark/HC) and `claudeBridge.touchedColor` (muted).
- `propagate: true` so parent folders show activity (setting to disable).
- Clear on `resetSession`.

### 5.7 ChangesTreeView
- View container in Activity Bar (`✻` icon) with one view "Claude Session Changes".
- Grouping modes (setting + view toolbar toggle): by directory tree (default) / flat by recency.
- Item: filename, description = `+a −d · n edits · mm:ss ago`, tooltip with absolute path and per-edit timestamps. Compute +/− from snapshot vs current (line-based diff; a tiny LCS or the `diff` npm package).
- Click → open the diff for that file (baseline per current setting). Context menu: "Open file", "Diff vs session start", "Diff vs last edit", "Clear entry".
- Title bar buttons: reset session, toggle follow, open settings quick-pick.
- Badge on the view (`TreeView.badge`) = count of files touched.

### 5.8 StatusBarUi
- One primary item, states:
  - idle: `✻ Claude Bridge` (tooltip: port, hook status, last event time)
  - active edit: `✻ editing <filename>`
  - dwelling: `⏭ Skip (⏎) · ⏸ Freeze (space) · <countdown>s`
  - frozen: `⏸ Frozen — ▶ Resume (⏎)` (+ countdown when near hook timeout)
- Click behavior per state (resume when holding; quick-pick otherwise).
- Quick-pick (`claudeBridge.quickSettings`): dwell presets (0 / 1.5s / 3s / hold), follow on/off, diff open on/off, baseline toggle — writes to workspace settings.

### 5.9 FsWatcherFallback
- `createFileSystemWatcher('**/*')` filtered by excludes (`files.exclude` + setting `watcher.exclude`, default node_modules, .git, dist, build).
- Changes NOT correlated with a recent hook event (within 1500ms) while a Claude session is presumed active (any hook event in last `sessionActiveWindowMs`, default 10 min) → emit `externalChange`: mark file as touched with a distinct badge `◦` / tooltip "changed outside Edit tools (Bash?)". No snapshot/no diff/no hold for these (can't have a pre-image). Setting `watcher.enabled` default true.

## 6. Commands & Keybindings

| Command ID | Title | Default key | When |
|---|---|---|---|
| `claudeBridge.resume` | Resume Claude | `enter` | `claudeBridge.holding && !inputFocus` |
| `claudeBridge.skip` | Skip to next edit | `enter` (alias) / `ctrl+alt+enter` global | same |
| `claudeBridge.skipBurst` | Skip burst (run to next file/quiet) | `shift+enter` | same |
| `claudeBridge.freeze` | Freeze on this diff | `space` | `claudeBridge.holding && !claudeBridge.frozen && !inputFocus` |
| `claudeBridge.toggleFollow` | Toggle Explorer follow | — | — |
| `claudeBridge.resetSession` | Reset session state | — | — |
| `claudeBridge.quickSettings` | Quick settings | — | — |
| `claudeBridge.copyTokenExport` | Copy hook token export line | — | — |
| `claudeBridge.openLastDiff` | Reopen most recent diff | — | — |

`resume` and `skip` are functionally identical in v1 but MUST be separate command IDs (future divergence, separate keybindings/UI labels).

## 7. Settings (contributes.configuration) — all prefixed `claudeBridge.`

| Setting | Type | Default | Notes |
|---|---|---|---|
| `port` | number | 38217 | restart bridge on change |
| `follow.enabled` | boolean | **true** | Explorer reveal+select |
| `follow.debounceMs` | number | 500 | |
| `follow.userActivityGraceMs` | number | 2000 | |
| `diff.open` | enum: `always` \| `firstEditPerFile` \| `never` | `always` | |
| `diff.baseline` | enum: `lastEdit` \| `sessionStart` | `lastEdit` | |
| `diff.preserveFocus` | boolean | true | |
| `diff.maxOpenDiffs` | number | 3 | 0 = unlimited |
| `diff.closeOnRelease` | boolean | false | |
| `hold.dwellMs` | number | 0 | 0 off, -1 until manual |
| `hold.onlyFirstEditPerFile` | boolean | false | |
| `hold.minChangedLines` | number | 0 | |
| `hold.onlyWhenFocused` | boolean | true | |
| `hold.include` / `hold.exclude` | string[] globs | [] / lockfiles+generated | |
| `hold.burstQuietMs` | number | 4000 | |
| `hold.burstScope` | enum `file`\|`time` | `file` | |
| `hold.hookTimeoutSeconds` | number | 600 | must mirror hooks config; used for safety release |
| `hold.timeoutSafetyMs` | number | 5000 | release this early |
| `decorations.enabled` | boolean | true | |
| `decorations.lingerMs` | number | 2500 | |
| `decorations.propagateToFolders` | boolean | true | |
| `statusBar.enabled` | boolean | true | |
| `tree.grouping` | enum `directory`\|`recency` | `directory` | |
| `watcher.enabled` | boolean | true | |
| `watcher.exclude` | string[] | sensible defaults | |
| `snapshots.maxTotalMB` | number | 200 | |
| `snapshots.maxFileMB` | number | 5 | |

All settings hot-reload via `onDidChangeConfiguration` (except `port`, which restarts the server).

## 8. Implementation Order (phases; each ends runnable & testable)

1. **Skeleton + bridge**: scaffold extension, HttpBridge with token auth, output channel logging of raw events, status bar idle item. Test with `curl`.
2. **Snapshots + diff**: SessionStore, SnapshotProvider, open diff on PostToolUse (no hold). Test with real Claude Code session on a scratch repo.
3. **Explorer follow (default on) + decorations**: ExplorerFollower, DecorationProvider, toggle command.
4. **Hold state machine**: dwell/freeze/skip/burst, context keys, keybindings, status bar states, timeout safety.
5. **Tree view + quick settings + watcher fallback**.
6. **Polish & package**: settings hot-reload audit, tab hygiene, README + claude-hooks docs, vsix build, sanity pass in the Extension Development Host and as installed vsix.

## 9. Edge Cases & Constraints (must handle)

- **New file via Write**: no pre-image → snapshot `null`; diff = "created" (left side = empty virtual doc); reveal AFTER PostToolUse (file exists then).
- **MultiEdit**: one tool call, multiple edits to one file → single snapshot pair, single diff, single hold.
- **Parallel/subagent edits**: interleaved Pre/Post for different files → per-request hold tracking; if events include agent identifiers, surface as a suffix in tree item description; no assumption of strict pairing (a Pre without a matching Post within 60s → discard pending state, log it).
- **File outside workspace**: decorate/tree-list with absolute path; `revealInExplorer` will no-op — guard it.
- **Renames/deletes via Bash**: watcher marks; stale tree entries for deleted files get a strikethrough-style label (`(deleted)`).
- **Extension reload mid-hold**: pending HTTP responses die → CC hook errors/fails open. Acceptable; log prominently on next start.
- **Notebook files (.ipynb)**: snapshot raw JSON; diff will be noisy — v1: allowed but excluded by default via `hold.exclude`.
- **Multiple VS Code windows / multiple CC sessions**: port conflict handling covers it; token is shared per machine; session_id from events can partition state later — v1: single-session assumption, keyed by `session_id` if present so a second session at least doesn't corrupt state.
- **Security**: bind 127.0.0.1 only; constant-time token compare; no request bodies logged at info level (paths only); document that hook payloads contain file contents.

## 10. Acceptance Criteria (test manually with a real Claude Code run)

1. With defaults, starting a CC session (hooks installed) and asking Claude to edit 3 files: each file is revealed+selected in the Explorer as it's touched, gets a `✻` then a count badge, appears in the tree grouped by folder, and a native diff opens per edit. Claude is NOT held (dwellMs 0 default).
2. Set `hold.dwellMs: 3000` via quick-pick: next edit holds Claude ~3s with countdown; Enter resumes early; Space freezes indefinitely; Enter then resumes; Shift+Enter during a multi-edit burst suppresses holds until the next file.
3. Freeze past (hookTimeout − safety): auto-releases with visible countdown; Claude never proceeds due to CC-side timeout before our release under default configs.
4. `claudeBridge.follow.enabled: false` stops reveals; decorations and diffs unaffected (component independence).
5. A `sed -i` edit made by Claude via Bash shows the `◦` watcher badge and a tree entry, with no diff/hold.
6. Kill the extension host mid-hold: Claude Code recovers (fails open) within its hook timeout; no wedged session.
7. All settings changes (except port) take effect without reload.

## 11. Explicit Non-Goals for v1

No accept/reject of edits (view-only; rejection stays Claude Code's job), no marketplace publishing, no remote-dev (`extensionKind` note in README only), no webview UI, no persistence of session state across VS Code restarts.
