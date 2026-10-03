---
type: Lesson
title: 'Workflow input values, scalars included, go in `inputs`; `params` only overrides tool steps'
description: A validation error pointing into parameters means the value is in the wrong slot, not under the wrong key, and retrying key forms is the trap that follows.
tags: [workflows, invoke, inputs, galaxy-api]
status: stable
generated: { by: "human:loom-maintainers", at: "2026-09-30" }
stale_after: "2027-03-31"
sources:
  - { id: "loom#392" }

kind: pitfall
stage: [tool-parameterization]
trigger:
  signatures: ["Input should be a valid dictionary"]
  tools: []
  mcp_tools: [galaxy_invoke_workflow]
  formats: []
  hosts: []
  extensions: []
  step_keywords: ["invoke", "workflow", "inputs", "params", "input template"]
cues: "A workflow invocation is being retried with different key forms for the same value."
applies_to: { versions: "unknown", tested: "galaxy-mcp invoke_workflow against a multi-sample IWC workflow" }
evidence:
  symptom: verified
  cause: hypothesized
  outcome: validated
  method: "the same values succeeded first try when moved to inputs per the input template"
graduated_to: ["galaxy-mcp get_workflow_input_template plus invoke_workflow preflight"]
upstream: ["galaxy-mcp#55"]
supersedes: []
---

## Symptom

Invocation rejected with a validation error pointing into `parameters`. Observed: a model retried
two dozen times varying the key -- label, step index, uuid -- while the real problem was the slot.

## Cause

Inferred, not checked against Galaxy source: every workflow input -- datasets, collections and
scalar parameter inputs alike -- belongs in `inputs`. `params` overrides tool parameters on
non-input steps and its values are dicts.

## Check first

Was the workflow input template fetched? Does the failing payload put a scalar under `params`?

## Intervention

Fetch the input template and fill it in as returned. Do not retry with a different key form; if the
second attempt fails the same way, stop and re-read the template.

## Validate

The invocation is accepted and its recorded inputs match what was intended.

## Does NOT apply when

You really are overriding a tool step's parameter -- then `params` with a dict value is right.
