# Loom Architecture

Engineer-facing architecture reference for Loom, Orbit, and future shells.

Related docs:

- Product/runtime overview: [`README.md`](../README.md)
- Repo conventions and development workflow: [`CLAUDE.md`](../CLAUDE.md)

## Purpose

Loom is an AI research harness for Galaxy bioinformatics built on Pi.dev.

The architecture is intentionally split into:

- a **brain** that owns analysis state, lifecycle rules, notebook persistence, Galaxy policy, and shell-neutral behavior
- one or more **shells** that present that behavior to users over RPC

Today the primary shells are:

- `loom` — terminal CLI
- Orbit — Electron desktop shell in [`app/`](../app/)

Future shells may include:

- a lightweight local web UI
- a hosted multi-user service with auth and Galaxy account linkage

The key rule is that shells do not become alternate brains. They render and orchestrate the same Loom runtime.

## System Overview

```text
User
  ↓
Shell (CLI / Orbit / future web)
  ↓ RPC / IPC
Loom brain (Pi extension in extensions/loom/)
  ↓
Galaxy MCP + Galaxy tools/workflows
  ↓
Notebook + git history in analysis directory
```

Core repository areas:

- [`extensions/loom/`](../extensions/loom/) — brain runtime
- [`bin/loom.js`](../bin/loom.js) — CLI bootstrap and Pi entrypoint
- [`app/`](../app/) — Orbit Electron shell
- [`shared/`](../shared/) — cross-boundary contracts and shared utilities
- analysis directory — notebook markdown, git history, outputs

## Design Principles

1. **One brain, many shells.**
   Loom owns the analysis model. Shells should stay thin.

2. **Galaxy-first execution.**
   Real jobs are expected to run in Galaxy. Local mode is an escape hatch, not the primary runtime model.

3. **Durable research record.**
   Plans, decisions, checkpoints, provenance, and outputs persist to a notebook in the working directory and are tracked in git.

4. **Shell-neutral contracts.**
   Shell-specific rendering belongs in Orbit or future web code. Brain output should flow through typed widget/status/notify contracts.

5. **Session continuity by directory.**
   The analysis directory is the unit of continuity. Notebook state and Pi session state are both keyed off that workspace context.

## Brain Responsibilities

The Loom brain lives in [`extensions/loom/`](../extensions/loom/).

Primary responsibilities:

- maintain analysis plan state
- enforce lifecycle rules
- persist and restore notebooks
- define LLM-callable tools
- inject system context
- emit shell-neutral UI events
- manage Galaxy profile/config policy
- own execution/playbook semantics for slash-command-driven workflows

Important modules:

- [`index.ts`](../extensions/loom/index.ts)
  Entry wiring for tools, commands, UI bridge, context injection, and lifecycle hooks.

- [`state.ts`](../extensions/loom/state.ts)
  In-memory source of truth for the current plan plus lifecycle validation, provenance, findings, publication state, workflow linkage, and notebook sync hooks.

- [`tools.ts`](../extensions/loom/tools.ts)
  Brain-level tool registry. Mutates state and emits structured results/widgets.

- [`context.ts`](../extensions/loom/context.ts)
  Builds the system prompt context, including execution mode, Galaxy posture, plan summary, and behavior rules.

- [`ui-bridge.ts`](../extensions/loom/ui-bridge.ts)
  Translates plan mutations into shell-facing widget events.

- [`session-bootstrap.ts`](../extensions/loom/session-bootstrap.ts)
  Owns startup restore policy, greeting policy, fresh-session handling, and compact/shutdown persistence.

- [`execution-commands.ts`](../extensions/loom/execution-commands.ts)
  Owns `/review`, `/test`, `/execute`, and `/run` semantics so shells do not encode execution policy in prompt strings.

- [`profiles.ts`](../extensions/loom/profiles.ts)
  Galaxy profile persistence and sync behavior.

## Shell Responsibilities

### CLI

The CLI entrypoint is [`bin/loom.js`](../bin/loom.js).

Responsibilities:

- boot Pi in RPC mode
- load shared Loom config (~/.loom/config.json)
- register or strip Galaxy MCP based on execution mode + credential availability
- inject credentials into environment / MCP config (remote mode only)

The CLI is still a shell, even though it is thin. It should not own analysis semantics that differ from Orbit.

### Orbit

Orbit lives in [`app/`](../app/).

Responsibilities:

- start and supervise the agent subprocess
- bridge renderer ↔ agent via IPC
- render chat, plan, step graph, notebook/results, and parameter form
- manage shell-specific state like window geometry
- expose user actions such as working-directory switch, preferences, and fresh session reset

Main modules:

- [`src/main/agent.ts`](../app/src/main/agent.ts)
  Agent subprocess lifecycle and RPC line transport.

