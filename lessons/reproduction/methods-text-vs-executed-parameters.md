---
type: Lesson
title: When a rerun cannot find what the paper reports, compare the Methods parameters to the executed ones
description: A missing peak or row, or a uniform few-percent drift with ranks intact, is usually a window, threshold, top-N or version difference rather than a failed reproduction.
tags: [reproduction, parameters, versions, methods]
status: draft
generated: { by: "human:loom-maintainers", at: "2026-09-30" }
stale_after: "2027-03-31"
sources: []

kind: reproduction
stage: [metadata-reconciliation, result-interpretation]
trigger:
  signatures: []
  tools: []
  mcp_tools: []
  formats: []
  hosts: []
  extensions: []
  step_keywords: ["reproduce", "reproducing", "reproduction", "methods", "paper", "missing", "not found", "threshold", "window", "top-n", "version"]
cues: "Reproducing a published analysis where a reported feature, row or peak is absent from the rerun."
applies_to: { versions: "n/a", tested: "one audited reproduction" }
evidence:
  symptom: verified
  cause: verified
  outcome: unvalidated
  method: "each discrepancy traced to a specific parameter or version difference"
graduated_to: []
upstream: []
supersedes: []
---

## Symptom

A table row, peak or feature from the paper is not in the rerun's output at all; or scores are
systematically a few percent off with ranks preserved.

## Cause

Four observed varieties: a window or range parameter narrower than the Methods describe, so the
feature lies outside what was scanned; a summary step's top-N or threshold dropping it; a tool
revision changing output columns; a model or tool version change shifting values uniformly.

## Check first

Tabulate Methods-stated versus executed values for windows, thresholds, top-N limits and versions.
Is the missing item outside a range or below a cutoff? Is the drift uniform with ranks intact?

## Intervention

Rerun with the Methods' parameters if they differ. If versions differ and cannot be matched, report
the drift as version drift, with its size, rather than as a failed reproduction.

## Validate

The missing item appears under the Methods' parameters, or its absence is explained by a named
parameter. Say which.

## Does NOT apply when

Parameters and versions match and the result still differs -- that is a real discrepancy; report
it.
