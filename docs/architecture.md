# Orbit Architecture

Engineer-facing architecture reference for the Orbit core and its shells, current and future.

Related docs:

- Product/runtime overview: [`README.md`](../README.md)
- Repo conventions and development workflow: [`CLAUDE.md`](../CLAUDE.md)
- Day-to-day agent behavior rules: [`AGENTS.md`](../AGENTS.md)

## Purpose

Orbit is an AI research harness for Galaxy bioinformatics built on Pi.dev.

The architecture is intentionally split into:

- a **brain** that owns Galaxy connection state, notebook persistence, Galaxy invocation tracking, system-prompt context, and shell-neutral behavior
- one or more **shells** that present that behavior to users over RPC

Today the primary shells are:

- `orbit` -- terminal CLI ([`bin/orbit.js`](../bin/orbit.js))
- Orbit desktop -- Electron desktop shell ([`app/`](../app/))
- the web shell -- the Orbit renderer over a WebSocket to a brain subprocess ([`web/`](../web/))
- the browser shell -- Orbit's chat UI with the agent in a browser worker, shipped as the Olit Galaxy visualization plugin ([`browser/`](../browser/))

The key rule is that shells do not become alternate brains. They render and orchestrate the same Orbit runtime. The browser shell is the one exception today: it still carries its own agent, which is being replaced by this brain (see [Browser shell](#browser-shell-browser)).

## System overview

```text
User
  ↓
Shell (CLI / Orbit / future web)
  ↓ Pi RPC over JSON-line stdio
Orbit core (Pi extension in extensions/orbit/)
  ↓
In-process Galaxy tools (galaxy-ops) + Galaxy tools/workflows
  ↓
notebook.md + git history in the analysis directory
```

Core repository areas:

- [`extensions/orbit/`](../extensions/orbit/) -- brain runtime (Pi extension)
- [`bin/orbit.js`](../bin/orbit.js) -- CLI bootstrap
- [`app/`](../app/) -- Orbit Electron shell
- [`web/`](../web/) -- web shell (Orbit renderer over a WebSocket)
- [`browser/`](../browser/) -- browser shell (agent in a worker; Olit)
- [`shared/`](../shared/) -- cross-boundary contracts (config, shell-contract, team-dispatch-contract, capability profile)
- analysis directory -- `notebook.md`, `activity.jsonl`, git history

## Design principles

1. **One brain, many shells.** Orbit owns Galaxy + notebook semantics. Shells stay thin.
2. **Galaxy-first execution.** Real bioinformatics jobs are expected to run in Galaxy. Local mode is an escape hatch.
3. **Markdown-as-state.** Plans, decisions, and results are markdown sections in `notebook.md`. There is no parallel typed plan/step/decision store. The only structured side-records are `orbit-invocation` YAML blocks for in-flight Galaxy work.
4. **Durable research record.** The notebook is auto-tracked in git when Orbit owns the repo (or the user opts in via `git config loom.managed true`).
5. **Shell-neutral contracts.** Brain output flows through typed widget/status/notify events in [`shared/orbit-shell-contract.js`](../shared/orbit-shell-contract.js).
6. **Session continuity by directory.** The analysis directory is the unit of continuity. Pi sessions and notebook state both key off the working directory.

## Brain modules

The Orbit core is loaded as a Pi extension from [`extensions/orbit/`](../extensions/orbit/). Notable modules:

- [`index.ts`](../extensions/orbit/index.ts) -- entry wiring: registers tools, slash commands, lifecycle hooks, UI bridge, context injection. Registers the exec-guard first so its decision is the authoritative boundary.
- [`exec-guard/`](../extensions/orbit/exec-guard/) -- the local-execution safety gate. Subscribes to Pi's `tool_call` event and returns `{ block }` for `bash`/`write`/`edit`/`read`. A pure `policy.ts` (`allow`/`ask`/`deny`) consumes four classifiers (`model-tier`, `sensitive-read`, `bash-risk`, realpath `path-jail`); `gate.ts` performs the `ask` via `ctx.ui` (fails closed when `ctx.hasUI` is false) and audits every decision to `activity.jsonl`. Shell-neutral: all policy lives in the brain, prompts render through the `ctx.ui` abstraction. A human-only `dangerouslyBypassPermissions` mode (config / `--dangerously-bypass-permissions` / Orbit toggle) turns it into a pass-through. See [README "Local execution safety"](../README.md#local-execution-safety). Writes via the `write`/`edit` tools are confined to the analysis directory by default (out-of-dir or credential-shaped paths prompt); this is on by default, every platform.
- [`sandbox/`](../extensions/orbit/sandbox/) -- the opt-in OS bash sandbox, layered UNDER the exec-guard. When enabled (`--sandbox` / `ORBIT_SANDBOX` / `guardian.sandbox`, macOS + Linux/WSL2) it wraps `bash` via `@anthropic-ai/sandbox-runtime` so an allowed command's writes are confined to the workspace and its network is limited. Off by default because enabling it necessarily restricts bash network (ASRT can't confine writes alone). The gate still decides `allow`/`ask`/`deny`; the sandbox only changes how an already-allowed command runs. The default-on confinement of the model's `write`/`edit` file writes (above) lives in the gate itself, independent of this sandbox.
- [`state.ts`](../extensions/orbit/state.ts) -- session state. Connection flag, current Galaxy history id, notebook path, and a chokidar watcher that re-fires the UI bridge on every notebook write. Also runs the auto-commit hook when the repo has `loom.managed=true`.
- [`session-lifecycle.ts`](../extensions/orbit/session-lifecycle.ts) -- session lifecycle: resets state on `session_start`, ensures `notebook.md` exists, drops a `session.jsonl` symlink to Pi's session file, snapshots the notebook on `session_before_compact` and `session_shutdown`, writes a `orbit-session` summary block on shutdown, sends the startup greeting (Galaxy-aware).
- [`execution-commands.ts`](../extensions/orbit/execution-commands.ts) -- `/execute` and `/run` slash commands; pure prompt nudges, no execution policy.
- [`tools.ts`](../extensions/orbit/tools.ts) -- LLM-callable tools: `gtn_search`, `gtn_fetch`, `skills_fetch`, `galaxy_invocation_record`, `galaxy_invocation_check_all`, `galaxy_invocation_check_one`.
- [`skills-discovery.ts`](../extensions/orbit/skills-discovery.ts) -- the skill catalog: frontmatter parsing, `surfaces: [loom]` tag-or-all selection, the GitHub tree-walk and its 1h cache. `resolveCatalogEntries` prefers the bundled catalog and falls back to the cached walk; background refresh runs for live repos only.
- [`vendor-skills.ts`](../extensions/orbit/vendor-skills.ts) + [`vendor/skills/`](../extensions/orbit/vendor/skills/) -- skill content that ships inside the package, vendored from `galaxyproject/agentic-plugins` at the commit pinned in [`scripts/skills.manifest.json`](../scripts/skills.manifest.json) by [`scripts/sync-skills.mjs`](../scripts/sync-skills.mjs). Two plugins: the galaxy-skills mirror, which backs the `galaxy-skills` repo and generates `_catalog.json` for the router, and the Foundry casts, which are reachable only through `skills_fetch({ repo: "foundry" })` and never enter the router. A third, local plugin vendors Orbit's staging skills from [`skills/`](../skills/) into the same tree under the reserved `orbit` repo, routed like galaxy-skills. It is a waiting room, not a home: each skill names its destination in `metadata.proposed_home` (the sync refuses one that doesn't) and moves there keeping its path. `npm run check:skills` is the offline drift gate; `shared/skills-pin.js` carries the pin to the shells.
- [`skill-triggers.ts`](../extensions/orbit/skill-triggers.ts) -- the table of tool-result hints: each row watches some tools and appends a short note (usually a `skills_fetch` pointer to bundled reference material) when a result shows a situation worth handling a particular way. This is how skills outside the router reach the model. Every hint that fires is logged as a `skill.hint` activity event. Rows today: the tool-name confusables stopgap, the failed-invocation triage hint (text and detector in [`invocation-failure-hint.ts`](../extensions/orbit/invocation-failure-hint.ts)), and `iwc-candidates`, which reminds the model that IWC recommend/search rankings need their inputs checked before a workflow is offered.
- [`iwc-plan-check.ts`](../extensions/orbit/iwc-plan-check.ts) -- enforces IWC-first for plan drafts: when a turn ends with a drafted plan, Galaxy is connected, and nothing in the session has consulted IWC, it queues one follow-up (through the auto-resume delivery, so Stop and the turn cap apply) asking the model to check the registry and revise. Once per session; logged as `plan.iwc_check`. Print/json runs exit before follow-ups are delivered, so evals only see the prompt-only rate.
- [`teams/tool.ts`](../extensions/orbit/teams/tool.ts) -- `team_dispatch` (gated by `ORBIT_TEAM_DISPATCH=1`).
- [`session-index/tools.ts`](../extensions/orbit/session-index/tools.ts) -- `chat_search`, `chat_session_context`, `chat_find_tool_calls` (gated by `ORBIT_SESSION_INDEX=1`).
- [`activity.ts`](../extensions/orbit/activity.ts) + [`activity-hooks.ts`](../extensions/orbit/activity-hooks.ts) -- streams user prompts and tool calls into `<cwd>/activity.jsonl`. The file is git-ignored by Orbit's auto-`.gitignore`; it's a per-session sidecar, not durable record, and no gate's verdict reads it (the shell can't write it on the desktop; the file tools can).
- [`context.ts`](../extensions/orbit/context.ts) -- assembles the system-prompt context (Galaxy posture, notebook digest, skill router).
- [`ui-bridge.ts`](../extensions/orbit/ui-bridge.ts) -- forwards notebook changes from the chokidar watcher to the shell as `Notebook` widget payloads.
- [`profiles.ts`](../extensions/orbit/profiles.ts) -- Galaxy server profile persistence; resolves plaintext vs encrypted API keys (encrypted-only profiles fail loud unless the shell has injected `GALAXY_API_KEY`).
- [`git.ts`](../extensions/orbit/git.ts) -- bioinformatics-aware `.gitignore`, `loom.managed` repo marker, auto-commit on notebook change.
- [`notebook-writer.ts`](../extensions/orbit/notebook-writer.ts) -- read/write helpers and `orbit-invocation` YAML round-trip.

