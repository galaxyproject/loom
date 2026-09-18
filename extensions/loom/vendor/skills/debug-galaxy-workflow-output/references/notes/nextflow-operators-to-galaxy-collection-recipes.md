---
type: research
title: "Nextflow operators to Galaxy collection recipes"
tags:
  - source/nextflow
  - target/galaxy
status: draft
created: 2026-05-02
revised: 2026-05-02
revision: 1
related_notes:
  - "nextflow-to-galaxy-channel-shape-mapping"
  - "galaxy-collection-semantics"
  - "galaxy-collection-tools"
  - "galaxy-apply-rules-dsl"
  - "iwc-transformations-survey"
  - "iwc-tabular-operations-survey"
  - "galaxy-data-flow-draft-contract"
  - "iwc-map-over-lifecycle-survey"
  - "nextflow-patterns"
related_molds:
  - "nextflow-summary-to-galaxy-data-flow"
  - "implement-galaxy-tool-step"
  - "debug-galaxy-workflow-output"
sources:
  - "https://github.com/galaxyproject/foundry/issues/53"
summary: "Classifies common Nextflow operators as Galaxy wiring, collection semantics, explicit steps, or review triggers."
---

# Nextflow Operators To Galaxy Collection Recipes

Most Nextflow operators are not Galaxy tools. Translate them first as source-side data-flow intent, then decide whether the Galaxy representation is simple wiring, collection semantics, an explicit Galaxy step, or a user-review checkpoint.

## Decision Vocabulary

| Label | Meaning |
|---|---|
| `channel-only rewiring` | The operator disappears into Galaxy connections, labels, branch wiring, or output selection. |
| `Galaxy collection semantics` | Translation relies on collection identifiers, collection type, map-over, reduction, or nesting behavior. |
| `explicit Galaxy step` | Add a collection-operation, tabular, text-processing, or domain tool step. |
| `user review` | Translation is likely lossy or semantically ambiguous. |

## Operator Recipes

| Nextflow operator | Galaxy recipe | Class | Confidence |
|---|---|---|---|
| `map` | Treat metadata-only projection as wiring. Use Apply Rules only when materialized identifiers or collection shape must change. Use an explicit tool if file contents or table rows change. | Usually channel-only; sometimes collection semantics or explicit step | High for metadata-only, medium for identifier parsing |
| `join` | If two Galaxy collections have matching identifiers and structure, use normal multi-input map-over. Otherwise add synchronization by extracting, sorting, filtering, or relabeling identifiers. Use tabular joins for row-key joins. | Collection semantics or explicit step | High for file/index pairing, medium for loose joins |
| `groupTuple` | If grouping represents nested collection structure, model collection nesting or Apply Rules. If grouping is scatter/gather for a domain operation, implement the downstream merge/reduce tool. | Collection semantics plus explicit reduction | High for interval gather, medium for arbitrary grouping |
| `branch` | Use branch wiring only for static workflow-level classes. Per-element conditional routing usually needs explicit filters/classifiers or user review. | Channel-only, explicit step, or review | Medium |
| `mix` | Keep report/version aggregation as wiring. Use `__MERGE_COLLECTION__` or `__BUILD_LIST__` only when a materialized collection is required. | Usually channel-only; explicit collection assembly when materialized | High for report/version aggregation |
| `combine` | With `by:`, treat like keyed pairing. Without `by`, treat as Cartesian expansion and require review unless a specific Galaxy cross-product recipe is intended. | Collection semantics or review | Medium-low for unkeyed combine |
| `multiMap` | Usually split one tuple into separate synchronized Galaxy inputs. Preserve enough edge notes to rejoin later if needed. | Usually channel-only | Medium |

## User-Review Triggers

- `branch` has non-trivial predicates, an `unknown`/default branch, or discarded branch data.
- `join` uses optional/remainder behavior, duplicate keys, non-metadata keys, or mismatch-tolerant settings.
- `combine` lacks `by:` and may imply all-vs-all expansion.
- `groupTuple` uses explicit size, sort, or `groupKey` behavior.
- `map` mutates metadata, parses identifiers with regex, returns variable arity, or hides content-level computation.
- `mix` combines branches with overlapping identifiers or unclear ordering.
- Any Groovy closure transforms file bytes or table rows.

## Evidence

Pinned Nextflow fixtures provide direct examples of all covered operators except some edge cases of `combine` and arbitrary `map` closures:

- `workflow-fixtures/pipelines/nf-core__taxprofiler/main.nf` for `map`, `branch`, `mix`, and collection split/merge behavior.
- `workflow-fixtures/pipelines/nf-core__taxprofiler/subworkflows/local/visualization_krona/main.nf` for keyed `combine` plus `multiMap`.
- `workflow-fixtures/pipelines/nf-core__sarek/subworkflows/local/*/main.nf` for `join`, interval `groupTuple`, and scatter/gather patterns.
- `workflow-fixtures/pipelines/nf-core__fetchngs/workflows/sra/main.nf` for accession/data-fetching branches and reductions.

Galaxy-side evidence:

- galaxy-collection-semantics for map-over and reduction behavior.
- iwc-transformations-survey for cleanup-after-fanout, identifier synchronization, collection flattening, and corpus-observed collection recipes.
- galaxy-collection-tools for built-in collection operations.
- galaxy-apply-rules-dsl for identifier-derived collection reshaping.
- iwc-tabular-operations-survey for cases where operator translation leaves collection-land and becomes tabular/text transformation.

## Low-Confidence Areas

- Unkeyed `combine` can be represented by Galaxy cross-product collection tools, but the IWC survey found little or no corpus uptake. Prefer review.
- `branch` cleanup via null filtering is possible but weakly attested; avoid claiming it as the default pattern.
- Arbitrary `map` closures cannot be safely translated from syntax alone. Summarization should classify closure intent when possible.

## Mold Use

- nextflow-summary-to-galaxy-data-flow should use this as the primary operator-translation reference.
- implement-galaxy-tool-step should use this when operator decisions become concrete Galaxy collection or tabular steps.
- debug-galaxy-workflow-output should use this when wrong nesting, missing elements, branch merges, or gather outputs indicate a bad operator translation.

## TODOs

- Decide whether `summary-nextflow.schema.json` should record operator parameters such as `by`, `remainder`, `failOnMismatch`, `size`, and `sort`.
- Consider a dedicated pattern for Nextflow per-element `branch` to Galaxy conditionals/filtering.
- Decide whether unkeyed `combine` always requires review.
