# Multi-Agent Team Dispatch — Design

**Date:** 2026-04-17
**Status:** Approved for implementation planning
**Owner:** nekrut (fork) / dannon (upstream review)

> **Rollout note (2026-04-19):** the MVP ships behind an opt-in flag,
> `experiments.teamDispatch` in `~/.loom/config.json`, with an env override
> `LOOM_TEAM_DISPATCH=1` (or `=0` to force off). Default Loom sessions do
> not register the tool or carry the prompt block. See §12 for the upstream
> work that would justify flipping the default.

## 1. Context and motivation

Researchers want to frame parts of an analysis as a short-lived team of specialists cooperating on a single task, expressed in natural language. Canonical example:

> "Start a two-agent team for literature review. One finds papers, the other validates."

Today Loom can handle this only through two parallel Orbit windows, which fight over the same `notebook.md` and share nothing programmatically. The goal of this feature is to let the main Loom agent spin up a scoped **Finder ↔ Validator critic loop** from a natural-language request and return a structured result that the main agent then persists via existing notebook tools.

This is not a general "agent framework" — it's a narrowly scoped extension that fits Loom's single-writer, brain-owned-state architecture.

## 2. Decisions locked in during brainstorming

| # | Decision | Value |
|---|---|---|
| Q1 | Coordination pattern | **Critic loop** — proposer turn → critic turn → repeat on rejection |
| Q2 | Interim turn visibility | **Expandable** — collapsed summary in chat, click to see per-turn detail |
| Q3 | Generality | **Generic mechanism** — roles, prompts, tools inferred from NL request; literature review is one use case |
| Q4 | Notebook integration | **Main agent writes** — team returns structured result; main agent persists via existing tools |
| Q5 | Pre-dispatch approval | **Conditional** — main agent auto-dispatches when the NL request is specific; asks user when vague |
| Q6 | Tools available to team | **None in MVP** (pivoted from "filtered subset"); see §12 — Pi.dev's extension API does not expose execute-capable tools to extensions, so roles are pure-reasoning. Main agent pre-gathers inputs into `TeamSpec.description` before dispatch. |
| Q7 | Team authority | **Advisory only** (pivoted from "mixed/opt-in"); roles have no tools, therefore no mutations possible. Single-writer preserved by construction. |
| Q8 | Termination | **Validator approval OR `max_rounds`** (default 5); best-so-far returned if cap hit |
| Q9 | Transcript persistence | **Ephemeral** — in-memory during dispatch, returned in the tool result, not persisted to disk |

Approved implementation approach: **Sibling `Agent` instances driven by a dispatch tool** in the same Node process. Alternatives considered: single-Agent role switching (rejected — poor tool scoping, memory bleed) and subprocess-per-role (rejected — heavyweight, unnecessary for sequential critic loop).

## 3. Architecture

Team dispatch is a brain-level feature inside `extensions/loom/`. It surfaces to the rest of the system as one additional tool call from the main agent. **No changes to the shell contract, Orbit renderer, CLI, or RPC.** Turn-by-turn updates ride on the existing tool-card `onUpdate` stream.

New source files:

```
extensions/loom/teams/
  types.ts         TeamSpec, RoleSpec, TeamResult, TeamTurn
  dispatcher.ts    Critic-loop engine; spawns sibling Agent instances
  tool-filter.ts   Curates a role's tool list from the main registry
  tool.ts          Registers the team_dispatch tool
```

Registered from `extensions/loom/index.ts` alongside existing tools.

The main agent is responsible for composing a `TeamSpec` from the user's NL request; the heuristics for when to ask for confirmation (Q5) are encoded as system-prompt guidance in `extensions/loom/context.ts`, not as code.

## 4. Tool contract

### 4.1 Input — `TeamSpec`

```ts
interface TeamSpec {
  description: string;      // free-text task the team is solving
  roles: RoleSpec[];        // >= 2, <= 2 for MVP; extensible shape
  max_rounds?: number;      // default 5; valid range 1..20
  model?: string;           // default: same model as main agent
}

interface RoleSpec {
  name: string;             // e.g., "Finder", "Validator"; shown in UI
  system_prompt: string;    // role-specific instructions
  model?: string;           // per-role override; falls back to TeamSpec.model
}
```

`roles[0]` is the proposer, `roles[roles.length - 1]` is the critic. For MVP the critic loop runs with exactly two roles; specs with more are rejected at validation time with a clear "not implemented" error.

### 4.2 Output — `TeamResult`