## Shell responsibilities

### CLI (`bin/orbit.js`)

- boots Pi in RPC mode with `extensions/orbit` loaded
- loads `~/.orbit/config.json` via `shared/orbit-config.js`
- clears the Galaxy/BRC entries older versions left in `~/.pi/agent/mcp.json` (the brain now registers brc-analytics with pi itself and runs the Galaxy tools in-process), saving the old file as `mcp.json.loom-backup` first; a `galaxy` or `brc-analytics` entry the user wrote for pi's built-in MCP is left alone and reported, since a file entry wins over the registration
- forwards `GALAXY_URL` / `GALAXY_API_KEY` into the agent's environment

The CLI never owns analysis semantics. Slash commands behave the same as in Orbit; widget events collapse to text summaries in the terminal.

### Orbit (`app/`)

- starts and supervises the brain subprocess (`src/main/agent.ts`)
- bridges renderer ↔ brain via Electron IPC and `window.orbit` (preload typed bridge)
- renders the three-pane layout: file tree / chat / tabbed artifact pane (Notebook, Activity, File)
- owns shell-only state: window geometry, prompt history, preferences (`~/.orbit/`)
- decrypts Galaxy API keys via Electron `safeStorage` and injects `GALAXY_API_KEY` into the brain at spawn time (`buildSecretEnv` in `app/src/main/agent.ts`)
- watches `~/.orbit/config.json` and re-encrypts plaintext keys the brain wrote during `/connect`
- on Windows, ships **remote-only**: a plain Windows box has no bash, so the brain is spawned with `--exclude-tools bash` (the model never sees a shell) and flagged `ORBIT_LOCAL_SHELL=off` (`isLocalShellAvailable` in `src/main/local-shell.ts`). Unlike the web Remote mode below, `ORBIT_LOCAL_EXEC` stays `on` -- the exec-guard write-jail remains the file authority, so workspace file read/write still works; only the shell is gone. The init-gate rejects `[local]`/`[hybrid]` plans and the renderer hides local-exec-only controls via `body.remote-desktop`. See the [Windows remote-only design](superpowers/specs/2026-06-04-orbit-windows-remote-only-design.md).

