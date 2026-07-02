# Claude Code hooks for Claude Bridge

This folder contains the hooks block that connects the Claude Code CLI to the
Claude Bridge VS Code extension. Verified against Claude Code **2.1.198**
(HTTP hooks: `type: "http"` with `url` and `timeout` in **seconds**).

## Install

1. **Merge the hooks block** from `settings-snippet.json` into your Claude
   Code settings:
   - per project: `<repo>/.claude/settings.json` (or `settings.local.json`)
   - or globally: `~/.claude/settings.json`

   If you already have `PreToolUse`/`PostToolUse` entries, append the objects
   from the snippet to your existing arrays.

2. **Check the port.** The extension listens on `127.0.0.1:38217` by default
   (`claudeBridge.port`). If that port is busy it probes up to `+10` and shows
   the actual port in the status bar tooltip; it also writes it to
   `<globalStorage>/local.claude-bridge/port`. The `url` in your hooks config
   must match.

3. Restart the Claude Code session (hooks are read at startup; run `/hooks` to
   verify they are loaded).

## How it blocks (and why the timeout matters)

- The **PreToolUse** hook fires just before an Edit/Write; the extension takes
  a pre-edit snapshot and answers immediately. No dwell logic ever runs here.
- The **PostToolUse** hook is the **hold point**: Claude Code waits for the
  HTTP response before continuing. When you set `claudeBridge.hold.dwellMs`
  (or freeze a diff), the extension simply delays that response.
- The hook `timeout` (seconds) is therefore the **maximum possible freeze
  time**. The extension auto-releases every hold at
  `claudeBridge.hold.hookTimeoutSeconds − claudeBridge.hold.timeoutSafetyMs`
  so Claude Code never hits the timeout. If you change `timeout` in the hooks
  config, mirror it in `claudeBridge.hold.hookTimeoutSeconds`.

## Fail-open guarantees

Hook errors, non-2xx responses, timeouts, or the extension being down are all
**non-blocking** on the Claude Code side: the session continues normally, you
just lose visibility until the bridge is back.

## Scope

Hooks are configured only for `Edit|Write|MultiEdit|NotebookEdit`. Do not add
Bash/Read hooks for the bridge — file changes made via Bash (e.g. `sed -i`)
are picked up by the extension's filesystem watcher fallback instead (badge
`◦`, no diff/hold).

> Note: the bridge has **no authentication** — it trusts anything that can
> reach `127.0.0.1:38217` in the environment it runs in. This is intended for
> sandboxed/devcontainer setups where the container boundary is the security
> boundary. Hook payloads contain file contents; the extension logs paths,
> never bodies.