- [`src/main/ipc-handlers.ts`](../app/src/main/ipc-handlers.ts)
  Main-process request handlers for renderer actions.

- [`src/preload/preload.ts`](../app/src/preload/preload.ts)
  Typed `window.orbit` bridge.

- [`src/renderer/app.ts`](../app/src/renderer/app.ts)
  Main renderer orchestration. Consumes shared shell contract payloads.

### Future Web Shell

The intended direction is valid, but not fully designed yet. There are two materially different possibilities:

- **thin local shell**
  Similar to Orbit: talks to a local Loom runtime and renders the same shell contract

- **hosted service**
  Introduces auth, multi-user tenancy, remote session ownership, remote file/notebook access, and Galaxy account linking

Those are not small variations of the same architecture. Before the web shell grows much further, decide which one it is.

## Shared Contracts

The shared cross-boundary code lives in [`shared/`](../shared/).

Current shared contracts:

- [`loom-config.js`](../shared/loom-config.js)
  Shared config load/save/path semantics for CLI, brain, and Orbit

- [`loom-shell-contract.js`](../shared/loom-shell-contract.js)
  Shared widget keys and payload encoding/decoding for brain ↔ shell communication

This is important because Orbit and future shells should not reverse-engineer brain payloads from implementation details.

## Data Flow

### Orbit User Message Path

```text
User types in Orbit
→ renderer calls window.orbit.prompt(...)
→ main process forwards to AgentManager
→ AgentManager writes JSON RPC line to Loom subprocess stdin
→ Pi + Loom process the turn
→ tools mutate state / emit widget events
→ main process forwards events back to renderer
→ Orbit updates chat + artifact panes
```

### Plan Mutation Path

```text
tool executes
→ state mutation in state.ts
→ notifyPlanChange()
→ ui-bridge.ts
→ structured widget payload
→ shell renders plan / steps / results / parameters
```

### Notebook Persistence Path

```text
tool or command mutates plan
→ state.ts updates currentPlan
→ notebook sync helper updates markdown notebook
→ git commit records meaningful change
```

## Session Lifecycle

Session lifecycle policy now lives in [`session-bootstrap.ts`](../extensions/loom/session-bootstrap.ts).

At session start:

1. reset in-memory state
2. detect whether this is a fresh session (`LOOM_FRESH_SESSION=1`)
3. if not fresh, try notebook restore from the working directory
4. if no notebook was restored, fall back to compacted Pi session state
5. if appropriate, send a startup greeting / recap message

At compaction/shutdown:

- current plan is appended to Pi session entries for fallback restore

Important invariants:

- notebook restore wins over stale compacted session state
- restored plans emit to the shell once UI context is available
- directory switch in Orbit starts a fresh agent session in the new `cwd`

## Config Model

Three layers exist:

1. **Brain config** — `~/.loom/config.json`
   Shared user-facing config: LLM provider/model/key, Galaxy profiles, execution mode, default working directory

2. **Shell-specific state**
   Orbit uses `~/.orbit/` for window state and similar shell-only concerns

3. **Analysis-local state**
   Notebook markdown and git history live in the analysis directory

The single source of truth for reading/writing brain config is now:

- [`shared/loom-config.js`](../shared/loom-config.js)

## Execution Model

Supported posture:

- **Remote** is the standard path.
  Galaxy MCP is available, and real jobs are expected to happen there.

- **Local** is an escape hatch.
  It is intentionally discouraged for ordinary work and does not define the long-term execution architecture.

That means product and shell design should optimize for Galaxy-backed execution, provenance, and resumability.

## Brain ↔ Shell Boundary

This boundary is the most important one to preserve.

The brain may:

- emit widgets
- emit statuses
- emit notifications
- request user input/selection/confirmation

The shell may:

- display those events
- forward user text/commands
- manage shell-local affordances and state

The shell should not:

- own lifecycle rules
- own plan semantics
- own execution policy for core analysis flows
- fork brain contracts into shell-specific ad hoc payloads

## Current Constraints

- Local mode is still an exception path, not a mature first-class runtime.
- Orbit remains the richest shell; CLI is thinner and web is not yet architecturally fixed.
- Notebook persistence is local-directory-based, which is correct for local shells but must be reconsidered carefully for any hosted deployment.
- Hosted multi-user web architecture will require explicit decisions about session ownership, storage, auth, and Galaxy credential linkage.

## Recommended Next Steps

If onboarding other engineers, point them here first, then to:

- [`README.md`](../README.md) for product-level framing
- [`CLAUDE.md`](../CLAUDE.md) for repo conventions and dev workflow

Architecturally, the next decisions that matter are:

1. define whether `web/` is a thin local shell or the start of a hosted service
2. preserve the shared shell contract as the only brain→shell protocol
3. keep execution policy in Loom, not in shells
4. treat Galaxy as the real runtime substrate for production work