### Web shell (`web/`)

The web shell shares the Orbit renderer over a WebSocket bridge to a brain subprocess (`web/server.ts`). Two run modes:

- **Desktop-equivalent** (default) -- single user on localhost, reads `~/.orbit/config.json`, behaves like Orbit minus Electron.
- **Remote** (`ORBIT_MODE=remote`) -- env-injected credentials, ephemeral `/tmp/orbit-session/` cwd, brain spawned with the `web/extensions/web-mode-gate` Pi extension that blocks `bash` and confines `edit`/`write`/`read` to `notebook.md`. No `~/.orbit/config.json`, no `/connect` flow, no local-filesystem UI. Same image runs as `docker run`, behind a reverse proxy, or as a Galaxy interactive tool. See [`web/REMOTE.md`](../web/REMOTE.md) for the env contract.

The hosted multi-user shape is deferred -- the IT pathway gives per-user isolation for free without a multi-tenant server.

### Browser shell (`browser/`)

The browser shell runs with no server process of its own. Orbit's chat UI (imported from `app/src/renderer`, not copied) mounts in the page, the agent runs in a worker, and conversations persist in the browser's private storage. It ships as `@galaxyproject/olit`, a Galaxy visualization plugin; [`browser/LAYOUT.md`](../browser/LAYOUT.md) maps the packages.

