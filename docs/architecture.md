# Loom Architecture

Engineer-facing architecture reference for Loom, Orbit, and future shells.

Related docs:

- Product/runtime overview: [`README.md`](../README.md)
- Repo conventions and development workflow: [`CLAUDE.md`](../CLAUDE.md)
- Day-to-day agent behavior rules: [`AGENTS.md`](../AGENTS.md)

## Purpose

Loom is an AI research harness for Galaxy bioinformatics built on Pi.dev.

The architecture is intentionally split into:

- a **brain** that owns Galaxy connection state, notebook persistence, Galaxy invocation tracking, system-prompt context, and shell-neutral behavior
- one or more **shells** that present that behavior to users over RPC

Today the primary shells are:

- `loom` -- terminal CLI ([`bin/loom.js`](../bin/loom.js))
- Orbit -- Electron desktop shell ([`app/`](../app/))

The key rule is that shells do not become alternate brains. They render and orchestrate the same Loom runtime.

## System overview

```text
User
  ↓
Shell (CLI / Orbit / future web)
  ↓ Pi RPC over JSON-line stdio
Loom brain (Pi extension in extensions/loom/)
  ↓
Galaxy MCP (galaxy-mcp via uvx) + Galaxy tools/workflows
  ↓
notebook.md + git history in the analysis directory
```

Core repository areas:

- [`extensions/loom/`](../extensions/loom/) -- brain runtime (Pi extension)
- [`bin/loom.js`](../bin/loom.js) -- CLI bootstrap
- [`app/`](../app/) -- Orbit Electron shell
- [`shared/`](../shared/) -- cross-boundary contracts (config, shell-contract, team-dispatch-contract)
- analysis directory -- `notebook.md`, `activity.jsonl`, git history

## Design principles

1. **One brain, many shells.** Loom owns Galaxy + notebook semantics. Shells stay thin.
2. **Galaxy-first execution.** Real bioinformatics jobs are expected to run in Galaxy. Local mode is an escape hatch.
3. **Markdown-as-state.** Plans, decisions, and results are markdown sections in `notebook.md`. There is no parallel typed plan/step/decision store. The only structured side-records are `loom-invocation` YAML blocks for in-flight Galaxy work.
4. **Durable research record.** The notebook is auto-tracked in git when Loom owns the repo (or the user opts in via `git config loom.managed true`).
5. **Shell-neutral contracts.** Brain output flows through typed widget/status/notify events in [`shared/loom-shell-contract.js`](../shared/loom-shell-contract.js).
6. **Session continuity by directory.** The analysis directory is the unit of continuity. Pi sessions and notebook state both key off the working directory.

## Brain modules

The Loom brain is loaded as a Pi extension from [`extensions/loom/`](../extensions/loom/). Notable modules:

- [`index.ts`](../extensions/loom/index.ts) -- entry wiring: registers tools, slash commands, lifecycle hooks, UI bridge, context injection.
- [`state.ts`](../extensions/loom/state.ts) -- session state. Connection flag, current Galaxy history id, notebook path, and a chokidar watcher that re-fires the UI bridge on every notebook write. Also runs the auto-commit hook when the repo has `loom.managed=true`.
- [`session-bootstrap.ts`](../extensions/loom/session-bootstrap.ts) -- session lifecycle: resets state on `session_start`, ensures `notebook.md` exists, drops a `session.jsonl` symlink to Pi's session file, snapshots the notebook on `session_before_compact` and `session_shutdown`, sends the startup greeting (Galaxy-aware).
- [`execution-commands.ts`](../extensions/loom/execution-commands.ts) -- `/execute` and `/run` slash commands; pure prompt nudges, no execution policy.
- [`tools.ts`](../extensions/loom/tools.ts) -- LLM-callable tools: `gtn_search`, `gtn_fetch`, `skills_fetch`, `galaxy_invocation_record`, `galaxy_invocation_check_all`, `galaxy_invocation_check_one`.
- [`teams/tool.ts`](../extensions/loom/teams/tool.ts) -- `team_dispatch` (gated by `LOOM_TEAM_DISPATCH=1`).
- [`session-index/tools.ts`](../extensions/loom/session-index/tools.ts) -- `chat_search`, `chat_session_context`, `chat_find_tool_calls` (gated by `LOOM_SESSION_INDEX=1`).
- [`activity.ts`](../extensions/loom/activity.ts) + [`activity-hooks.ts`](../extensions/loom/activity-hooks.ts) -- streams user prompts and tool calls into `<cwd>/activity.jsonl`. The file is git-ignored by Loom's auto-`.gitignore`; it's a per-session sidecar, not durable record.
- [`context.ts`](../extensions/loom/context.ts) -- assembles the system-prompt context (Galaxy posture, notebook digest, skill router).
- [`ui-bridge.ts`](../extensions/loom/ui-bridge.ts) -- forwards notebook changes from the chokidar watcher to the shell as `Notebook` widget payloads.
- [`profiles.ts`](../extensions/loom/profiles.ts) -- Galaxy server profile persistence; resolves plaintext vs encrypted API keys (encrypted-only profiles fail loud unless the shell has injected `GALAXY_API_KEY`).
- [`git.ts`](../extensions/loom/git.ts) -- bioinformatics-aware `.gitignore`, `loom.managed` repo marker, auto-commit on notebook change.
- [`notebook-writer.ts`](../extensions/loom/notebook-writer.ts) -- read/write helpers and `loom-invocation` YAML round-trip.

## Shell responsibilities

### CLI (`bin/loom.js`)

