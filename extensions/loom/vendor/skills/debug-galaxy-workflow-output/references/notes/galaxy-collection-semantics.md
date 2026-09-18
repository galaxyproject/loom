---
type: research
title: "Galaxy collection semantics"
tags:
  - target/galaxy
status: draft
created: 2026-04-30
revised: 2026-05-05
revision: 3
license: MIT
license_file: LICENSES/galaxy.LICENSE
related_notes:
  - "galaxy-xsd"
  - "galaxy-collection-tools"
  - "galaxy-apply-rules-dsl"
  - "nextflow-to-galaxy-channel-shape-mapping"
  - "nextflow-operators-to-galaxy-collection-recipes"
  - "galaxy-tool-job-failure-reference"
  - "galaxy-workflow-invocation-failure-reference"
  - "iwc-transformations-survey"
  - "galaxy-discover-datasets"
sources:
  - "https://github.com/galaxyproject/galaxy/blob/7765fae934fbfdee77e3be5f5b235e43735273ae/lib/galaxy/model/dataset_collections/types/collection_semantics.yml"
companions:
  - "galaxy-collection-semantics.yml"
summary: "Vendored formal spec of Galaxy dataset-collection mapping/reduction semantics, with labeled examples and pinned test references."
---

> **Vendored from upstream**, pinned at SHA `7765fae`. One file travels with this note:
>
> - `galaxy-collection-semantics.yml` — the structured source. **Agents and casting should consume this.** It carries the `tests:` blocks that pin concrete Galaxy test names; the rendered upstream view drops them.
>
> The Foundry also vendors Galaxy's auto-generated MyST/LaTeX rendering of the same YAML, which
> is what the human view below renders from. It is a site asset: casting does not carry it, so
> do not look for it beside this note in a skill bundle. Sync is manual.
>
> **When to consult:** authoring or reasoning about Molds and patterns that touch `data_collection` inputs, map-over / reduction shape changes, sub-collection mapping, `paired_or_unpaired`, or `sample_sheet`.

```vendored-myst
file: galaxy-collection-semantics.upstream.myst
source: https://github.com/galaxyproject/galaxy/blob/7765fae934fbfdee77e3be5f5b235e43735273ae/doc/source/dev/collection_semantics.md
sha: 7765fae
```