It is mid-migration, so it does not yet follow the one-brain rule:

- **Today** the worker runs its own agent in `browser/core/src/agent/` on pi-durable (`Runtime.open`), with its own prompt, tools and guards, and its own galaxy-ops-backed Galaxy tools. Those brain modules are an interim copy, slated for deletion; the worker, `pi-host.ts`, storage and the other shell support in that directory stay.
- **The target** is the worker booting this brain (`extensions/orbit/`) through `browser/core/src/agent/pi-host.ts`, pi-coding-agent's `ExtensionAPI` reproduced over pi-durable, with browser-only behavior layered on top of Orbit's rather than in place of it.
- **What is in place, on the brain side:** the brain asks the capability profile ([`shared/capability-profile.js`](../shared/capability-profile.js)) what the shell can do -- a local shell, a local file surface, where the notebook lives, direct network, pi's MCP layer, which UI answers prompts -- instead of reading shell-specific env vars. The Node shells derive it from env; a shell with no env installs one with `setCapabilityProfile`. The brain's Galaxy tools come from one in-process source over galaxy-ops ([`galaxy-tool-source.ts`](../extensions/orbit/galaxy-tool-source.ts)), the shared source for the galaxy-ops operation tools in the CLI, Orbit and the web shell; Galaxy MCP is no longer launched. Notebook records and provenance go through seams ([`record-store-seam.ts`](../extensions/orbit/record-store-seam.ts), [`provenance-fs.ts`](../extensions/orbit/provenance-fs.ts)) so a shell without a filesystem can supply its own.
- **What is proven, under Node only:** `browser/core/src/agent/pi-host.orbit.test.ts` boots the brain on pi-host with a worker-shaped profile (no shell, no local files, the notebook on a Page, `ui: "worker"`) and pins the Node reaches it observes and the import edges it scans for in `pi-host.orbit.golden.json`; `tests/galaxy-output.test.ts` keeps the hot-path modules free of Node imports.
- **Not done yet:** nothing in the production worker installs the profile or boots the brain; it still runs its own agent and tools. Booting the brain in the worker, then deleting the duplicated brain modules, are the remaining steps.

Until then, new brain behavior goes in `extensions/orbit/` and `shared/`, not in the browser's copy (see [`CLAUDE.md`](../CLAUDE.md)).

## Shared contracts

Cross-boundary code lives in [`shared/`](../shared/):

- [`orbit-config.js`](../shared/orbit-config.js) -- canonical `~/.orbit/config.json` load/save. Atomic write (`tmp` + `rename`), `0600` permissions, lazy-seeds `galaxy-skills` if no skill repos are configured. `isBundledSkillRepo` decides whether a configured repo reads from the package or is fetched, and both the brain and Preferences use it so they cannot disagree. Skill-repo URLs are restricted to `github.com/galaxyproject/*` (see `ALLOWED_SKILLS_PREFIX`); the agent treats fetched SKILL.md content as authoritative, so an arbitrary repo would be a prompt-injection vector.
- [`orbit-shell-contract.js`](../shared/orbit-shell-contract.js) -- widget keys (`Notebook`, etc.) and payload encoders/decoders shared by brain and shells.
- [`team-dispatch-contract.js`](../shared/team-dispatch-contract.js) -- payload contract for the `team_dispatch` tool.

Shells must not reverse-engineer brain payloads from implementation details; if you need a new payload shape, add it to `shared/`.

## Data flows

### User message (Orbit)

```text
User types in Orbit
→ renderer calls window.orbit.prompt(...)
→ main forwards to AgentManager
→ AgentManager writes a JSON-RPC line to the brain's stdin
→ Pi + Orbit process the turn
→ tools edit notebook.md (Edit/Write) or call the in-process Galaxy tools
→ chokidar fires on notebook write
→ ui-bridge encodes a Notebook widget payload
→ main forwards events to renderer
→ Orbit updates chat + Notebook tab
```

### Notebook persistence

```text
Edit/Write tool rewrites notebook.md
→ chokidar "change" event in state.ts
→ notifyNotebookChange(content) → ui-bridge
→ if loom.managed: commitFile(notebookPath, "Notebook updated")
```

There is no separate plan/state mutation path -- the markdown file _is_ the state.

### Galaxy invocation tracking

