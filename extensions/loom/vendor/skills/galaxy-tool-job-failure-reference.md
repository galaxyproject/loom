---
type: research
title: "Galaxy tool and job failure reference"
tags:
  - target/galaxy
status: draft
created: 2026-05-02
revised: 2026-05-02
revision: 1
ai_generated: true
related_notes:
  - "galaxy-workflow-invocation-failure-reference"
  - "planemo-workflow-test-architecture"
  - "galaxy-collection-semantics"
related_molds:
  - "implement-galaxy-tool-step"
  - "debug-galaxy-workflow-output"
sources:
  - "https://github.com/galaxyproject/galaxy/blob/dev/lib/galaxy/tools/__init__.py"
  - "https://github.com/galaxyproject/galaxy/blob/dev/lib/galaxy/tool_util/parser/xml.py"
  - "https://github.com/galaxyproject/galaxy/blob/dev/lib/galaxy/tool_util/output_checker.py"
  - "https://github.com/galaxyproject/galaxy/blob/dev/lib/galaxy/jobs"
  - "https://github.com/galaxyproject/galaxy/blob/dev/lib/galaxy/webapps/galaxy/api/jobs.py"
summary: "Reference for Galaxy tool stdio rules, job failure detection, job states, and job API failure surfaces."
---

# Galaxy Tool And Job Failure Reference

This is reference material, not a debug recipe. Use it to understand what Galaxy can know about a failed tool job and which API surfaces preserve that evidence.

## Model

Galaxy tool failure handling is layered:

- The tool wrapper defines expected failure semantics through `detect_errors`, `<stdio>`, exit-code checks, regex checks, and command strictness.
- The job runner executes the command and captures exit code plus tool/job stdout and stderr streams.
- Galaxy evaluates configured failure rules and records structured `job_messages`.
- The job reaches a terminal state, output datasets may become `error`, and dependent jobs may pause or fail later.
- Workflow invocation APIs summarize those jobs, but job APIs preserve the most detailed tool-level evidence.

## Tool Wrapper Failure Controls

Important wrapper controls:

| Control | Meaning |
|---|---|
| `detect_errors="default"` | For non-legacy XML tools without explicit `<stdio>`, Galaxy defaults to non-zero exit-code failure detection. |
| `detect_errors="exit_code"` | Adds fatal checks for non-zero exit codes, plus optional OOM exit-code handling. |
| `detect_errors="aggressive"` | Adds non-zero exit-code checks plus broad stdout/stderr regexes for OOM and generic error text. |
| `<stdio><exit_code ... /></stdio>` | Adds explicit exit-code ranges or values with levels such as `fatal`, `warning`, or `fatal_oom`. |
| `<stdio><regex ... /></stdio>` | Adds case-insensitive stdout/stderr regex checks. |
| `<command strict="...">` | Controls shell strictness; newer tool profiles default to `set -e` behavior. |

Current Galaxy source parses these rules while loading the tool, then stores exit-code and regex rules on the tool object. XML parser behavior lives under `https://github.com/galaxyproject/galaxy/blob/dev/lib/galaxy/tool_util/parser/xml.py`; concrete stdio presets live under `https://github.com/galaxyproject/galaxy/blob/dev/lib/galaxy/tool_util/parser/stdio.py`.

## Rule Ordering And Levels

Galaxy evaluates explicit and preset rules in a defined order:

- Exit-code rules are evaluated before regex rules.
- Regexes search stdout and/or stderr case-insensitively.
- A fatal rule stops later checks.
- Warnings, log messages, and QC messages can produce `job_messages` without failing the job.

Useful levels:

| Level | Effect |
|---|---|
| `log` | Records informational message; does not fail the job. |
| `qc` | Records QC message; does not fail the job. |
| `warning` | Records warning; does not fail the job. |
| `fatal` | Fails the job as a generic tool error. |
| `fatal_oom` | Fails as out-of-memory; runner behavior can use this for OOM handling/resubmission. |

Low-confidence caveat: OOM resubmission behavior is runner/destination configuration dependent. The wrapper and output checker can classify OOM, but retry policy is not solely a wrapper property.

## Job And Dataset States

Job states relevant to workflow tests include:

- In progress or queued: `new`, `queued`, `running`, `waiting`, `upload`, `resubmitted`.
- Success: `ok`.
- Failure or terminal problem: `error`, `failed`, `paused`, `stopped`, `deleted`, `skipped` depending context.

Dataset states relevant to downstream failures include `ok`, `error`, `paused`, `failed_metadata`, `deferred`, and `discarded`.

For workflow debugging, do not collapse job state and dataset state. A job can fail, its outputs can become error datasets, and a downstream workflow step can later fail because it consumes those datasets.

## Stream And Message Fields

Galaxy distinguishes tool streams from job/runner streams:

| Field | Meaning |
|---|---|
| `tool_stdout` | stdout from the executed tool command. |
| `tool_stderr` | stderr from the executed tool command. |
| `job_stdout` | stdout from job wrapper/runner context. |
| `job_stderr` | stderr from job wrapper/runner context. |
| `stdout` | Combined stdout compatibility view. |
| `stderr` | Combined stderr compatibility view. |
| `job_messages` | Structured failure/warning messages produced by stdio and output checking. |
| `exit_code` | Process exit code observed by the runner. |

Prefer `job_messages` plus separate streams for reference-quality failure interpretation. Combined `stdout` and `stderr` are useful for humans but lose provenance.

## API Surfaces

Useful job APIs from Galaxy source under `https://github.com/galaxyproject/galaxy/blob/dev/lib/galaxy/webapps/galaxy/api/jobs.py`:

| API | Use |
|---|---|
| `GET /api/jobs` | Filter jobs by state, tool id, workflow id, invocation id, history id, etc. |
| `GET /api/jobs/{job_id}` | Basic job detail. |
| `GET /api/jobs/{job_id}?full=true` | Full job detail, including streams and `job_messages`. |
| `GET /api/jobs/{job_id}/stdout` | Combined stdout as plain text. |
| `GET /api/jobs/{job_id}/stderr` | Combined stderr as plain text. |
| `GET /api/jobs/{job_id}/console_output` | Live or stored tool stdout/stderr, useful while a job is running. |
| `GET /api/jobs/{job_id}/inputs` | Input datasets for the job. |
| `GET /api/jobs/{job_id}/outputs` | Output datasets and output collections. |
| `GET /api/jobs/{job_id}/metrics` | Job metrics, if available. |
| `GET /api/jobs/{job_id}/common_problems` | Known simple problems such as empty or duplicate inputs. |

Admin-only or admin-enriched fields can include command line, traceback, destination, runner, handler, external id, and destination parameters. Do not assume a normal workflow-testing API key can retrieve everything.

## Durable Reference Use

This note should inform generated skills when they need to preserve or inspect tool-level failure evidence:

- A concrete workflow step should preserve tool id, version, input labels, output labels, datatype and collection shape so a later job failure can be traced back to the authoring decision.
- A runtime failure should not be classified from stderr alone if `job_messages`, exit code, and wrapper stdio rules are available.
- A workflow invocation failure may be caused by an upstream job, but invocation APIs are not a substitute for full job detail.

## Low-Confidence Or Version-Sensitive Points

- Tool profile defaults changed over time. Prefer current Galaxy source and wrapper profile over old generic rules.
- Some docs describe failure messages as stream text; current code preserves structured `job_messages` separately.
- OOM handling depends on job runner and destination configuration.
- Planemo may print or summarize job detail differently from raw Galaxy APIs; see planemo-workflow-test-architecture.
