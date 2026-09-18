---
name: validate-galaxy-workflow
description: "Run terminal gxwf validation on an assembled Galaxy workflow and classify workflow-level failures."
---

# validate-galaxy-workflow

Follow the procedure below and use the artifact/reference sections as the runtime contract.

## When To Use

- Run terminal gxwf validation on an assembled Galaxy workflow and classify workflow-level failures.

## Inputs

- No upstream artifact inputs declared. See the procedure for user-supplied runtime inputs.

## Outputs

- Write artifact `galaxy-workflow-validation-result` as `galaxy-workflow-validation-result.json`. Format: `json`. Terminal gxwf validation handoff: the exact command run, a pass/fail/not-run status, the classified workflow-level diagnostics, and the residual runtime risks static validation cannot settle.

## Required Tools

- **`gxwf`** (gxwf). `npm install -g '@galaxy-tool-util/cli@^1.8.1'`.
  Ephemeral run: `npx --yes --package @galaxy-tool-util/cli@1.8.1 gxwf`.
  Check: `gxwf --help | grep -q draft-validate`.
  Docs: https://github.com/jmchilton/galaxy-tool-util-ts/tree/main/packages/cli

## Load Upfront

- None declared.

## Load On Demand

- `references/cli/validate.json`: CLI command reference packaged as a sidecar. Validate the assembled gxformat2 workflow before runtime testing. Use when: after all Galaxy steps and workflow tests have been assembled.
- `references/notes/galaxy-workflow-invocation-failure-reference.md`: Research note copied verbatim into the bundle. Keep static workflow validation findings distinct from Galaxy invocation/runtime failure surfaces. Use when: a workflow passes gxwf validation but still has likely runtime risks around invocation scheduling, outputs, conditionals, or collection population.
- `references/notes/galaxy-workflow-testability-design.md`: Research note copied verbatim into the bundle. Classify validation or pre-test findings that indicate missing labels, omitted workflow outputs, or untestable checkpoint structure. Use when: terminal validation passes but workflow-level outputs, labels, or collection shapes look likely to break future workflow tests.

## Validation

- None declared.

## Procedure

Validate the assembled Galaxy workflow before runtime testing. The skill owns the terminal validation pass: run gxwf validate, classify workflow-level diagnostics, and route failures back to the responsible authoring phase when possible.

This is separate from advance-galaxy-draft-step (which runs `gxwf draft-validate --concrete` inside the per-step loop) because terminal validation no longer has only one fresh step in scope and should reason over cross-step workflow structure.

### Emit the result

Write `galaxy-workflow-validation-result.json` on every run — clean or failing — so a downstream reviewer can cite what was actually checked rather than re-deriving it:

- `command` — the exact gxwf validate invocation, including flags (prefer `--json`);
- `workflow_path` — the file validated;
- `status` — `pass`, `fail`, or `not-run`, with a `not_run_reason` whenever validation could not execute;
- `diagnostics[]` — one entry per finding: severity, message, the step or field it addresses, and the authoring phase it routes back to;
- `residual_runtime_risks[]` — for a clean run, the risks static validation cannot settle and the runtime artifact that would prove or disprove each.

A `not-run` status is never reported as a pass.

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
