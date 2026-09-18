---
name: advance-galaxy-draft-step
description: "Advance the gxformat2 draft by one step: pick the next drafty step, resolve a wrapper, implement the step, and validate."
---

# advance-galaxy-draft-step

Follow the procedure below and use the artifact/reference sections as the runtime contract.

## When To Use

- Advance the gxformat2 draft by one step: pick the next drafty step, resolve a wrapper, implement the step, and validate.

## Inputs

- Read artifact `galaxy-workflow-draft`. Schema: galaxy-workflow-draft. Produced by `advance-galaxy-draft-step`, `apply-galaxy-workflow-changeset`, `cwl-summary-to-galaxy-template`, `freeform-summary-to-galaxy-template`, `implement-galaxy-tool-step`, `nextflow-summary-to-galaxy-template`, `repair-galaxy-draft-topology`. gxformat2 draft (see galaxy-workflow-draft-format) mutated in-place across iterations; topology is fully concrete, individual tool steps may still carry `TODO_*` sentinels and `_plan_*` planning fields.
- Read artifact `open-requirements-ledger`. Produced by `advance-galaxy-draft-step`, `apply-galaxy-workflow-changeset`, `compare-against-iwc-exemplar`, `cwl-summary-to-galaxy-data-flow`, `cwl-summary-to-galaxy-interface`, `cwl-summary-to-galaxy-template`, `freeform-summary-to-galaxy-data-flow`, `freeform-summary-to-galaxy-interface`, `freeform-summary-to-galaxy-template`, `implement-galaxy-tool-step`, `interview-to-galaxy-workflow-changeset`, `mature-galaxy-workflow-for-iwc`, `nextflow-summary-to-galaxy-data-flow`, `nextflow-summary-to-galaxy-interface`, `nextflow-summary-to-galaxy-reference-data`, `nextflow-summary-to-galaxy-template`, `repair-galaxy-draft-topology`. Carried obligations ledger open-requirements-ledger: the run's open, resolved, and surrendered entries with their provenance. Absent on the first Mold of a run; start an empty one.

## Outputs

- Write artifact `galaxy-workflow-draft` as `galaxy-workflow-draft.gxwf.yml`. Format: `yaml`. Schema: galaxy-workflow-draft. Same draft with one additional step concretized (one loop iteration). Once every step is concrete, draft-next-step reports `draft: false` and the harness exits the loop.
- Write artifact `galaxy-workflow` as `galaxy-workflow.gxwf.yml`. Format: `yaml`. Concrete gxformat2 workflow (`class: GalaxyWorkflow`) extracted from the fully-concretized draft at loop endstate via draft-extract: drafty steps dropped, `_plan_*` planning fields stripped, class promoted. The runnable, testable artifact that downstream Molds (implement-galaxy-workflow-test, validate-galaxy-workflow, run-workflow-test) consume.
- Write artifact `open-requirements-ledger` as `open-requirements.ledger.yml`. Format: `yaml`. Carried obligations ledger re-emitted by this step: entries it appended or closed updated, every other entry passed through with its provenance intact.

## Required Tools

- **`galaxy-tool-cache`** (galaxy-tool-cache). `npm install -g '@galaxy-tool-util/cli@^1.8.1'`.
  Ephemeral run: `npx --yes --package @galaxy-tool-util/cli@1.8.1 galaxy-tool-cache`.
  Check: `galaxy-tool-cache --help | grep -q summarize`.
  Docs: https://github.com/jmchilton/galaxy-tool-util-ts/tree/main/packages/cli
- **`gxwf`** (gxwf). `npm install -g '@galaxy-tool-util/cli@^1.8.1'`.
  Ephemeral run: `npx --yes --package @galaxy-tool-util/cli@1.8.1 gxwf`.
  Check: `gxwf --help | grep -q draft-validate`.
  Docs: https://github.com/jmchilton/galaxy-tool-util-ts/tree/main/packages/cli

## Load Upfront

- `references/cli/draft-next-step.json`: CLI command reference packaged as a sidecar. Deterministically pick the next drafty step (or report no remaining work). The orchestrator owns the loop oracle so the harness reduces to `while draft: invoke skill`. Use when: at the start of every iteration, before any per-step work.
- `references/notes/open-requirements-ledger.md`: Research note copied verbatim into the bundle. Read the ledger after each step implementation for a newly appended blocking entry, count the open blocking entries the convergence gate reads, and maintain the topology_repair escalation budget the loop's termination guard depends on.
- `references/schemas/galaxy-workflow-draft.schema.json`: Schema file copied verbatim into the bundle. In/out contract: the draft this Mold reads and mutates one step per iteration conforms to galaxy-workflow-draft. Cast bundles the JSON Schema alongside the draft-validate CLI checks.

## Load On Demand

