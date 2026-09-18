---
name: debug-galaxy-workflow-output
description: "Triage failing Galaxy run outputs; classify the failure surface and capture evidence before recommending repairs."
---

# debug-galaxy-workflow-output

Follow the procedure below and use the artifact/reference sections as the runtime contract.

## When To Use

- Triage failing Galaxy run outputs; classify the failure surface and capture evidence before recommending repairs.

## Inputs

- Read artifact `workflow-test-result`. Produced by `run-workflow-test`. Structured run handoff from run-workflow-test: Planemo result, invocation/job/artifact context, and the observed failure modality.

## Outputs

- Write artifact `workflow-debug-report` as `workflow-debug-report.md`. Format: `markdown`. Failure-surface classification with captured job/invocation/collection/assertion evidence and a recommended next step or reference-gap follow-up.

## Required Tools

- None declared. Procedure should not assume external CLIs are present.

## Load Upfront

- None declared.

## Load On Demand

- `references/notes/galaxy-collection-semantics.md`: Research note copied verbatim into the bundle. Diagnose collection shape, mapping, reduction, and element-identifier mismatches in failed Galaxy runs. Use when: a failing output is a collection, a mapped output, or an unexpectedly nested/flattened structure.
- `references/notes/galaxy-collection-semantics.yml`: Companion file copied verbatim into the bundle. Sibling of `references/notes/galaxy-collection-semantics.md`; read it where that note directs.
- `references/notes/galaxy-tool-job-failure-reference.md`: Research note copied verbatim into the bundle. Interpret Galaxy job-level failure evidence including stdio rules, exit code, job messages, and output dataset state. Use when: a failed workflow test includes errored jobs, tool stderr/stdout, non-zero exit codes, or red output datasets.
- `references/notes/galaxy-workflow-invocation-failure-reference.md`: Research note copied verbatim into the bundle. Interpret Galaxy invocation-level failure evidence including invocation state, structured messages, and step job summaries. Use when: a failed workflow test has invocation failure, missing workflow outputs, cancelled/paused steps, subworkflow failures, or collection population errors.
- `references/notes/iwc-shortcuts-anti-patterns.md`: Research note copied verbatim into the bundle. Decide whether a proposed debug fix aligns with accepted IWC testing shortcuts or masks a real failure. Use when: debugging suggests weakening assertions, widening deltas, switching to existence checks, or changing output labels.
- `references/notes/nextflow-operators-to-galaxy-collection-recipes.md`: Research note copied verbatim into the bundle. Trace collection output failures back to possibly lossy operator translations. Use when: debugging wrong nesting, missing elements, branch merges, bad joins, or gather/reduction mismatches.
- `references/notes/planemo-asserts-idioms.md`: Research note copied verbatim into the bundle. Classify whether a failure is an assertion-choice problem, tolerance problem, or real workflow-output regression. Use when: planemo reports output assertion failures or generated tests are too strict/too weak.
- `references/notes/planemo-workflow-test-architecture.md`: Research note copied verbatim into the bundle. Locate which Planemo artifact or Galaxy API surface preserves the failure evidence. Use when: planemo output is ambiguous, structured test JSON is available, or rerunning can be avoided by inspecting an existing invocation.

## Validation

- None declared.

## Procedure

Triage a failing Galaxy workflow test. Take the structured handoff from run-workflow-test, classify the failure surface before proposing any repair, and capture the reference evidence the surface requires. When the failure cannot be classified from existing references, recommend a focused follow-up rather than converting uncertainty into a guessed fix.

Classify before repairing. The same red output can be a tool/job failure, a workflow invocation failure, a collection-output mismatch, a missing workflow output, or an assertion mismatch — and each routes to a different reference surface and a different fix. Locate where the evidence lives first (planemo-workflow-test-architecture).

### Sequence

1. **Classify the first failure surface.** From the run's structured result, decide whether the first failure is a tool/job failure, a workflow invocation failure, a collection-output mismatch, a missing workflow output, or an assertion mismatch. Classify before proposing repairs.
2. **Capture job-failure evidence.** When a job is in `error`/`failed`/`stopped`, record job id, tool id, exit code, job messages, the stdout/stderr distinction, and output dataset state per galaxy-tool-job-failure-reference; check whether the wrapper's failure semantics already explain it.
3. **Capture invocation-failure evidence.** When the invocation state or messages indicate scheduling, materialization, cancellation, conditional, or output-resolution failure, record invocation state, the structured message reason, the affected step, any subworkflow path, and the jobs summary per galaxy-workflow-invocation-failure-reference; note whether Planemo surfaced or hid the relevant Galaxy API detail.
4. **Trace collection mismatches.** When a failing output is a collection or mapped output, diagnose shape, mapping, reduction, and element-identifier mismatches with galaxy-collection-semantics; for workflows translated from Nextflow, trace wrong nesting / missing elements / bad joins back to possibly-lossy operator translations via nextflow-operators-to-galaxy-collection-recipes.
5. **Read assertion failures honestly.** When the failure is an assertion, use planemo-asserts-idioms to decide whether it is an assertion-choice/tolerance problem or a real output regression. Before weakening an assertion, widening a delta, or switching to an existence check, confirm against iwc-shortcuts-anti-patterns that the relaxation is an accepted IWC shortcut and not masking a real failure.
6. **Discover reference gaps.** When the failure cannot be classified confidently from the references above, recommend a focused follow-up — reference documentation, pattern capture, API verification, or eval coverage — rather than emitting a repair recipe built on a guess.

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
