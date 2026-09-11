---
type: research
title: "Galaxy workflow invocation failure reference"
tags:
  - target/galaxy
status: draft
created: 2026-05-02
revised: 2026-05-02
revision: 1
ai_generated: true
related_notes:
  - "galaxy-tool-job-failure-reference"
  - "planemo-workflow-test-architecture"
  - "galaxy-collection-semantics"
related_molds:
  - "run-workflow-test"
  - "debug-galaxy-workflow-output"
  - "validate-galaxy-workflow"
sources:
  - "https://github.com/galaxyproject/galaxy/blob/dev/lib/galaxy/schema/invocation.py"
  - "https://github.com/galaxyproject/galaxy/blob/dev/lib/galaxy/workflow/run.py"
  - "https://github.com/galaxyproject/galaxy/blob/dev/lib/galaxy/workflow/modules.py"
  - "https://github.com/galaxyproject/galaxy/blob/dev/lib/galaxy/webapps/galaxy/api/workflows.py"
summary: "Reference for Galaxy workflow invocation states, messages, failure reasons, and invocation API surfaces."
---

# Galaxy Workflow Invocation Failure Reference

This note describes workflow-level failure surfaces in Galaxy. It is separate from galaxy-tool-job-failure-reference because invocation state answers whether Galaxy could schedule and drive the workflow, while job state answers whether individual tool jobs succeeded.

## Invocation Versus Job Failure

Important distinction:

- Invocation state says whether Galaxy scheduled, cancelled, failed, or completed the workflow invocation.
- Job state says whether jobs produced by invocation steps succeeded or failed.
- Invocation messages explain scheduler/evaluation/cancellation problems.
- Step states usually describe scheduling progress, not actual job success, unless a legacy serialization mode substitutes job state.

A robust workflow test reference should inspect both invocation APIs and job APIs.

## Invocation States

Galaxy invocation states are defined in `https://github.com/galaxyproject/galaxy/blob/dev/lib/galaxy/schema/invocation.py` and related model code.

| State | Meaning |
|---|---|
| `new` | Newly created invocation. |
| `requires_materialization` | Deferred or undeferred inputs must materialize before scheduling can continue. |
| `ready` | Ready for another scheduler iteration. |
| `scheduled` | Workflow has been scheduled. Older clients may treat this as successful terminal state. |
| `cancelling` | Scheduler will cancel jobs and subworkflow invocations. |
| `cancelled` | Cancellation terminal state. |
| `failed` | Scheduler/evaluation/materialization failure terminal state. |
| `completed` | Newer completion state after all jobs reach terminal states. |

Version caveat: `completed` may not be uniformly available across all Galaxy/Planemo combinations. Planemo accounts for both `scheduled` and `completed` as success-like invocation states.

## Invocation Message Reasons

Structured invocation messages are the main durable surface for workflow-level failures.

| Reason | Typical meaning |
|---|---|
| `dataset_failed` | Dataset input or upstream dataset was failed/unusable. |
| `collection_failed` | Collection was failed, incompletely populated, or unusable. |
| `job_failed` | Upstream dependent job failed. |
| `output_not_found` | Expected step/subworkflow output could not be resolved. |
| `expression_evaluation_failed` | Workflow expression or condition evaluation failed. |
| `when_not_boolean` | Conditional `when` expression did not return a boolean. |
| `unexpected_failure` | Scheduler or evaluation failure without a more specific safe reason. |
| `workflow_parameter_invalid` | Workflow parameter validation failed. |
| `step_input_deleted` | Step input dataset/collection was deleted. |
| `history_deleted` | Invocation history was deleted, causing cancellation. |
| `user_request` | User/API cancellation. |
| `cancelled_on_review` | Pause/review step rejected continuation. |
| `workflow_output_not_found` | Warning: declared workflow output was not found. |

Message records can include affected workflow step id, dependent step id, job id, HDA/HDCA ids, output name, and nested workflow step index path. These fields matter more than free-text messages for reference-quality diagnosis.

## Common Workflow-Level Failure Surfaces

| Surface | Reference signal |
|---|---|
| Request-time validation | API returns an error before useful invocation state exists. |
| Input materialization | Invocation enters `requires_materialization`, then may fail with `dataset_failed`. |
| Conditional evaluation | Invocation messages include `expression_evaluation_failed` or `when_not_boolean`. |
| Missing output graph edge | Invocation messages include `output_not_found`. |
| Deleted/purged inputs | Invocation messages include `step_input_deleted` or `dataset_failed`. |
| Upstream job failure | Invocation messages or summaries point to `job_failed`; job API has details. |
| Collection population failure | Invocation messages include `collection_failed`; inspect HDCA and mapped jobs. |
| Pause/review rejection | Cancellation reason `cancelled_on_review`. |
| User/history cancellation | Cancellation messages `user_request` or `history_deleted`. |
| Warning-only missing output | `workflow_output_not_found` warning; may later become Planemo assertion failure. |

## API Surfaces

Useful invocation APIs from `https://github.com/galaxyproject/galaxy/blob/dev/lib/galaxy/webapps/galaxy/api/workflows.py`:

| API | Use |
|---|---|
| `GET /api/invocations/{invocation_id}` | Invocation state, messages, inputs, outputs, and steps. |
| `GET /api/invocations/{invocation_id}?step_details=true` | Richer step detail, jobs, outputs, and output collections. |
| `GET /api/invocations/steps/{step_id}` | Detail for one invocation step. |
| `GET /api/invocations/{invocation_id}/steps/{step_id}` | Step detail scoped to invocation. |
| `GET /api/invocations/{invocation_id}/jobs_summary` | Job state summary across the invocation. |
| `GET /api/invocations/{invocation_id}/step_jobs_summary` | Job state summary per workflow invocation step. |
| `GET /api/invocations/{invocation_id}/completion` | Completion record, if available. |
| `DELETE /api/invocations/{invocation_id}` | Cancel invocation. |
| `PUT /api/invocations/{invocation_id}/steps/{step_id}` | Continue or cancel pause/review step. |
| `GET /api/invocations/{invocation_id}/report` | Invocation report surface. |

Workflow aliases under `/api/workflows/{workflow_id}/invocations/...` also exist.

## Planemo Caveats

Planemo polls invocation and job state, but its user-facing output may not expose all structured invocation messages. Treat Planemo terminal output as a summary; use raw invocation and job APIs when the failure class matters.

Likely noisy boundaries:

- Planemo may show failed job details but omit structured invocation messages.
- `step_jobs_summary` is useful in Galaxy but not necessarily surfaced directly by Planemo output.
- Subworkflow paths can be represented in Galaxy message fields but may not be displayed by Planemo.
- A workflow can be `completed` or `scheduled` while one or more jobs failed; job summaries must still be inspected.

## Durable Reference Use

Use this note when a workflow run fails before or around job scheduling, when outputs are missing without an obvious tool stderr cause, or when Planemo only reports a generic invocation failure.

The goal is not to prescribe a single repair loop. The goal is to preserve which Galaxy API surface proves the failure mode so later Molds can decide whether the defect belongs to data-flow, template, concrete step implementation, workflow test assertions, or runtime environment.

## Verification Gaps

Actual runs should verify:

- Whether Planemo surfaces invocation `messages` for each reason.
- Whether `completed` and `/completion` are populated in the target Galaxy used by tests.
- How mapped collections and subworkflow failures appear in `step_jobs_summary`.
- How warning-only `workflow_output_not_found` interacts with Planemo assertions.
