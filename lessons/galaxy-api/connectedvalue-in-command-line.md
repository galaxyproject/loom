---
type: Lesson
title: '"ConnectedValue object at 0x" in a command line means an optional workflow parameter was left unset'
description: Older Galaxy serialized the placeholder object's repr into the command line when a connected optional parameter_input had no value, so the step can fail or silently succeed wrong.
tags: [workflows, parameter-input, command-line, galaxy-api]
status: stable
generated: { by: "human:loom-maintainers", at: "2026-09-30" }
stale_after: "2027-03-31"
sources:
  - { id: "loom#186" }
  - { id: "galaxy#21994" }

kind: pitfall
stage: [tool-parameterization, job-execution]
trigger:
  signatures: ["workflow_utils.ConnectedValue object at 0x"]
  tools: []
  mcp_tools: [galaxy_invoke_workflow]
  formats: []
  hosts: []
  extensions: []
  step_keywords: ["workflow", "parameter input", "optional parameter", "invoke"]
cues: "A workflow with optional parameter inputs is invoked against a server older than the upstream fix."
applies_to: { versions: "Galaxy older than 25.1.2; fixed upstream", tested: "fastp inside an invoked workflow" }
evidence:
  symptom: verified
  cause: verified
  outcome: unvalidated
  method: "the error string was quoted from the failing job and the upstream fix was identified"
graduated_to: ["galaxy-skills galaxy-mcp-reference gotchas note"]
upstream: ["galaxy#21994"]
supersedes: []
---

## Symptom

A workflow step fails, or worse succeeds, with a tool argument containing the text
`...ConnectedValue object at 0x...`. With fastp it surfaced as an invalid adapter sequence.

## Cause

An optional `parameter_input` workflow step was connected but given no value; older Galaxy
serialized the placeholder object's repr into the command line.

## Check first

Does the workflow have optional parameter inputs, per the workflow details? Is the server older
than the fix? Inspect the failed job's command line for the signature.

## Intervention

Pass an explicit empty value for every optional parameter input on invocation.

## Validate

Re-inspect the command line of the rerun job: the signature is gone AND the argument is absent or
empty, not replaced by some other junk.

## Does NOT apply when

The server has the upstream fix. Keep the lesson and narrow the version range -- older installs
still need it.
