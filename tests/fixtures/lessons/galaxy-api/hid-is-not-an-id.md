---
type: Lesson
title: The number shown in the history panel is not a dataset id
description: Users say "dataset 28", which is the hid; the API wants the encoded id, and run_tool reports the mismatch as a misleading missing-parameter error.
tags: [hid, encoded-id, history, galaxy-api]
status: stable
generated: { by: "human:loom-maintainers", at: "2026-09-30" }
stale_after: "2027-03-31"
sources:
  - { id: "loom#348" }
  - { id: "loom#375" }

kind: pitfall
stage: [data-acquisition, tool-parameterization]
trigger:
  signatures: ["Invalid id length, must be multiple of 16", "Required parameter(s) kwd not provided"]
  tools: []
  mcp_tools: [galaxy_get_dataset_details, galaxy_run_tool]
  formats: []
  hosts: []
  extensions: []
  step_keywords: ["dataset number", "hid", "dataset id"]
cues: "A short numeric identifier taken from what the user said is being passed where the API wants an encoded id."
applies_to: { versions: "any", tested: "galaxy-mcp get_dataset_details, run_tool with cat1" }
evidence:
  symptom: verified
  cause: verified
  outcome: validated
  method: "reproduced; resolving the hid to the encoded id fixed it"
graduated_to: ["galaxy-skills galaxy-mcp-reference gotchas note"]
upstream: []
supersedes: []
---

## Symptom

An id-length error, or -- from run_tool -- a misleading required-parameter error that says nothing
about ids.

## Cause

Users say "dataset 28"; that is the `hid`. The API wants the encoded `id`.

## Check first

Is the id being passed short and numeric?

## Intervention

List the history contents and resolve the hid to an id. Confirm the name matches what the user
meant.

## Validate

The call succeeds and the returned dataset's name and hid are the intended ones.

## Does NOT apply when

The id is already a 16-hex-multiple string -- then the missing-parameter error has another cause.
