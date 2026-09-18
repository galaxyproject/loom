---
type: research
title: "Planemo workflow-test architecture"
tags:
  - tool/planemo
  - target/galaxy
status: draft
created: 2026-05-02
revised: 2026-05-11
revision: 3
related_notes:
  - "galaxy-workflow-testability-design"
  - "galaxy-tool-job-failure-reference"
  - "galaxy-workflow-invocation-failure-reference"
  - "planemo-asserts-idioms"
related_molds:
  - "run-workflow-test"
  - "debug-galaxy-workflow-output"
  - "implement-galaxy-workflow-test"
sources:
  - "https://github.com/galaxyproject/planemo/blob/master/planemo/commands/cmd_test.py"
  - "https://github.com/galaxyproject/planemo/blob/master/planemo/commands/cmd_run.py"
  - "https://github.com/galaxyproject/planemo/blob/master/planemo/galaxy/activity.py"
  - "https://github.com/galaxyproject/planemo/blob/master/planemo/galaxy/invocations"
  - "https://github.com/galaxyproject/planemo/blob/master/planemo/galaxy/config.py"
summary: "Reference for Planemo workflow test/run architecture, Galaxy modes, API polling, and noisy failure boundaries."
---

# Planemo Workflow-Test Architecture

This note describes Planemo architecture relevant to workflow tests and workflow runs. It is reference material for Molds that need to run tests or interpret Planemo artifacts, not a command-selection recipe.

## Main Commands

| User action | Command | Core behavior |
|---|---|---|
| Full workflow test | `planemo test <workflow>` (planemo-test) | Finds test definitions, starts or targets Galaxy, stages inputs, invokes workflow, checks assertions, writes reports. |
| Direct run | `planemo run <workflow> <job.yml>` | Runs one workflow/job pair and can download outputs without assertion checks. |
| Recheck assertions | `planemo workflow_test_on_invocation <tests.yml> <invocation_id>` (planemo-workflow_test_on_invocation) | Runs test assertions against an existing invocation without rerunning the workflow. |
| Track invocation | `planemo workflow_track <invocation_id>` | Polls an existing invocation and displays progress. |
| Generate test from invocation | `planemo workflow_test_init --from_invocation <id>` (planemo-workflow_test_init) | Builds a test template from a completed invocation and its outputs. |
| Generate job template | `planemo workflow_job_init <workflow>` | Creates a job-input template for a workflow. |

Observed code paths live under `https://github.com/galaxyproject/planemo/blob/master/planemo/commands/`, `planemo/engine/`, and `planemo/galaxy/`.

## Engine Selection

Planemo chooses between engines early:

- CWL runnables can use CWL-specific engines.
- Supplying `--galaxy_url` implies an external running Galaxy unless an engine is explicitly selected.
- Default Galaxy workflow testing uses a managed local Galaxy engine.
- `--engine docker_galaxy` uses a managed Dockerized Galaxy.
- `--engine external_galaxy` uses an existing running Galaxy.

“Existing Galaxy” can mean two different things:

- Existing local Galaxy source tree, still managed by Planemo for this run.
- Existing running Galaxy server, addressed through URL and API keys.

Mold output and eval logs should record which meaning applies.

## Managed Galaxy Configuration

For managed Galaxy, Planemo builds a temporary configuration directory and generated Galaxy config. It can configure tool config, shed tool config, job config, file sources, object store paths, dependency config, SQLite database by default, admin users, API keys, and environment overrides.

Important managed-mode behavior:

- Planemo may find a local Galaxy root or install/use a cached Galaxy source tree.
- `--galaxy_branch` selects which Galaxy branch is cloned when no Galaxy root is supplied; it defaults to `master`. Omitting it therefore tests against the newest Galaxy. Naming an older `release_*` branch narrows what workflow syntax Galaxy will accept, and the resulting rejection surfaces as an invocation-time error rather than as a version mismatch.
- Managed Galaxy defaults are convenient but may not match production Galaxy behavior.
- Planemo can install workflow tool dependencies through Tool Shed metadata when configured.
- Test histories are created automatically unless a history id is supplied.

## External Galaxy Configuration

For external Galaxy, Planemo uses supplied Galaxy URL and API keys. A user key runs workflows; an admin key may be needed for installing missing repositories or creating a user key.

External Galaxy mode is useful when the target environment matters, but failure surfaces can include server configuration, installed tools, permissions, and existing history state. Eval logs should preserve URL/key mode without storing secrets.

## API Interaction

Planemo primarily talks to Galaxy through BioBlend-backed clients.

Important operations:

- Import workflows into Galaxy.
- Stage datasets and collections into histories.
- Invoke workflows by input names.
- Poll invocations and jobs.
- Fetch job details with full detail when needed.
- Download outputs and output collections.
- Run assertion checks and write structured reports.

For workflows, Planemo invokes Galaxy using input labels/names. Stable generated labels are therefore important for both test execution and debugging.

Workflow testability design guidance lives in galaxy-workflow-testability-design. This architecture note only records why Planemo makes labels and workflow-level outputs operationally important.

## Structured Artifacts

Useful Planemo artifacts and fields:

| Artifact or field | Use |
|---|---|
| `tool_test_output.json` | Primary structured result artifact for tests. |
| invocation id | Key for Galaxy invocation API follow-up. |
| history id | Key for history contents and output inspection. |
| workflow id | Key for workflow invocation aliases and reruns. |
| output problems | Assertion and missing-output failures. |
| execution problem | Staging, invocation, API, or other execution-level failure. |
| invocation details | Step/job/output details Planemo collected from Galaxy. |
| job details | Tool id, state, exit code, command, stdout/stderr when collected. |

Terminal output is not enough for durable failure analysis. Preserve structured output whenever possible.

## Noisy Boundaries

Planemo transforms and summarizes Galaxy failure information. These are likely information-loss boundaries:

- Exceptions during execution can become stringified `ErrorRunResponse` values.
- Polling may summarize “at least one job is in error” while detailed job evidence is printed elsewhere or stored separately.
- Missing outputs become assertion/output problems, which can conflate label mismatch, workflow output omission, optional output absence, failed invocation, or output download issue.
- Output download failures may be logged but not always propagated as the most specific failure.
- External Galaxy without an admin key may defer missing-tool problems until runtime.
- `allow_tool_state_corrections=True` can let Galaxy adjust tool state during invocation, which is useful but can mask definition drift.
- `--no_wait` is not suitable for debug conclusions because invocation creation can succeed before jobs fail.

## Reference Use For Molds

For run-workflow-test:

- Preserve structured Planemo result output, invocation id, history id, workflow id, and Galaxy mode.
- Record whether the run used managed local Galaxy, Docker Galaxy, or external Galaxy.
- Do not treat terminal output as the primary failure artifact.

For debug-galaxy-workflow-output:

- Start from structured Planemo output.
- For missing-output failures, check label drift and omitted workflow-level outputs before assuming tool failure.
- If the failure is job-level, inspect Galaxy job APIs described in galaxy-tool-job-failure-reference.
- If the failure is invocation-level, inspect Galaxy invocation APIs described in galaxy-workflow-invocation-failure-reference.
- If only assertions failed, use planemo-asserts-idioms before deciding to rerun.

## Verification Gaps

Actual runs should verify:

- Which invocation messages Planemo exposes directly.
- Whether target Planemo/Galaxy versions populate `completed`, `/completion`, and step job summaries.
- How `workflow_test_on_invocation` behaves for failed, warning-only, mapped collection, and subworkflow invocations.
- Whether generated test cases from invocation preserve nested output collection structure correctly.
