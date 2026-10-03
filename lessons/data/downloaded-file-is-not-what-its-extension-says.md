---
type: Lesson
title: A supplementary-file download can return an HTML page saved under the expected filename
description: A landing page, consent interstitial or bot-block answers with 200 and the client saves it as the requested name, so the parse failure surfaces several steps later.
tags: [download, supplementary-data, file-type, landing-page]
status: draft
generated: { by: "human:loom-maintainers", at: "2026-09-30" }
stale_after: "2027-03-31"
sources:
  - { id: "loom#356" }
  - { id: "loom#282" }

kind: source-quirk
stage: [data-acquisition]
trigger:
  signatures: []
  tools: []
  mcp_tools: []
  formats: [xlsx, gz, tsv, csv]
  hosts: ["doi.org", "zenodo.org", "figshare.com", "static-content.springer.com", "journals.plos.org", "www.ncbi.nlm.nih.gov"]
  extensions: [".xlsx", ".tsv.gz", ".tsv", ".csv", ".gz"]
  step_keywords: ["download", "supplementary", "fetch", "wget", "curl", "doi", "landing page"]
cues: "Fetching a supplementary or data file from a journal, a repository landing page, or a DOI link."
applies_to: { versions: "n/a", tested: "local download of journal supplementary files" }
evidence:
  symptom: verified
  cause: hypothesized
  outcome: unvalidated
  method: "the file was later found to be HTML or XML"
graduated_to: []
upstream: []
supersedes: []
---

## Symptom

An `.xlsx` or `.tsv.gz` will not parse, or parses into nonsense, several steps after it was
fetched.

## Cause

Likely: the URL was a landing page, a login or consent interstitial, or a bot-block response, and
the client saved the body under the requested name with a 200.

## Check first

Right after any download: file size, leading bytes (zip or gzip magic versus `<`), and
content-type if available.

## Intervention

Find the direct file URL, or have Galaxy fetch it server-side; if access is gated, tell the user
rather than working around it.

## Validate

The file opens as its claimed type and has the expected shape: sheets, columns, row count.

## Does NOT apply when

The file is genuinely the right type and the parse error is about its contents.