- `references/cli/add.json`: CLI command reference packaged as a sidecar. Cache the resolved wrapper for summarization and validation, using its confirmed tool version. Use when: after resolving the wrapper and version, if the shared cache lacks that pin.
- `references/cli/draft-extract.json`: CLI command reference packaged as a sidecar. At loop endstate, extract the concrete gxformat2 workflow from the fully-concretized draft — drop drafty steps, strip `_plan_*` fields, promote `class` to `GalaxyWorkflow` — and write it as the runnable `galaxy-workflow.gxwf.yml`. Use when: draft-next-step reports `draft: false` (no remaining drafty steps).
- `references/cli/draft-validate.json`: CLI command reference packaged as a sidecar. Validate the draft and its concrete subset with --concrete --strict-state --json; skipped tool-state checks must fail the gate. Use when: after implementing or modifying the chosen step in the draft.
- `references/cli/list.json`: CLI command reference packaged as a sidecar. Read a stock tool's cached version when the step plan has no version pin. Use when: in step 2, when the chosen step's tool is a bare/stock id and its concrete version isn't already known from a step-plan pin.
- `references/notes/galaxy-tool-job-failure-reference.md`: Research note copied verbatim into the bundle. Classify draft-validate diagnostics against wrapper-defined runtime failure semantics so the iteration routes back to the right authoring surface (implementation vs. wrapper choice). Use when: draft-validate fails after a step has been implemented, or when a selected wrapper has explicit failure semantics that may surface at runtime.
- `references/schemas/galaxy-tool-summary.schema.json`: Schema file copied verbatim into the bundle. Bind the chosen step against the deterministic tool summary manifest emitted by summarize-galaxy-tool — read `parsed_tool` for ports/datatypes and `input_schemas.workflow_step_linked` for valid step `state` shape. Use when: after a wrapper has been resolved for the chosen step and before implementing it.

## Validation

- Validate `galaxy-workflow-draft.gxwf.yml` for artifact `galaxy-workflow-draft` against the galaxy-workflow-draft schema when a validator is available.

## Procedure

Orchestrator skill for the per-step Galaxy authoring loop. One invocation advances the gxformat2 draft by **one** step: pick → resolve a wrapper → summarize the wrapper → implement the step → validate. The harness loop reduces to `while (gxwf draft-next-step <wf>).draft: invoke skill`.

This skill is **single-entry, single-exit**: it owns the loop oracle (draft-next-step) and the per-step validator (draft-validate `--concrete`). Iterations terminate when the draft has no remaining drafty steps; on that terminal call the skill extracts the concrete `galaxy-workflow.gxwf.yml` (via draft-extract) — that promoted-class workflow, not the `-draft` file, is what downstream skills test and run — and the harness then drops out of the loop and proceeds to terminal validation via validate-galaxy-workflow.

### Sequence

Choose a writable tool-cache directory for the run. Pass the same `--cache-dir <dir>` to cache commands, wrapper summarization, and validation.

1. **Pick.** Run draft-next-step. If `draft: false`, the loop is done: run draft-extract to emit the concrete `galaxy-workflow.gxwf.yml` (drafty steps dropped, `_plan_*` stripped, `class` promoted to `GalaxyWorkflow`), then return. Otherwise carry the chosen step id forward.
2. **Resolve a wrapper.** First check for an existing pin:
   - **Already resolved in this draft** — find a concrete step with the `tool_id` named by the chosen step's `_plan_*` context or identity pin. Reuse its `tool_id` and `tool_version`, skipping discover-shed-tool for Tool Shed wrappers or cache/version lookup for stock tools. Continue to step 3.

   Otherwise, split on whether the step's tool is a **built-in / stock** Galaxy tool — a bare id with no `owner/repo` path (`Filter1`, `sort1`, `Cut1`, `Show beginning1`, collection ops, `__APPLY_RULES__`):
   - **Built-in / stock** — the bare id *is* the wrapper identity; it does **not** route through discover-shed-tool (Tool Shed search) or author-galaxy-tool-wrapper. Only its concrete version needs resolving: the shed serves stock tools by bare id, but its TRS version-list endpoint can't auto-resolve the version, so read it from a populated cache via `galaxy-tool-cache list` or take a known pin from the step plan — never hand-guess a stock version. summarize-galaxy-tool then performs the bare-id `add`/`summarize` with that explicit `--tool-version`.
   - **Tool Shed wrapper** — branch on whether the template already pinned wrapper identity (see the tiers in galaxy-workflow-draft-format):
     - **Identity-pinned** — `tool_id` is concrete and `tool_version` is `TODO`. Treat the pin as a strong seed: confirm it via discover-shed-tool and resolve the changeset, correcting the `tool_id` only if discovery contradicts the pin (a pinned id is high-confidence template evidence, not a guess to re-derive from scratch).
     - **Deferred** — `tool_id` is `TODO`. Search fresh: run discover-shed-tool against the step's `_plan_*` context.

     Either way, if no acceptable shed candidate emerges, fall through to author-galaxy-tool-wrapper.

   If the resolved pin is absent from the cache, run add `<tool_id> --tool-version <v> --cache-dir <dir>` before summarization. In `@galaxy-tool-util/cli` 1.10.0, validation also fetches and caches missing metadata unless `--offline` is set; offline validation requires a populated cache.
