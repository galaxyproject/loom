---
name: changeset-to-galaxy-test-plan
description: "Carry an existing Galaxy workflow's tests forward as a regression baseline and augment them for a change-set's deltas, emitting a Galaxy test plan."
---

# changeset-to-galaxy-test-plan

Follow the procedure below and use the artifact/reference sections as the runtime contract.

## When To Use

- Carry an existing Galaxy workflow's tests forward as a regression baseline and augment them for a change-set's deltas, emitting a Galaxy test plan.

## Inputs

- Read artifact `summary-galaxy-workflow`. Schema: summary-galaxy-workflow. Produced by `summarize-galaxy-workflow`. Structured summary of the existing workflow from summarize-galaxy-workflow; its `tests[]` are the regression baseline to carry forward, and its resolved input/output labels are the anchors baseline assertions bind to.
- Read artifact `galaxy-workflow-changeset`. Produced by `interview-to-galaxy-workflow-changeset`. Reviewed, step-anchored change-set from interview-to-galaxy-workflow-changeset; names which edits change observable behavior, hence which baseline cases to update and which new assertions to add.

## Outputs

- Write artifact `galaxy-test-plan` as `galaxy-test-plan.yml`. Format: `yaml`. Schema: galaxy-workflow-test-plan. Reviewable Galaxy workflow test plan (see galaxy-workflow-test-plan): baseline cases carried forward as test-evidence plus change-set-driven cases/assertions, with job inputs, expected outputs, assertion intent, fixture provenance, label status, unresolved mappings, and omissions.

## Required Tools

- None declared. Procedure should not assume external CLIs are present.

## Load Upfront

- `references/schemas/galaxy-workflow-test-plan.schema.json`: Schema file copied verbatim into the bundle. Output contract: the emitted plan conforms to galaxy-workflow-test-plan. Cast bundles the JSON Schema so the skill carries its output shape; validate with `foundry validate-galaxy-workflow-test-plan`.
- `references/schemas/summary-galaxy-workflow.schema.json`: Schema file copied verbatim into the bundle. Input contract: read the existing workflow's `tests[]` (the regression baseline) and its resolved input/output labels so baseline assertions bind to real labels.

## Load On Demand

- `references/notes/galaxy-workflow-testability-design.md`: Research note copied verbatim into the bundle. Decide which change-set-exposed outputs and promoted checkpoints make meaningful new assertions, and how much a baseline assertion must loosen when an edit intentionally changes an output. Use when: adding assertions for a newly exposed output or a new step, or reconciling a baseline assertion an edit invalidates.
- `references/notes/iwc-shortcuts-anti-patterns.md`: Research note copied verbatim into the bundle. Distinguish accepted IWC-style test shortcuts from assertion smells when loosening a baseline assertion or synthesizing a new one. Use when: considering existence-only, size-only, image-dimension, or tolerant output checks, or recording an omission.
- `references/notes/iwc-test-data-conventions.md`: Research note copied verbatim into the bundle. Record job-input fixtures for change-set-added inputs (remote-URL-first locations, hashes, collection shapes) as fixture provenance, reusing the baseline's existing fixtures unchanged. Use when: a change-set adds a workflow input that needs new test data, or when recording provenance for a new fixture.
- `references/notes/planemo-asserts-idioms.md`: Research note copied verbatim into the bundle. Pick the assertion family and tolerance for each change-set-driven expected output by output type. Use when: turning a change-set behavioral delta into assertion intent and a tolerance.
- `references/notes/planemo-workflow-test-architecture.md`: Research note copied verbatim into the bundle. Keep the plan addressable by stable labels and artifacts Planemo can connect back to invocations, jobs, and outputs. Use when: recording the labels and checkpoints the downstream test must address.
- `references/schemas/tests-format.schema.json`: Schema file copied verbatim into the bundle. Use the Galaxy workflow tests schema as the assertion-family vocabulary when carrying forward or synthesizing assertion intent. Use when: naming an assertion family or compare operator for a carried-forward or change-set-driven expected output.

## Validation

