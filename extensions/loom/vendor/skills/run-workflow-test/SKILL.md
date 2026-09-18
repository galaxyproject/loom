---
name: run-workflow-test
description: "Execute a workflow's tests via Planemo; emit structured pass/fail and outputs."
---

# run-workflow-test

Follow the procedure below and use the artifact/reference sections as the runtime contract.

## When To Use

- Execute a workflow's tests via Planemo; emit structured pass/fail and outputs.

## Inputs

- No upstream artifact inputs declared. See the procedure for user-supplied runtime inputs.

## Outputs

- Write artifact `workflow-test-result` as `workflow-test-result.json`. Format: `json`. Structured status plus captured evidence — Planemo result, invocation/history/workflow ids, artifact paths, Galaxy mode, and (on failure) the observed modality and next reference surface — for debug-galaxy-workflow-output. Also the faithful handoff when no test exists or none could be run.

## Required Tools

- **`gxwf`** (gxwf). `npm install -g '@galaxy-tool-util/cli@^1.8.1'`.
  Ephemeral run: `npx --yes --package @galaxy-tool-util/cli@1.8.1 gxwf`.
  Check: `gxwf --help | grep -q draft-validate`.
  Docs: https://github.com/jmchilton/galaxy-tool-util-ts/tree/main/packages/cli
- **`planemo`** (planemo). `uv tool install planemo==0.75.47` (or `pip install planemo==0.75.47`).
  Ephemeral run: `uvx --from planemo==0.75.47 planemo`.
  Check: `planemo --version`.
  Docs: https://planemo.readthedocs.io/
  Bundled reference: `references/cli/planemo.md`.

## Load Upfront

- `references/cli/planemo.md`: CLI tool reference copied verbatim into the bundle. Runtime that executes the Galaxy or CWL workflow test; install before driving the harness.
- `references/schemas/tests-format.schema.json`: Schema file copied verbatim into the bundle. Validate Galaxy workflow test files before starting a Planemo or Galaxy-backed execution.

## Load On Demand

- `references/cli/validate-tests.json`: CLI command reference packaged as a sidecar. Run static schema and workflow-label checks before expensive workflow execution. Use when: before invoking Planemo when a Galaxy workflow test file is present.
- `references/notes/galaxy-workflow-invocation-failure-reference.md`: Research note copied verbatim into the bundle. Preserve invocation identifiers and state summaries needed to inspect workflow-level runtime failures after Planemo returns. Use when: planemo reports a failed, cancelled, missing-output, or ambiguous workflow invocation result.
- `references/notes/planemo-asserts-idioms.md`: Research note copied verbatim into the bundle. Interpret assertion failures and choose the right fast inner-loop command before full reruns. Use when: a workflow test file exists and the task is to run, iterate, or classify its test assertions.
- `references/notes/planemo-workflow-test-architecture.md`: Research note copied verbatim into the bundle. Run workflow tests while preserving Planemo structured artifacts, Galaxy mode, invocation id, history id, and API follow-up context. Use when: choosing between managed Galaxy, external Galaxy, full test runs, existing invocation checks, or direct workflow runs.

## Validation

- None declared.

## Procedure

Execute an assembled workflow's test file via planemo and emit a structured pass/fail with the artifacts a debug pass needs. One invocation runs the test once, captures the evidence, and — on failure — classifies the failure modality and names the next reference surface to inspect. It does not repair anything; that is debug-galaxy-workflow-output's job.

### Sequence

0. **Establish the test definition.** Locate the workflow's test file before anything else. If none can be found, do not abort: emit `workflow-test-result.json` with `status: test-definition-missing`, the paths searched, and the workflow it was searched for, then stop. Emit `status: not-run` plus a `not_run_reason` instead when a test exists but cannot be executed — a static validate-tests failure, missing test data, an unavailable Galaxy, an uninstallable tool, a timeout, or a checkout the caller has not confirmed as trusted. A downstream consumer needs to know that nothing ran; it must never have to infer it from a missing file.
1. **Validate before running.** When a test file is present, run validate-tests for the static schema and workflow-label checks first. A run is expensive; do not spend one on a test file that fails static validation.
2. **Pick the Galaxy mode.** Run against a Planemo-managed Galaxy or an existing/external Galaxy. **Planemo-managed** is the default and needs no pre-provisioned server: `planemo test` bootstraps its own Galaxy and installs the workflow's tools from the Tool Shed/conda — so the absence of a running Galaxy is not a reason to skip the run. Use an existing/external Galaxy only when you deliberately want to target one (shared instance, pre-installed heavy tools/reference data, specific credentials). The real cost of the managed path is install/runtime weight (large tools or multi-GB reference databases), which is a deliberate deferral, not an impossibility. Record which mode was used, how tools, workflows, and test data were staged, and the URLs or API credentials a follow-up inspection would need. The choice and its consequences are guided by planemo-workflow-test-architecture.
3. **Do not pin a Galaxy version.** Leave `--galaxy_branch` off the command unless the user or the harness supplied a specific branch, and never guess a `release_*` value — Planemo's default targets the newest Galaxy, which is the only version guaranteed to understand every construct a freshly authored workflow can contain. If a branch was supplied, record it in the output so a later failure can be read against it.
4. **Run and capture.** Drive `planemo test` with structured output enabled. Preserve the invocation id, history id, workflow id, the Planemo structured result, and any test-output artifact paths — these are the inputs the debug skill consumes.
5. **Classify on failure.** When the run exits non-zero or reports failed assertions, failed jobs, a failed invocation, missing outputs, or upload/staging problems, identify the observed failure modality and the single next reference surface to open: Planemo result, Galaxy job API, Galaxy invocation API, history contents, or the test assertion report. Use planemo-asserts-idioms to read assertion failures and galaxy-workflow-invocation-failure-reference to preserve invocation identifiers and state.
6. **Hand off.** Emit the structured summary carrying a `status` from the closed set `pass | fail | test-definition-missing | not-run` — green, or red with modality + captured artifacts + the named next surface — for debug-galaxy-workflow-output. A `test-definition-missing` or `not-run` result is never reported as a pass and never as a Planemo failure: neither carries a failure modality or a next reference surface, because nothing ran. A consumer must read those two states as *no runtime evidence*, not as a debug target.

Keep this skill's output a faithful record of what happened, not a diagnosis. Mislabeling a staging failure as an assertion failure here sends the debug pass to the wrong reference surface.

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