```text
agent calls galaxy_invocation_record({ invocationId, notebookAnchor, label })
→ tools.ts appends a `orbit-invocation` fenced YAML block to notebook.md
→ later: agent (or /run) calls galaxy_invocation_check_all
→ tool scans notebook for in-flight blocks, polls Galaxy, rewrites YAML in place
   (status: in_progress → completed | failed; deterministic, all-jobs-ok rules)
```

The notebook is the durable, human-readable record and the only file the agent edits.
Approvals, run identity and evaluations live in a harness-owned registry under
`.loom/state/` ([`docs/registry.md`](registry.md)), signed by the session that wrote it,
rendered into the notebook's typed blocks, and reconciled against Galaxy on every session
start and Page pull. Gated submissions will be made by the harness from the approved
specification through `loom_submit` (not built yet; today the model submits with the
ordinary tools and capture records it). The registry is authoritative for whether an
attempt is eligible to hand off -- the evidence gate reads `handoff_eligible` from it for any
step whose run it knows about; the notebook is authoritative for what the analysis says;
Galaxy is authoritative for what ran. Anything not signed by the current session is
historical until re-verified, and approvals never survive a session. The registry travels
inside the Galaxy Page as a carrier line, and on the desktop it sits beside the notebook
under an exec-guard floor the model can't write through.

## Session lifecycle

`extensions/orbit/session-lifecycle.ts` owns:

1. `session_start`:
   - reset state
   - drop / refresh the `session.jsonl` symlink to Pi's authoritative session file
   - `initSessionArtifacts(cwd)` -- ensures `notebook.md` exists; ensures git repo (creating it with `loom.managed=true` if absent); attaches the chokidar watcher
   - send a Galaxy-aware startup greeting (suppressed when `ORBIT_FRESH_SESSION=1` or `--continue`)
2. `session_before_compact` and `session_shutdown`:
   - `pi.appendEntry("notebook_snapshot", …)` -- stash the notebook content in Pi's session log so a post-compact agent can re-orient by re-reading

Invariants:

- the notebook on disk wins; no compacted state can override it
- restored notebook content emits to the shell once UI context is available
- directory switch in Orbit starts a fresh agent session in the new cwd

## Config model

Three layers:

1. **Brain config** -- `~/.orbit/config.json`. LLM provider/model/key, Galaxy profiles (`apiKey` / `apiKeyEncrypted`), skill repos, `executionMode` (`cloud` default, `local` opt-in), default cwd. Read/written via `shared/orbit-config.js`.
2. **Shell-only state** -- Orbit uses `~/.orbit/` for window geometry and prompt history; CLI has no persistent shell state.
3. **Analysis-local state** -- the working directory. `notebook.md` (durable), `activity.jsonl` (per-session sidecar, gitignored), `session.jsonl` (symlink to Pi's session file), `.loom/env/` (per-analysis conda env, gitignored).

`ensureGitRepo(cwd)` returns `true` (and `commitFile` runs on every notebook write) only when Orbit created the repo or the user manually set `git config loom.managed true`. Existing repos that don't opt in still get notebook updates -- just no auto-commits.

## Brain ↔ shell boundary

The brain may:

- emit widgets, statuses, notifications
- request user input / selection / confirmation
- write to `notebook.md` and `activity.jsonl` in the cwd

The shell may:

- display those events
- forward user text and slash commands
- manage shell-local affordances and state
- inject env vars (e.g. `GALAXY_API_KEY` from safeStorage) at brain spawn time

The shell must not:

- own plan / execution policy for the analysis flow
- reverse-engineer brain payloads (use `shared/orbit-shell-contract.js`)
- write `~/.orbit/config.json` outside the shared loader (Orbit's exception: re-encrypt plaintext keys after `/connect` writes them, via `fs.watch` in `app/src/main/main.ts`)

## Current constraints

- Local execution mode is an exception path, not a mature first-class runtime.
- Native Windows Orbit is remote-only (no local bash shell); local execution on Windows still needs WSL2 until a WSL/container local power-mode backend lands behind the `isLocalShellAvailable` seam.
- Orbit is the richest shell; the CLI is intentionally thinner; the web shell's hosted multi-user mode is deferred.
- The browser shell still runs its own agent (`browser/core/src/agent/`) until the worker boots this brain; see [Browser shell](#browser-shell-browser).
- Notebook persistence is local-directory-based, which is correct for local shells but must be reconsidered for any hosted deployment.
- Skill repo allowlist is `galaxyproject/*` only -- third-party skill repos would need a more permissive `isAllowedSkillUrl` (and a story for prompt-injection risk).
