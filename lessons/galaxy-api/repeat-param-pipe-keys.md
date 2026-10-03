---
type: Lesson
title: Repeat-group tool params written with underscores are accepted but silently mis-applied
description: Galaxy's flat parameter form addresses repeat members with a pipe; an underscore key is ignored rather than rejected, so the repeat falls back to defaults and the job still reports ok.
tags: [repeat-params, tool-parameters, silent-failure, galaxy-api]
status: stable
generated: { by: "human:loom-maintainers", at: "2026-09-30" }
stale_after: "2027-03-31"
sources:
  - { id: "loom#285" }
  - { id: "loom#295" }

kind: pitfall
stage: [tool-parameterization, result-interpretation]
trigger:
  signatures: []
  tools: [datamash_ops]
  mcp_tools: [galaxy_run_tool]
  formats: []
  hosts: []
  extensions: []
  step_keywords: ["repeat", "operations", "aggregate", "group by"]
cues: "Tool inputs contain keys shaped like name underscore number underscore field."
applies_to: { versions: "unknown", tested: "Datamash via galaxy-mcp run_tool" }
evidence:
  symptom: verified
  cause: hypothesized
  outcome: unvalidated
  method: "a wrong aggregate was observed; the pipe-form keys produced the expected one"
graduated_to: ["loom docs repeat-parameter note", "galaxy-mcp tool input template"]
upstream: ["galaxy-mcp#52"]
supersedes: []
---

## Symptom

A tool with a repeat block runs to `ok`, but the result reflects default or wrong repeat values --
a different operation or column than requested. No error anywhere.

## Cause

Hypothesized: Galaxy's flat parameter form addresses repeat members as `block_0|field`. A key like
`block_0_field` is not rejected; it is ignored, and the repeat falls back to defaults.

## Check first

Look at the inputs actually submitted. Any repeat member addressed with an underscore instead of a
pipe? Compare the job's recorded parameters with what was intended.

## Intervention

Use the pipe form, for example `operations_0|op_name`, preferably taken verbatim from the tool's
input template rather than constructed by hand.

## Validate

Read back the job's parameters and confirm the repeat values are the requested ones. Spot-check one
output value by hand.

## Does NOT apply when

The tool errored at submit -- that is a different problem. Conditionals use the same pipe
addressing but fail differently.
