---
type: Lesson
title: A faithful rerun can still be wrong when a normalizing step was fed a pre-filtered subset
description: A statistic normalized over its input is wrong if the input was hand-picked, and the rerun reproduces the error exactly, so provenance alone will never catch it.
tags: [reproduction, normalization, denominator, audit]
status: draft
generated: { by: "human:loom-maintainers", at: "2026-09-30" }
stale_after: "2027-03-31"
sources: []

kind: reproduction
stage: [data-acquisition, tool-parameterization, result-interpretation]
trigger:
  signatures: []
  tools: []
  mcp_tools: []
  formats: []
  hosts: []
  extensions: []
  step_keywords: ["reproduce", "reproducing", "reproduction", "posterior", "fdr", "enrichment", "percentile", "rank", "normalize", "credible set"]
cues: "Reproducing a published analysis where a step computes a normalized quantity -- posterior, FDR, enrichment, rank, percentile."
applies_to: { versions: "n/a", tested: "one audited reproduction of a fine-mapping analysis" }
evidence:
  symptom: verified
  cause: verified
  outcome: unvalidated
  method: "traced by reading the job's actual inputs; the denominator differed from the full set"
graduated_to: []
upstream: []
supersedes: []
---

## Symptom

Results are close to the paper's but not equal: a set has a few members more or fewer, and every
downstream value drifts by a few percent in the same direction.

## Cause

A statistic normalized over its input, here posterior probabilities, was computed over a
hand-picked subset. The tool ran correctly. Rerunning reproduces the error, so provenance alone
will not catch it.

## Check first

For every normalizing step: how many records went in, and how many does the method assume? Compare
against the paper's stated N.

## Intervention

Feed the step the full population; filter afterwards.

## Validate

Input count matches the method's stated population, and the set membership matches the paper.

## Does NOT apply when

The step's output for one record does not depend on the others.