3. **Summarize the wrapper.** If step 2 reused a sibling's pin, reuse the cached galaxy-tool-summary for that `tool_id`/`tool_version` pair. Otherwise, invoke summarize-galaxy-tool to produce the summary.
4. **Implement.** Invoke implement-galaxy-tool-step with the summary and the draft; it resolves the chosen step's remaining `TODO_*` / `_plan_*` slots into a concrete `tool_id` (confirming or correcting any pinned identity), `tool_version`, `state`, and wrapper-determined port names.
5. **Check computability.** Inspect the open-requirements-ledger for a new `open` blocking entry implement-galaxy-tool-step appended against this step. draft-validate cannot catch this: the connection graph knows ports connect, not what they carry, so the draft validates green even though the step can't run. If such an entry is present, escalate to repair-galaxy-draft-topology for a bounded repair (insert a producer/sub-path or honestly narrow the output), then update the ledger's `topology_repair` budget as the ledger note directs — each escalation must strictly reduce the open blocking-entry count, under a hard cap, and surrender rather than retry once the cap is reached. Then return — the next iteration resumes the loop, realizing any draft-tier steps the repair inserted. With no new blocking entry, continue to validation.
6. **Validate.** Run draft-validate `<draft> --concrete --strict-state --json --cache-dir <dir>`. `--strict-state` makes skipped tool-state checks fail validation; draft structure and topology checks still run. If metadata is unavailable, resolve the cache or fetch error and retry. Return on exit 0; route other failures using the JSON diagnostics and the rules below.

### Failure routing

`draft-validate --concrete --strict-state --json` failures, after resolving metadata availability, fall into three buckets:

- **Local to the just-implemented step** (sentinel violation, wrong port name, malformed `state`) — re-enter implement-galaxy-tool-step with the diagnostic.
- **Wrapper-choice mismatch** (selected wrapper cannot satisfy the step's `_plan_*` contract — wrong datatype, missing parameter, incompatible collection shape) — back out to step 2 and pick a different wrapper, either via discover-shed-tool with refined criteria or by escalating to author-galaxy-tool-wrapper.
- **Earlier-step defect surfaced by the growing concrete projection** (e.g. a connection that looked fine in isolation breaks once a downstream step pulls a previously-deferred port into scope) — flag to the user. The orchestrator does not unwind prior iterations on its own; cross-step rework belongs at the harness level. *Open question: at what threshold should this skill attempt to re-enter implement-galaxy-tool-step for an earlier step versus always escalating?*

These are red-`draft-validate` buckets. The fourth escalation path — a step output uncomputable from its wired inputs — is **not** one of them: the draft validates green there, so it is detected from the ledger in step 5 above, not from a validation failure.

Consult galaxy-tool-job-failure-reference when the wrapper has explicit failure semantics that affect routing — strict-shell behavior, dynamic outputs, or non-default stdio rules can present as wrapper-choice mismatches even when the static shape validates.

### Why orchestrator-shaped

Prior pipelines expressed the iteration as four entries: a `discover-or-author` branch plus `summarize-galaxy-tool`, `implement-galaxy-tool-step`, and `validate-galaxy-step`. Collapsing them into one orchestrator keeps the per-iteration narrative — including the discover-or-author branch and the failure-routing rules — in a single procedural surface that the skill can render coherently. Leaf skills stay independently castable for ad-hoc invocation; only the pipeline shape changes.

## Feedback Mode

- Feedback mode is off unless the caller explicitly enables `--feedback` or supplies a feedback-ledger path.
- When enabled, read `_feedback.md` before doing the work and use its registered `foundry-feedback.ledger.yml` protocol.
- Preserve harness-owned run and phase state. Append only concrete observations about a canonical Foundry source asset or a related project that this run showed to be at fault; do not put ordinary workflow requirements in this ledger.
- Before reporting completion, make one explicit pass over the work you just did. Do not ask yourself whether anything was unclear — recall what happened: where you guessed at something the instructions should have settled, needed information this bundle does not carry, hit an instruction that contradicted another or contradicted the artifacts in front of you, used a packaged reference that did not cover your case, or did something the procedure never describes.
- Append an entry for each such event that clears the protocol's bar. If none do, append nothing and report `no feedback` explicitly. Silence and a clean pass are not the same thing, and nothing downstream can tell them apart unless you say which one it was.
- Pass the same ledger path to any subagent used for this work, and merge updates serially so one writer cannot overwrite another.

## Runtime Notes

- Do not read Foundry source files at runtime; use only files packaged in this skill bundle and user-supplied artifacts.
- Preserve declared artifact filenames unless the user or harness supplies explicit paths.
- Carry unresolved assumptions into the output artifact instead of silently inventing missing source evidence.