- Validate `galaxy-test-plan.yml` before returning it: run `foundry validate-galaxy-workflow-test-plan galaxy-test-plan.yml` from `@galaxy-foundry/gxwf-foundry`. If the command is not on PATH, run `npx --package @galaxy-foundry/gxwf-foundry foundry validate-galaxy-workflow-test-plan galaxy-test-plan.yml`. This checks artifact `galaxy-test-plan` against the galaxy-workflow-test-plan schema.

## Procedure

Produce a Galaxy workflow test plan for the update pipeline: carry the existing workflow's tests forward as a **regression baseline** and augment them for the change-set's behavioral deltas. The output is a reviewable YAML handoff conforming to galaxy-workflow-test-plan, not a concrete `tests-format` file — implement-galaxy-workflow-test authors the final `*-tests.yml` from it. This skill is the update pipeline's analogue of nextflow-test-to-galaxy-test-plan / freeform-summary-to-galaxy-test-plan: the dedicated test-plan producer every Galaxy-targeting pipeline places before the implement step.

### Translate-and-augment, not synthesize-from-scratch

The starting point is real test evidence — the existing workflow's own `tests[]`, captured in summary-galaxy-workflow. Most of the plan is those cases carried forward, so its **dominant basis is test-evidence**: set `source.kind: galaxy` and `source.derived_from: test-evidence`. `source.derived_from` is the plan's dominant basis, not a "was anything mixed" flag — the carried-forward baseline dominates, so it reads `test-evidence` even though the plan also carries synthesized change-set cases. The mix shows through at the finer grains: baseline cases keep `test_cases[].derived_from: test-evidence` with `evidence: test-evidence` on their assertions, while change-set-driven cases carry `test_cases[].derived_from: intent` (or `mixed` when a carried-forward case gains a change-set-driven assertion) and their assertions carry `evidence: intent` (raise to `test-evidence` only where the change-set pinned a concrete expected value). `mixed` is valid only at the case level, never at `source.derived_from`. Unlike a freeform-synthesized plan, the baseline's workflow-label bindings are `label_status: resolved` — the summary read them off the concrete existing workflow, so they are known, not assumed.

### What the change-set drives

Walk the change-set and touch only the assertions its edits reach:

- **Behavior-changing edit → update the affected baseline case.** A `change-parameter`, `replace-tool`, or `add-step` that alters an existing output's content means the baseline assertion on that output is now wrong. Update it — tighten to the new expected value where the change-set gave one, or loosen it (e.g. presence/format where a content check no longer holds) and record the loosening in `omissions[]` with a rationale. **Never delete a baseline case to make it pass**; a regression that silently drops coverage is the failure mode this pipeline exists to avoid.
- **New observable behavior → a new assertion or case.** An `expose-output` / `add-output` needs a new `expected_outputs[]` entry asserting the promoted output; a new step whose result is observable needs assertion intent for it; a new `add-input` needs a `job_inputs[]` binding and a fixture. Bind change-set-added labels at `label_status: assumed` (the concrete labels settle downstream once the per-step loop resolves the step) and reconcile them in implement-galaxy-workflow-test.
- **Internal-only edit → no assertion change.** A `rewire`, `relabel`, or `remove-step` that does not change an observable output changes no assertions; carry the baseline through untouched.

### Scope discipline mirrors the change-set

Change only the assertions the change-set reaches. Do not add assertions for untouched regions beyond what the baseline already covers, and do not tidy or re-tolerance a baseline assertion no edit touched — the update pipeline's contract is that untouched behavior is verified exactly as before. Gratuitous churn in the plan propagates into gratuitous test churn downstream.

### Fixtures

Reuse the baseline's existing fixtures verbatim — they already ship with the workflow and are the regression data. Only a change-set that adds a workflow input needs new test data: record it with iwc-test-data-conventions (remote-URL-first, `storage: unresolved` with provenance when the input names data only by description), and leave resolution to the harness test-data step / find-test-data and implement-galaxy-workflow-test. When an added input's data cannot be settled here, add an `unresolved[]` entry (with `blocking: true` when the new case cannot be authored without it) rather than inventing a location.

Keep the plan addressable by stable labels and artifacts (planemo-workflow-test-architecture) so the downstream test, run, and debug skills can connect assertions back to invocations and outputs.

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
