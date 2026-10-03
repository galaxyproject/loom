---
type: Lesson
title: 'Numeric filters in awk and friends treat "NA" as 0, so missing p-values pass a significance cutoff'
description: DESeq2 writes NA for filtered genes; string-to-number coercion turns NA into 0, which is below any cutoff, so the significant count is inflated with no error.
tags: [awk, filtering, p-value, deseq2]
status: draft
generated: { by: "human:loom-maintainers", at: "2026-09-30" }
stale_after: "2027-03-31"
sources:
  - { id: "loom#355" }

kind: pitfall
stage: [result-interpretation]
trigger:
  signatures: []
  tools: [deseq2, Filter1]
  mcp_tools: []
  formats: [tabular]
  hosts: []
  extensions: [".tabular", ".tsv"]
  step_keywords: ["filter", "significant", "padj", "p-value", "fdr", "threshold", "awk"]
cues: "Thresholding a p-value or padj column with awk, cut/sort, or a Galaxy filter expression."
applies_to: { versions: "any", tested: "awk on DESeq2 output" }
evidence:
  symptom: verified
  cause: verified
  outcome: validated
  method: "deterministic: NA plus 0 is 0 in awk; the count dropped to the expected range once NA rows were excluded"
graduated_to: []
upstream: []
supersedes: []
---

## Symptom

Implausibly many significant genes -- several-fold more than expected. Nothing errors.

## Cause

DESeq2 writes `NA` for genes removed by independent filtering or outlier detection.
String-to-number coercion turns `NA` into 0, which is below any cutoff.

## Check first

Count rows where the tested column is literally `NA`. If that count is close to the excess, this
is it.

## Intervention

Exclude NA explicitly before comparing, or do the filter in a language with real missing-value
semantics.

## Validate

Significant count equals rows passing the cutoff among non-NA rows. State both numbers.

## Does NOT apply when

The table has no missing values in that column.