```ts
interface TeamResult {
  converged: boolean;
  rounds: number;
  final_output: string;
  transcript: TeamTurn[];   // ephemeral (Q9); returned but not persisted
  usage: { input_tokens: number; output_tokens: number };
  aborted?: boolean;
  budget_exhausted?: boolean;
  error?: string;           // populated only on non-validation failures
}

interface TeamTurn {
  round: number;
  role: string;             // RoleSpec.name
  content: string;
  approved?: boolean;       // only on critic turns
}
```

### 4.3 Validation (fail-fast before any LLM call)

- `roles.length === 2` (MVP). `> 2` is rejected.
- `role.name` non-empty and unique across roles.
- `max_rounds` in `[1, 20]`.

Validation failures return a tool-call error naming the offending field. No LLM call is made.

## 5. Critic-loop runtime

```
round = 1
current_proposal = null
current_critique = null
while round <= max_rounds:
  proposer_input = render_proposer_prompt(description, current_critique)
  current_proposal = runAgent(proposer_role, proposer_input)
  emit(onUpdate, {round, role: proposer.name, content: current_proposal})

  critic_input = render_critic_prompt(description, current_proposal)
  critic_response = runAgent(critic_role, critic_input)
  {approved, critique} = parse_critic_response(critic_response)
  emit(onUpdate, {round, role: critic.name, content: critic_response, approved})

  if approved:
    return {converged: true, rounds: round, final_output: current_proposal, ...}
  current_critique = critique
  round += 1

return {converged: false, rounds: max_rounds, final_output: current_proposal, ...}
```

### 5.1 `runAgent(role, user_message)` — direct LLM call

Makes one raw LLM call via `pi-ai`'s `completeSimple` (synchronous sibling of `streamSimple` — returns the final `AssistantMessage` once; no streaming consumer needed since each turn's content is used atomically before the next turn starts):

- System prompt: `role.system_prompt` prepended with a universal preamble. The preamble states the team context ("You are one role in a two-agent team collaborating on: ...") and, for the critic role, requires the response to end with a JSON line of shape `{"approved": bool, "critique": string}`.
- Model resolution: `role.model ?? spec.model ?? ctx.model`; resolved via `ctx.modelRegistry`.
- API key / headers: `getApiKeyAndHeaders(model)` from the resolved model.
- `AbortSignal`: chained from the dispatch tool's signal so a user-triggered abort cascades.
- One user message containing `user_message`.

Returns the LLM's assistant text and usage. No tool calls — roles cannot invoke tools.

### 5.2 `parse_critic_response(text)`

Scans `text` for the last well-formed JSON object matching `{approved: bool, critique: string}`. If found, returns the parsed object. If not, returns `{approved: false, critique: text}`. This makes the critic robust to roles that prefix their JSON with prose.

### 5.3 Concurrency model

The critic loop is strictly sequential (critic depends on proposer's output; next proposer depends on critic's critique). Each turn is a single `completeSimple` call; no tools, no inner agent loop.

## 6. Tool scoping — removed in MVP (see §12)

Roles make zero tool calls. The team operates on a fixed input encoded in `TeamSpec.description`; any tool work that needs to happen (web search, notebook reads, data gathering) is performed by the main agent *before* the dispatch call and included in the description as context.

This is a deliberate MVP simplification driven by Pi.dev's current extension surface (see §12 — Future work).

## 7. UI integration

No new widgets. No changes to `shared/loom-shell-contract.*`. The deliberation renders as an existing tool card driven by `onUpdate` payloads:

```ts
onUpdate({
  summary: `Round ${round}/${max_rounds} — ${role.name} responding…`,
  details: {
    kind: "team_dispatch",
    spec: { description, roles: [{ name, model }] },
    turns: TeamTurn[]       // appended; all turns so far
  }
});
```

Final update on completion has summary `"Team converged in ${rounds} rounds"` or `"Team did not converge (${max}/${max} rounds — returning best-so-far)"`.

The renderer (`app/src/renderer/chat/...`) detects `details.kind === "team_dispatch"` and renders:

