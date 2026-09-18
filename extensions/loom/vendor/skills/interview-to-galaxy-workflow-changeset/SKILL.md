---
name: interview-to-galaxy-workflow-changeset
description: "Interview a user against an existing Galaxy workflow summary and emit a reviewable, step-anchored change-set."
---

# interview-to-galaxy-workflow-changeset

Follow the procedure below and use the artifact/reference sections as the runtime contract.

## When To Use

- Interview a user against an existing Galaxy workflow summary and emit a reviewable, step-anchored change-set.

## Inputs

- Read artifact `summary-galaxy-workflow`. Schema: summary-galaxy-workflow. Produced by `summarize-galaxy-workflow`. Structured summary of the existing workflow from summarize-galaxy-workflow; the anchor set the change-set addresses (step labels, input labels, output names, tool_state keys).
- Read artifact `open-requirements-ledger`. Produced by `advance-galaxy-draft-step`, `apply-galaxy-workflow-changeset`, `compare-against-iwc-exemplar`, `cwl-summary-to-galaxy-data-flow`, `cwl-summary-to-galaxy-interface`, `cwl-summary-to-galaxy-template`, `freeform-summary-to-galaxy-data-flow`, `freeform-summary-to-galaxy-interface`, `freeform-summary-to-galaxy-template`, `implement-galaxy-tool-step`, `interview-to-galaxy-workflow-changeset`, `mature-galaxy-workflow-for-iwc`, `nextflow-summary-to-galaxy-data-flow`, `nextflow-summary-to-galaxy-interface`, `nextflow-summary-to-galaxy-reference-data`, `nextflow-summary-to-galaxy-template`, `repair-galaxy-draft-topology`. Carried obligations ledger open-requirements-ledger: the run's open, resolved, and surrendered entries with their provenance. Absent on the first Mold of a run; start an empty one.

## Outputs

- Write artifact `galaxy-workflow-changeset` as `galaxy-workflow-changeset.md`. Format: `markdown`. Reviewable, ordered list of edit intents, each anchored to an existing step/input/output by label (or marked `new`), with edit kind, target, intent, and acceptance note. The human approval gate before any edits are applied.
- Write artifact `open-requirements-ledger` as `open-requirements.ledger.yml`. Format: `yaml`. Carried obligations ledger re-emitted by this step: entries it appended or closed updated, every other entry passed through with its provenance intact.

## Required Tools

- None declared. Procedure should not assume external CLIs are present.

## Load Upfront

- `references/notes/open-requirements-ledger.md`: Research note copied verbatim into the bundle. Record a requested change the workflow cannot support as described as an open entry, so an unsupportable request survives as a tracked obligation rather than a fabricated anchor or a silent drop.
- `references/schemas/summary-galaxy-workflow.schema.json`: Schema file copied verbatim into the bundle. Input contract: read the existing-workflow summary to anchor every change-set entry to a real step/input/output.

## Load On Demand

- None declared.

## Validation

- None declared.

## Procedure

Turn a modification interview into a **reviewable change-set** against an existing Galaxy workflow. This is the update pipeline's analogue of interview-to-freeform-summary: the harness owns the live interaction; the skill's job is the normalized handoff. But unlike the greenfield summary, the output is *anchored to concrete steps* of a workflow that already exists — it names what to change, not what to build.

The harness owns the interaction style (interactive session, saved transcript, or custom UI). Read the summary-galaxy-workflow first so every change is expressed against real labels rather than a mental model of the workflow.

### Output: the change-set

Emit Markdown: an ordered list of edit intents. Each entry carries:

- **kind** — one of: `add-step`, `replace-tool`, `remove-step`, `change-parameter`, `add-input`, `remove-input`, `add-output` / `expose-output`, `rewire`, `relabel` / `annotate`.
- **anchor** — the existing step label, input label, output name, or `tool_state` key the edit targets, quoted from the summary; or `new` for an added element.
- **intent** — what the user wants, in their words plus the concrete target value where they gave one (e.g. a parameter's new value).
- **acceptance** — how a reviewer or a test would confirm the edit landed (a new output is present, a parameter reads the new value, a step feeds its intended consumer).

Order edits so dependencies read top-to-bottom (add a step before rewiring its consumer). The change-set is a **reviewable artifact** — the natural human approval gate before apply-galaxy-workflow-changeset touches the workflow.

### Anchor discipline

Every entry must anchor to something the summary actually contains, or be explicitly marked `new`. Do not reference a step the workflow does not have, and do not silently rename an existing anchor. If the user asks for a change the workflow cannot support as described — an operation on a step that isn't there, a parameter a tool doesn't expose, a rewire that would break the graph — record it on the open-requirements-ledger as an open entry rather than inventing an anchor or quietly dropping the request.

### Don't over-specify

- **Don't resolve tools here.** An `add-step` or `replace-tool` names the *operation and any user-given tool/version*, not a resolved Tool Shed changeset — wrapper resolution is the per-step loop's job downstream. Record vague tool intent as intent plus, if needed, an open-requirements entry.
- **Don't apply the edit.** This skill decides *what* changes; apply-galaxy-workflow-changeset decides *how* the gxformat2 changes. Keep the two separate so the change-set stays reviewable.
- **Preserve scope.** Capture only what the interview supports. Do not fold in unrequested "while we're here" tidying — untouched regions must stay untouched, and a change-set that quietly widens scope propagates gratuitous churn downstream.

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
