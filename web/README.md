# Orbit Web

A local dev server that runs the Orbit renderer in your browser instead of
Electron. It serves the **same** renderer code (`app/src/renderer/`) through
Vite with hot module replacement, and bridges a browser WebSocket to the
**same** loom brain the desktop app and CLI use (`node bin/loom.js --mode rpc`).

The main reason to use it: **HMR**. Orbit's Electron renderer has HMR disabled
on purpose (see `app/vite.renderer.config.ts`), so the desktop dev loop means
restarting the app to see renderer changes. Here, edits under
`app/src/renderer/` hot-reload in the browser -- a much tighter loop for UI,
chat-rendering, styling, and agent-event work.

It is a single-user dev convenience, not the hosted/remote deployment story.
That separate shape (`LOOM_MODE=remote`, tool allowlists, path-gating, Docker)
lives in `docs/superpowers/specs/2026-05-09-orbit-web-remote-only-design.md`.

## Prerequisites

Same as the developer install in the root [`README.md`](../README.md):

- Node 20+ and `uv` on `PATH` (uv is needed by galaxy-mcp, same as the CLI).
- A configured `~/.loom/config.json` with at least an LLM API key. The web
  server reads the exact same config as Orbit and the CLI, so if either of
  those already works, you're set. Otherwise you can fill it in from the
  Preferences panel once the UI is up.
- Root deps installed (provides `bin/loom.js` and its runtime). The brain is
  committed JS -- no separate build step.

```bash
# from repo root, once
npm install
```

## Getting started

```bash
cd web
npm install        # first time only
npm run dev        # -> http://localhost:3000
```

Open http://localhost:3000. Override the port with `PORT`:

```bash
PORT=4000 npm run dev
```

The working directory defaults to `~/.loom/analyses` (override with
`defaultCwd` in `~/.loom/config.json`). The brain subprocess starts lazily on
the first browser connection, so the page loads before any agent spins up.

## How it works

```
Browser  ──(WebSocket /ws)──>  web/server.ts  ──(JSON-line stdio)──>  node bin/loom.js --mode rpc
   ^                                                                          |
   └──────────────────────  agent events / UI requests  ──────────────────────┘
```

- `web/server.ts` runs Vite in middleware mode and injects `web/orbit-shim.ts`
  ahead of the renderer's `app.ts`. The shim stands in for Electron's
  preload/`contextBridge`, exposing the same `window.orbit` API but routing
  calls over a WebSocket (`/ws`) instead of IPC.
- For each browser it spawns one `node bin/loom.js --mode rpc` subprocess --
  identical brain (`extensions/loom`), identical agent loop, identical Galaxy
  MCP path to Orbit and the CLI. Some control channels (config get/save,
  cwd get/set, restart, reset-session) are handled by the server directly;
  everything else forwards to the brain.

## What carries over from Orbit, and what doesn't

Because the renderer and brain are shared, most behavior is faithful. But the
browser shim (`web/orbit-shim.ts`) only implements a subset of the OrbitAPI, so
some flows are stubbed.

**Works the same as Orbit:**

- Renderer UI, layout, styling, markdown/chat rendering, with live HMR
- Prompting, abort, new/reset session, agent restart
- Config get/save and cwd selection (directory picker is prompt-based, no
  native dialog)
- Agent event streaming and extension UI requests
- The real LLM planning/execution and Galaxy MCP connectivity

**Stubbed / not bridged (will error or silently no-op):**

- File operations -- `readFile`/`writeFile`/`listFiles`/`onFilesChanged`, so the
  file tree and file viewer won't populate
- Notebook auto-load on startup
- OAuth sign-in, feedback submission, API-key validation, update checks, sysinfo

If something in the UI does nothing, **check whether the method exists in
`web/orbit-shim.ts` before assuming your change broke it** -- the gap is more
often the shim than your code.

## Notes

- HMR watches `app/src/renderer/` and `web/`. Changes to the brain
  (`extensions/loom/`) need a brain restart -- use the in-app restart, or
  restart the dev server.
- `web/package.json` also has a `build` script, but the static/production build
  and the remote-only server branch are part of the design spec above, not the
  local dev flow documented here.