- **Collapsed:** team label (e.g. `Finder × Validator`), outcome badge (✓ / ⚠), round count.
- **Expanded:** one row per `TeamTurn` — role label, content, approval indicator on critic turns. (Post-tools rollout — see §12 — will also nest each role's tool calls under its turn using the existing tool-card component; MVP roles make none.)

User's existing "stop" button aborts the main agent's tool, which cascades `AbortSignal` to in-flight team agents.

The artifact pane is not touched. When the main agent takes the team's result and persists it via existing tools (e.g., `interpretation_add_finding`, a new notebook section, a plan-step result), the artifact pane updates through its existing paths.

## 8. Error handling

| Failure | Behavior |
|---|---|
| Spec validation | Tool returns error before spawning; error names the offending field. |
| Role agent throws (provider 4xx, network, runtime) | Caught in dispatcher; `TeamTurn` with `{role, error}` recorded; tool returns with `error` populated and `converged: false`. |
| Critic produces no parseable JSON | Fallback `{approved: false, critique: <full text>}`; loop continues; `max_rounds` eventually terminates. |
| `max_rounds` reached without approval | Normal return with `converged: false`, `final_output` = last proposer turn. |
| `AbortSignal` fires mid-run | In-flight agent unwinds; dispatcher returns partial transcript with `aborted: true`; tool call fails. |
| Token budget exceeded | Dispatcher tracks cumulative usage; exits with `converged: false, budget_exhausted: true` if total crosses configurable ceiling (default 300k tokens). |

The dispatcher never retries internally. Retry policy (including re-dispatch with revised spec) belongs to the main agent, which sees the failure and decides.

## 9. Testing

### 9.1 Unit

- `filterToolsForRole` — valid and invalid combinations of `tools_read` / `tools_write`; rejection cases; Pi built-in classifications.
- `parse_critic_response` — JSON-only, JSON at end with prose, malformed JSON, missing entirely, multiple JSON blocks (last wins).
- `validateTeamSpec` — every field boundary including `max_rounds` range, `roles.length`, duplicate names, unknown tool names.

### 9.2 Integration with stub provider

A fake LLM that returns canned responses keyed by `{role, round}`. Tests:

- Early convergence (critic approves round 1).
- Late convergence (critic approves round 3 of 5).
- No convergence (critic never approves; cap hit).
- Role agent throws in round 2 — tool returns with error; prior rounds preserved in transcript.
- `AbortSignal` fires during round 2 — dispatcher returns `aborted: true` with partial transcript.
- Token budget ceiling — dispatcher exits before `max_rounds` with `budget_exhausted: true`.

### 9.3 Out of scope for this feature's test plan

- Live-LLM integration tests (expensive, flaky; stub provider covers logic).
- Renderer UI test (existing tool-card rendering is already covered elsewhere).
- Galaxy end-to-end.

Test placement follows repo convention: unit + stub-integration in `tests/`, runnable via `npm test`.

## 10. Out of scope / future

- `roles.length > 2` (intermediate reviewers, multi-stage pipelines). Shape already accommodates it; dispatcher is MVP-restricted.
- Parallel reducers (Q1c). Different coordination pattern; would need a different dispatcher mode.
- Transcript persistence to disk (Q9b). The `TeamResult` already carries the transcript; a later feature could hook a persister.
- Per-role model optimization (e.g., cheaper model for Finder, stronger for Validator). `RoleSpec.model` is already in the schema.
- Subprocess isolation (approach C). Future option if cross-process state contention or true parallelism matters.

## 11. Implementation plan artifacts

This spec hands off to `superpowers:writing-plans`, which will produce a step-by-step implementation plan mapping each section here to concrete file edits and tests.

The implementation branch is `feat/multi-agent-teams` (on which this spec is committed).

## 12. Future work — re-enable tools once Pi.dev exposes the registry

During implementation it became clear that Pi.dev's extension API does not expose execute-capable tools to extension tool handlers. `pi.getAllTools()` returns `ToolInfo` (name/description/params only — no `execute`); Pi built-ins (`bash`, `read_file`, `grep`, `list_files`, `glob`) are registered outside the extension API and cannot be mirrored from inside one.

Without that accessor, a nested `Agent` spawned from a tool handler has no usable tool set, so the MVP pivots to pure-reasoning roles (pivot documented in §2 Q6/Q7).

Re-enabling tools is straightforward once one of the following exists:

1. `ExtensionContext.getRegisteredTool(name)` / `.getAllRegisteredTools()` returning `AgentTool<any>` (executable), or
2. A published helper like `createAgentForSubTask(ctx, { tools, systemPrompt, model? }): Agent` that handles the wiring internally, or
3. A documented model-spec format for `spec.model` so the dispatcher can resolve provider/model without guessing.

The parts of the design that need to come back with tools are:
- `RoleSpec.tools_read` / `.tools_write` fields (kept out of MVP).
- A `readonly` metadata field on every Loom tool (or a curated side-list like the one we briefly had).
- A `filterToolsForRole` helper that enforces the read-only constraint at dispatch time.
- `TeamTurn.tool_calls` to record tool invocations in the transcript.
- A Pi-Agent-based `runRoleTurn` (replaces the MVP's `completeSimple` call).

The dispatcher, validator, critic-parser, and UI integration all stay as-is.
