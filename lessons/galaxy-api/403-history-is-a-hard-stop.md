---
type: Lesson
title: '"History is not accessible by user" means there is no data to reason from'
description: A 403 on the bound history means nothing about the job was ever read, so any explanation of the failure after that point is invented.
tags: [permissions, history, fabrication, galaxy-api]
status: stable
generated: { by: "human:loom-maintainers", at: "2026-09-30" }
stale_after: "2027-03-31"
sources:
  - { id: "loom#367" }

kind: expectation
stage: [job-execution, result-interpretation]
trigger:
  signatures: ["History is not accessible by user"]
  tools: []
  mcp_tools: [galaxy_get_history_contents]
  formats: []
  hosts: []
  extensions: []
  step_keywords: ["history", "why did it fail", "job failure"]
cues: "A resumed notebook is bound to a history that the current credentials do not own."
applies_to: { versions: "any", tested: "resumed notebook bound to a history owned by another account" }
evidence:
  symptom: verified
  cause: verified
  outcome: unvalidated
  method: "transcript: a 403 followed by a fabricated explanation of a job failure"
graduated_to: ["loom system prompt no-fabrication rule plus evals"]
upstream: []
supersedes: []
---

## Symptom

Asked why a job failed, the agent gets a 403 on the history and answers anyway.

## Cause

The notebook's bound history belongs to a different account or server than the current
credentials. Nothing about the job was ever read.

## Check first

Which account are the current credentials for? Is the bound history in that account's list?

## Intervention

Report the access failure. Offer to look in the user's own recent histories instead.

## Validate

Any explanation of a failure cites a job or dataset that was actually retrieved.

## Does NOT apply when

Never; a 403 is always a hard stop for reasoning about that history.
