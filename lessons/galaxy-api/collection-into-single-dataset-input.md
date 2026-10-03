---
type: Lesson
title: 'A collection handed to a single-dataset input is rejected; the answer is map-over, not "the API cannot"'
description: A 400 at submit when an hdca meets a single-dataset parameter means map-over was not requested, and the wrong conclusion is that collections cannot be used through the API.
tags: [collections, map-over, batch, galaxy-api]
status: stable
generated: { by: "human:loom-maintainers", at: "2026-09-30" }
stale_after: "2027-03-31"
sources:
  - { id: "loom#208" }

kind: choice
stage: [tool-parameterization]
trigger:
  signatures: ["supplied to single input dataset parameter"]
  tools: []
  mcp_tools: [galaxy_run_tool]
  formats: []
  hosts: []
  extensions: []
  step_keywords: ["collection", "map over", "batch", "per sample"]
cues: "A collection is being passed where the tool's input template says one dataset."
applies_to: { versions: "any", tested: "featureCounts, Filter1 via galaxy-mcp run_tool" }
evidence:
  symptom: verified
  cause: verified
  outcome: validated
  method: "the batch wrapper form was accepted by Galaxy and produced a mapped-over output collection"
graduated_to: ["loom context.ts Galaxy block map-over hint"]
upstream: ["galaxy-mcp actionable-error issue"]
supersedes: []
---

## Symptom

400 at submit when an `hdca` is passed where the tool expects one dataset. Observed follow-on: the
agent concludes collections cannot be built or used through the API, which is false.

## Cause

The input is a single-dataset parameter. Galaxy runs such a tool over a collection only when asked
to map over it.

## Check first

Is the input really single-dataset per the tool's input template, and is the thing being passed a
collection? If the collection is `list:paired` and the tool wants one sample, map-over is still the
answer but the element type must match.

## Intervention

Submit the input in batch form: `{batch: true, values: [{src: "hdca", id: <collection id>}]}`.

## Validate

The result is a collection with one element per input element, and element identifiers are
preserved.

## Does NOT apply when

The tool has a genuine multi-dataset or collection input -- pass the collection directly there.