- boots Pi in RPC mode with `extensions/loom` loaded
- loads `~/.loom/config.json` via `shared/loom-config.js`
- registers (or strips) the Galaxy MCP server entry in `~/.pi/agent/mcp.json` based on credential availability
- forwards `GALAXY_URL` / `GALAXY_API_KEY` into the agent's environment

The CLI never owns analysis semantics. Slash commands behave the same as in Orbit; widget events collapse to text summaries in the terminal.

### Orbit (`app/`)

- starts and supervises the brain subprocess (`src/main/agent.ts`)
- bridges renderer ↔ brain via Electron IPC and `window.orbit` (preload typed bridge)
- renders the three-pane layout: file tree / chat / tabbed artifact pane (Notebook, Activity, File)
- owns shell-only state: window geometry, prompt history, preferences (`~/.orbit/`)
- decrypts Galaxy API keys via Electron `safeStorage` and injects `GALAXY_API_KEY` into the brain at spawn time (`buildSecretEnv` in `app/src/main/agent.ts`)
- watches `~/.loom/config.json` and re-encrypts plaintext keys the brain wrote during `/connect`

### Future web shell

Two materially different possibilities:

- **thin local shell** -- talks to a local Loom runtime over the same shell contract Orbit uses
- **hosted service** -- multi-user tenancy, remote session ownership, remote notebook storage, Galaxy account linking

These are not small variations of the same architecture. The choice has to be made before the web shell grows further.

## Shared contracts

Cross-boundary code lives in [`shared/`](../shared/):

- [`loom-config.js`](../shared/loom-config.js) -- canonical `~/.loom/config.json` load/save. Atomic write (`tmp` + `rename`), `0600` permissions, lazy-seeds `galaxy-skills` if no skill repos are configured. Skill-repo URLs are restricted to `github.com/galaxyproject/*` (see `ALLOWED_SKILLS_PREFIX`); the agent treats fetched SKILL.md content as authoritative, so an arbitrary repo would be a prompt-injection vector.
- [`loom-shell-contract.js`](../shared/loom-shell-contract.js) -- widget keys (`Notebook`, etc.) and payload encoders/decoders shared by brain and shells.
- [`team-dispatch-contract.js`](../shared/team-dispatch-contract.js) -- payload contract for the `team_dispatch` tool.

Shells must not reverse-engineer brain payloads from implementation details; if you need a new payload shape, add it to `shared/`.

## Data flows

### User message (Orbit)

```text
User types in Orbit
→ renderer calls window.orbit.prompt(...)
→ main forwards to AgentManager
→ AgentManager writes a JSON-RPC line to the brain's stdin
→ Pi + Loom process the turn
→ tools edit notebook.md (Edit/Write) or call galaxy-mcp
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
→ tools.ts appends a `loom-invocation` fenced YAML block to notebook.md
→ later: agent (or /run) calls galaxy_invocation_check_all
→ tool scans notebook for in-flight blocks, polls Galaxy, rewrites YAML in place
   (status: in_progress → completed | failed; deterministic, all-jobs-ok rules)
```

The notebook is the only authority. There is no external invocation store.

## Session lifecycle

`extensions/loom/session-bootstrap.ts` owns:

1. `session_start`:
   - reset state
   - drop / refresh the `session.jsonl` symlink to Pi's authoritative session file
   - `initSessionArtifacts(cwd)` -- ensures `notebook.md` exists; ensures git repo (creating it with `loom.managed=true` if absent); attaches the chokidar watcher
   - send a Galaxy-aware startup greeting (suppressed when `LOOM_FRESH_SESSION=1` or `--continue`)
2. `session_before_compact` and `session_shutdown`:
   - `pi.appendEntry("notebook_snapshot", …)` -- stash the notebook content in Pi's session log so a post-compact agent can re-orient by re-reading

Invariants:

- the notebook on disk wins; no compacted state can override it
- restored notebook content emits to the shell once UI context is available
- directory switch in Orbit starts a fresh agent session in the new cwd

## Config model

Three layers:

1. **Brain config** -- `~/.loom/config.json`. LLM provider/model/key, Galaxy profiles (`apiKey` / `apiKeyEncrypted`), skill repos, `executionMode` (`cloud` default, `local` opt-in), default cwd. Read/written via `shared/loom-config.js`.
2. **Shell-only state** -- Orbit uses `~/.orbit/` for window geometry and prompt history; CLI has no persistent shell state.
3. **Analysis-local state** -- the working directory. `notebook.md` (durable), `activity.jsonl` (per-session sidecar, gitignored), `session.jsonl` (symlink to Pi's session file), `.loom/env/` (per-analysis conda env, gitignored).

`ensureGitRepo(cwd)` returns `true` (and `commitFile` runs on every notebook write) only when Loom created the repo or the user manually set `git config loom.managed true`. Existing repos that don't opt in still get notebook updates -- just no auto-commits.

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
- reverse-engineer brain payloads (use `shared/loom-shell-contract.js`)
- write `~/.loom/config.json` outside the shared loader (Orbit's exception: re-encrypt plaintext keys after `/connect` writes them, via `fs.watch` in `app/src/main/main.ts`)

## Current constraints

- Local execution mode is an exception path, not a mature first-class runtime.
- Orbit is the richest shell; the CLI is intentionally thinner; the web shell is undecided.
- Notebook persistence is local-directory-based, which is correct for local shells but must be reconsidered for any hosted deployment.
- Skill repo allowlist is `galaxyproject/*` only -- third-party skill repos would need a more permissive `isAllowedSkillUrl` (and a story for prompt-injection risk).
