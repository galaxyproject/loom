---
type: Lesson
title: Fold-change signs read backwards and sample labels drift, with no error anywhere
description: Factor-level order decides numerator and denominator, and upstream steps rewrite sample labels, so a DE result can be fully reversed or mis-assigned and still look clean.
tags: [differential-expression, design-table, contrast, deseq2]
status: draft
generated: { by: "human:loom-maintainers", at: "2026-09-30" }
stale_after: "2027-03-31"
sources:
  - { id: "loom#288" }
  - { id: "loom#289" }
  - { id: "loom#321" }

kind: pitfall
stage: [metadata-reconciliation, result-interpretation]
trigger:
  signatures: []
  tools: [deseq2, edger, limma_voom]
  mcp_tools: []
  formats: [tabular]
  hosts: []
  extensions: []
  step_keywords: ["design", "factor", "contrast", "condition", "log fold change", "logfc", "differential expression"]
cues: "Building a design or factor table, and reporting log fold changes."
applies_to: { versions: "any", tested: "DESeq2" }
evidence:
  symptom: reported
  cause: verified
  outcome: unvalidated
  method: "user reports across one analysis: duplicate labels, unstated sign convention, design that did not match the data"
graduated_to: []
upstream: []
supersedes: []
---

## Symptom

Fold-change signs read backwards; duplicate or dropped sample labels; a multi-sample design
applied to data that was actually pooled.

## Cause

Factor-level order decides numerator versus denominator and is easy to get implicitly. Sample
labels get rewritten by upstream steps. Nobody compared the design table to the data before
running.

## Check first

Before running: one row per sample, labels unique, every sample in the design is in the data and
vice versa, replicates per condition as the design claims.

## Intervention

State the contrast in words -- treated relative to control, positive means up in treated -- in the
plan and again next to the results.

## Validate

Pick a gene with a known direction and check its sign.

## Does NOT apply when

Never; it holds for any two-group comparison.
