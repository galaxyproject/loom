---
type: Lesson
title: A tool's built-in reference option is useless on a server that has no indexes for it
description: The cached-reference branch of a tool offers nothing when the server's data table is empty, and through a workflow the invocation validates and every sample fails minutes later.
tags: [reference-genome, data-tables, server-dependent, star]
status: draft
generated: { by: "human:loom-maintainers", at: "2026-09-30" }
stale_after: "2027-03-31"
sources:
  - { id: "loom#198" }
  - { id: "galaxy-mcp#62" }

kind: choice
stage: [tool-parameterization]
trigger:
  signatures: ["requires a value, but no legal values defined"]
  tools: [rna_starsolo, rna_star]
  mcp_tools: []
  formats: []
  hosts: []
  extensions: [".fasta", ".fa", ".gtf"]
  step_keywords: ["reference", "genome", "index", "built-in", "cached", "genomedir"]
cues: "The tool offers a choice between a cached or built-in reference and one from the history."
applies_to: { versions: "any; depends on the server's data tables", tested: "STARsolo on a server with no STAR indexes" }
evidence:
  symptom: verified
  cause: verified
  outcome: unvalidated
  method: "the 400 at submit was quoted, and the server was confirmed to have zero indexes for the tool"
graduated_to: []
upstream: ["galaxy-mcp#62"]
supersedes: []
---

## Symptom

`Parameter 'genomeDir': requires a value, but no legal values defined` at submit. Through a
workflow it is worse: the invocation validates, and the failure shows up minutes later as a bare
tool error on every sample.

## Cause

The use-a-built-in-index branch of the tool was selected, and this server's data table for that
tool is empty.

## Check first

Does the select parameter for the built-in reference have any options on this server?

## Intervention

Switch to the history-reference branch and supply a FASTA, and an annotation where the tool needs
one, or run on a server that has the index.

## Validate

The job reaches `ok`, and the mapping rate is plausible for the organism -- a wrong reference also
"works".

## Does NOT apply when

The select has options and the chosen value is not among them -- that is a wrong-value problem.
