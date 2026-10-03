---
type: Lesson
title: A successful run_tool response means queued, not finished
description: Single-tool submission returns at queue time and there is no invocation object to poll, so nothing prompts the second look before the result is reported.
tags: [job-states, polling, async, galaxy-api]
status: stable
generated: { by: "human:loom-maintainers", at: "2026-09-30" }
stale_after: "2027-03-31"
sources:
  - { id: "loom#210" }
  - { id: "loom#281" }
  - { id: "loom#293" }

kind: expectation
stage: [job-execution]
trigger:
  signatures: []
  tools: []
  mcp_tools: [galaxy_run_tool, galaxy_run_user_tool]
  formats: []
  hosts: []
  extensions: []
  step_keywords: ["run tool", "submit", "job", "complete", "done"]
cues: "About to report a tool run as done."
applies_to: { versions: "any", tested: "galaxy-mcp" }
evidence:
  symptom: verified
  cause: verified
  outcome: validated
  method: "the job was later found in an error state after the agent had reported success"
graduated_to: ["loom async job poller", "loom job-status hint"]
upstream: []
supersedes: []
---

## Symptom

The agent reports an analysis step complete; the job is still running or has since errored.

## Cause

Single-tool submission returns at queue time. Unlike a workflow invocation there is no invocation
object to poll, so nothing prompts a second look.

## Check first

Has the job reached a terminal state? `ok` is success; `error`, `failed` and `deleted` are not;
`paused` and `waiting` are not terminal.

## Intervention

Poll the job to a terminal state before building on its outputs or reporting it.

## Validate

Terminal `ok`, and the expected outputs exist and are non-empty.

## Does NOT apply when

Never. Caveat: reaching the job via an output dataset does not work for jobs with no outputs,
collection-only outputs, or map-over runs where one call makes many jobs.
