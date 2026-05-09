# Orbit Web -- remote-only design

## Background

`docs/architecture.md` flags an unresolved decision for the web shell: thin local shell vs. hosted multi-user service. This spec resolves it by carving out a third, smaller shape that subsumes both:

A **single-user, container-shaped, remote-only Loom shell** -- same brain, same renderer, env-var-injected credentials, no local execution surface. One image runs three deployments without code changes:

1. Standalone (`docker run` on a server, single user reaches it via URL)
2. Galaxy interactive tool (Galaxy spawns the container per user, injects scoped creds, proxies the user in)
3. Eventual hosted multi-tenant front (out of scope here; the IT shape gives most of what we'd want without a multi-tenant server)

The long-term framing is that this surface replaces ChatGXY as the actual analysis-driving interface for Galaxy users. v1 is the runtime shell; ChatGXY parity is a downstream concern.

## Non-goals (v1)

- Multi-user-in-one-container. One container per user. The IT pathway gives us per-user isolation for free.
- OIDC / Galaxy SSO. v1 is API-key, env-injected. The env-var contract is the seam where SSO eventually plugs in.
- Notebook persistence to a Galaxy History dataset. Notebook lives in the container's ephemeral cwd. The IT path will eventually map this into a Galaxy job working directory; out of scope here.
- Public hosted multi-tenant front, quotas, abuse controls, rate limiting.
- Galaxy-side IT wrapper code. v1 documents the env contract; the wrapper is a separate task that can land later without changing this image.

## Architecture

Same brain, same renderer, same shell contract. What changes:

- `web/server.ts` (the shell side) curates what the brain it spawns is allowed to do.
- The renderer learns it's in "remote mode" via a flag in the initial state response and hides local-only affordances.
- Config flows from env vars only -- no `~/.loom/config.json`, no `/connect` flow.
- The whole thing packages as a container image.

The brain stays shell-neutral per `CLAUDE.md`. Mode flag and tool restrictions are passed _into_ the brain at spawn time by the shell -- not encoded as a "web mode" branch inside `extensions/loom/`.

```text
Galaxy IT wrapper (or docker run) sets env vars
  ↓
Container starts: web/server.ts (Express + WS, tsx)
  ↓ spawns once at startup
bin/loom.js --mode rpc (brain subprocess; inherits env)
  ↓
Galaxy MCP + BRC-Analytics MCP + brain tools (HTTP only)
  ↓
notebook.md in /tmp/loom-session (ephemeral, container-local)

Browser ←(WS)→ web/server.ts ←(JSON-line stdio)→ brain subprocess
                  ↓ serves
            built renderer bundle (web/dist/, from app/src/renderer)
```

## Curation: what's disabled, what's kept

Two Pi mechanisms do the work:

- **Tool allowlist at spawn** -- `bin/loom.js` is launched with `--tools <list>`, the Pi CLI flag for restricting built-in, extension, and custom tools. Anything not in the list is unavailable to the agent. `web/server.ts` builds the list when `LOOM_MODE=remote`.
- **Runtime tool-call gating** -- a small dedicated Pi extension loaded only by the web shell hooks `on("tool_call")` and rejects calls that violate the path allowlist (the pattern Pi documents as `permission-gate.ts`). This is what enforces "`Edit`/`Write` only against `<cwd>/notebook.md`." Living under `web/` keeps the loom brain extension shell-neutral.

Renderer-side curation is just branches keyed off `mode === "remote"` in the initial state.

| Capability                                                    | Web mode                                               |
| ------------------------------------------------------------- | ------------------------------------------------------ |
| `Bash`                                                        | disabled                                               |
| `Edit` / `Write` / `Read` for arbitrary paths                 | disabled except an allowlist of `notebook.md` in cwd   |
| `executionMode: local`                                        | force `cloud`; override ignored                        |
| `/connect` flow                                               | bypassed; creds env-injected at startup                |
| `/run`, `/execute` slash commands                             | kept (prompt nudges; semantics already Galaxy-first)   |
| File tree pane                                                | hidden in renderer when `mode=remote`                  |
| `selectDirectory`, `browseDirectory`, `openFile` shim methods | stubbed/no-op in remote mode                           |
| Galaxy MCP                                                    | kept -- primary surface                                |
| BRC-Analytics MCP                                             | kept                                                   |
| `gtn_search`, `gtn_fetch`, `skills_fetch`                     | kept (HTTP-based)                                      |
| `galaxy_invocation_record`, `galaxy_invocation_check_*`       | kept                                                   |
| Notebook chokidar watcher + auto-commit                       | kept inside container; user never sees the git history |

### Notebook persistence under curation

The brain currently mutates `notebook.md` via the agent's general-purpose `Edit`/`Write` tools. Killing those wholesale would break notebook persistence. The chosen approach is **(a) path-allowlist constraint**: `Edit`/`Write` stay in the spawn allowlist, but a web-shell-only Pi extension hooks `on("tool_call")` and rejects any `Edit`/`Write` that resolves outside `<cwd>/notebook.md`. This keeps the loom brain extension shell-neutral, reuses existing notebook-writing plumbing, and gives a real security boundary even in v1. A dedicated `notebook_write` brain tool is the cleaner long-term answer but is deferred -- it would require brain refactoring beyond this design's scope.

## Mode signaling

- **Server → brain (at spawn):** `LOOM_MODE=remote` env var, the `--tools` allowlist, and the path-gate extension loaded via Pi's extension-loading mechanism. Brain code does not branch on `LOOM_MODE`; the env var is informational so the brain can include "you are operating remotely against a Galaxy instance, no local execution" in the system prompt context.
- **Server → renderer (at handshake):** the existing `getState()` IPC response gains a `mode: "remote" | "desktop"` field. Renderer reads this once at startup and uses it to suppress file-tree/local-only UI.
- **Renderer behavior:** when `mode === "remote"`:
  - File tree pane is not rendered
  - `selectDirectory` / `browseDirectory` UI is hidden
  - Preferences pane hides Galaxy connection fields (since creds are server-injected)
  - "Open file" affordances on artifacts are hidden

## Config flow

When `LOOM_MODE=remote`, `web/server.ts`:

- Reads `GALAXY_URL`, `GALAXY_API_KEY` from env and inherits them to the brain subprocess.
- Reads `LOOM_LLM_PROVIDER` (default `anthropic`) and optional `LOOM_LLM_MODEL`; passes them as `--provider`/`--model` to `bin/loom.js`.
- Inherits whichever provider key env var is set (`ANTHROPIC_API_KEY` / `XAI_API_KEY` / `AI_GATEWAY_API_KEY`) -- `bin/loom.js` already handles this mapping.
- Skips `loadConfig`/`saveConfig` for `~/.loom/config.json`. The `config:get` IPC channel returns a synthesized read-only config; `config:save` returns an error.
- Forces `executionMode: cloud` in the synthesized config regardless of any inherited override.
- Uses a per-container ephemeral cwd at `/tmp/loom-session/`, created on startup, cleaned on shutdown.

## Container

New `Dockerfile` at repo root.

- Base image: `node:22-slim` (matches existing tooling; revisit if root engines pin a different version).
- Build steps:
  - `npm ci` at root
  - `npm ci` in `app/` (renderer source)
  - `npm ci` in `web/`
  - `npm run build` in `web/` -- emits the renderer bundle to `web/dist/` (`vite build` configured to point at `app/src/renderer` with `orbit-shim.ts` injected, mirroring the dev-mode Vite middleware setup in `web/server.ts`).
- Runtime: `tsx web/server.ts`.
- Production branch in `web/server.ts`: when `NODE_ENV=production`, serve the static `web/dist/` bundle instead of spawning Vite middleware. WS bridge unchanged.
- Default `CMD ["npx", "tsx", "web/server.ts"]`.
- Image listens on `$PORT` (default 3000).
- One image, one user, one brain subprocess per container.

## Env contract

| Env var                                                          | Required                        | Notes                                                |
| ---------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------- |
| `GALAXY_URL`                                                     | yes                             | inherited to brain                                   |
| `GALAXY_API_KEY`                                                 | yes                             | inherited to brain                                   |
| `LOOM_MODE`                                                      | yes (`remote`)                  | triggers shell-side curation                         |
| `LOOM_LLM_PROVIDER`                                              | no                              | default `anthropic`; passed as `--provider` to brain |
| `LOOM_LLM_MODEL`                                                 | no                              | passed as `--model` to brain                         |
| `ANTHROPIC_API_KEY` _or_ `XAI_API_KEY` _or_ `AI_GATEWAY_API_KEY` | yes (one of, matching provider) | brain inherits as-is                                 |
| `PORT`                                                           | no                              | default 3000                                         |
| `NODE_ENV`                                                       | no                              | `production` triggers static-bundle serving          |

## Galaxy IT integration

v1 only documents the env contract above. The IT wrapper -- a Galaxy tool XML that launches the container with `GALAXY_URL` and a signed scoped API key from the IT context -- is a separate piece of work that can land independently without changing this image. The contract here is what that wrapper needs to honor.

## Validation

- **Smoke:** `docker run` with the env vars above, browser connects, agent responds, a Galaxy MCP tool round-trips end to end.
- **Curation:**
  - Agent attempts `Bash` → blocked by Pi tool gating.
  - Agent attempts `Edit` to `/etc/passwd` → blocked.
  - Agent attempts `Edit` to `<cwd>/notebook.md` → succeeds.
- **Renderer:** in remote mode, file-tree pane is not rendered; `getState()` returns `mode: "remote"`.
- **Existing checks:** root `npm test` and `cd app && npx tsc --noEmit` remain green.

## Decisions made (and why)

- **B (self-hostable companion) as the architectural target.** Aligns with Galaxy's federated/open ethos and turns "ChatGXY replacement" into a per-instance opt-in. The IT pathway falls out for free because the runtime shape is already container + env-injected creds + single-user.
- **Curation lives in the shell, not the brain.** Brain stays shell-neutral per the repo guardrail. Mode flag and tool allowlist are passed in by `web/server.ts`.
- **Path-allowlist for Edit/Write rather than a new `notebook_write` tool.** Smallest change, real security boundary, defers the brain refactor.
- **`tsx` rather than compile-to-JS.** Iteration speed in v1 outweighs ~200ms cold-start cost. Trivial to switch later.
- **Provider env var pass-through rather than picking one.** `bin/loom.js` already maps provider to env var; container just inherits.

## Open questions (revisit before implementation)

None blocking. Plan-writing should pin down two implementation details:

- The exact Pi tool names to put in the `--tools` allowlist (verify against the running brain's tool registry; `Edit`, `Write`, `Read`, `Bash` are the conventional names but should be confirmed before writing the list).
- Where the path-gate Pi extension lives in the tree (`web/extensions/path-gate/` is the obvious home; confirm Pi's extension-loading API supports a path argument so the web shell can load it without modifying root `package.json`'s `pi.extensions`).

The notebook-persistence-to-Galaxy story and the IT wrapper itself are both deferred and called out as non-goals.
