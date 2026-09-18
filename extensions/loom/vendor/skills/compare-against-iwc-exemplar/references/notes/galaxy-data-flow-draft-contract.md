---
type: research
title: "Galaxy data-flow draft contract"
tags:
  - target/galaxy
status: draft
created: 2026-05-02
revised: 2026-05-03
revision: 2
related_notes:
  - "nextflow-to-galaxy-channel-shape-mapping"
  - "nextflow-operators-to-galaxy-collection-recipes"
  - "galaxy-workflow-draft"
related_molds:
  - "nextflow-summary-to-galaxy-data-flow"
  - "cwl-summary-to-galaxy-data-flow"
  - "freeform-summary-to-galaxy-data-flow"
  - "nextflow-summary-to-galaxy-template"
  - "cwl-summary-to-galaxy-template"
  - "freeform-summary-to-galaxy-template"
  - "compare-against-iwc-exemplar"
  - "advance-galaxy-draft-step"
sources:
  - "https://github.com/galaxyproject/foundry/issues/54"
summary: "Defines the proposed boundary between Galaxy data-flow drafts, gxformat2 templates, and concrete step implementation."
---

# Galaxy Data-Flow Draft Contract

This is an architectural contract, not a schema. Evidence is strongest for Mold and Pipeline boundaries. Proposed fields are speculative until exercised by two or three worked translations.

## Boundary

The data-flow draft owns a target-shaped abstract DAG for Galaxy. It should not be valid `gxformat2` and should not resolve exact Tool Shed tools.

Data-flow draft owns:

- Galaxy-facing workflow inputs and outputs.
- Abstract nodes, edges, branches, collection mapping, collection reduction, and placeholder transformations.
- Input/output shape decisions such as `File`, `list`, `paired`, `list:paired`, or `list:list`.
- Conceptual Galaxy idioms: map-over, reduction, Apply Rules, collection cleanup, identifier synchronization, tabular bridge, fan-in / combine (concatenate, merge, or union N sources into one — a distinct node, not a side-effect of a reshape).
- Abstract unresolved tool needs with input and output shapes.
- Confidence and rationale on inferred nodes, edges, transforms, and tool needs.

The Galaxy template owns:

- A `gxformat2` skeleton.
- Ordered steps, labels, workflow inputs, workflow outputs, and the producer→consumer connection graph.
- Per-step wrapper resolution to the tier its evidence supports — **evidence-gated, not source-gated** (tiers defined in galaxy-workflow-draft-format): a fully **Resolved** step (concrete `tool_id`, changeset, `state`) when wrapper and parameters are pinned jointly; **Identity-pinned** (`tool_id` only, `_plan_state` kept) when the wrapper is named but not its settings; **Deferred** (`tool_id: TODO`, full `_plan_*`) otherwise.
- Placeholder collection-operation or Apply Rules steps only when the data-flow draft says they are necessary.
- `_plan_*` handoff units (intent, evidence, constraints) for every step left short of Resolved.

Concrete step implementation owns:

- For every step the template left short of **Resolved**: the changeset (`tool_version`, `tool_shed_repository` owner/repository metadata), bound `state` parameters, and `input_connections` — resolving any `tool_id: TODO` and confirming or correcting any `tool_id` the template pinned. Steps the template already Resolved pass through — confirm, do not re-derive.
- Concrete built-in collection-operation steps and parameters.
- Validation with `gxwf` and repair after schema/lint failures.

## Proposed Body-Level Contract

Do not add these as frontmatter fields yet.

| Concept | Status | Notes |
|---|---|---|
| `source_summary_ref` | Speculative | Reference to the source summary consumed by the Mold. |
| `workflow_inputs` | Speculative | Abstract Galaxy-facing inputs and collection types. |
| `workflow_outputs` | Speculative | Intended outputs and source-summary provenance. |
| `nodes` | Speculative | Abstract operations, not concrete Galaxy tools. |
| `edges` | Speculative | Data dependencies, shape before/after, and source evidence. |
| `galaxy_idioms` | Speculative | Map-over, reduction, Apply Rules, collection filter, tabular bridge, etc. |
| `unresolved_tool_needs` | Speculative | Per abstract step needs for `discover-shed-tool` or `author-galaxy-tool-wrapper`. |
| `placeholder_transformations` | Speculative | Shape/text/table transforms needed for Galaxy semantics but not concretely implemented. |
| `confidence` | Speculative | Prefer `high`, `medium`, `low` plus rationale. |
| `handoff_notes` | Speculative | Instructions to template, exemplar comparison, and per-step Molds. |
| `open_questions` | Speculative | Semantic/tooling issues carried forward. |

## Handoff Examples

Unresolved tool need:

- nextflow-summary-to-galaxy-data-flow emits an abstract node such as `trim FASTQ reads`, input `list:paired fastq`, output `list:paired fastq`, tool need `read trimming`, confidence `medium`.
- nextflow-summary-to-galaxy-template creates a placeholder step with TODOs and collection-shaped connections.
- The harness routes through tool discovery or wrapper authoring.
- implement-galaxy-tool-step fills exact Galaxy tool metadata, parameters, and connections.

Collection cleanup after fan-out:

- Data-flow records a conceptual cleanup transform after a mapped step.
- Template materializes a placeholder collection-operation step.
- Implementation chooses exact built-in tool and parameters.

Identifier-derived reshaping:

- Data-flow records desired input shape, output shape, and identifier transformation.
- Template emits an Apply Rules placeholder only if needed.
- Implementation fills concrete rule JSON after exemplar comparison confirms the shape.

IWC exemplar comparison:

- Data-flow and template should hand compare-against-iwc-exemplar the abstract topology, placeholder transformations, unresolved tool needs, and confidence notes.
- Exemplar comparison should flag structural divergence, not resolve tools.

## Confidence Guidance

- Attach confidence to the smallest useful unit: node, edge, transformation, or tool need.
- Use qualitative `high`, `medium`, `low` until examples justify a richer schema.
- Require rationale for low confidence.
- Do not reuse source-summary `warnings[]` as data-flow confidence.
- Keep evidence quality distinct from translation confidence. A claim can be corpus-observed but still low-confidence for a specific workflow.

## Risks

If the data-flow draft is too broad, it duplicates the template Mold, makes premature tool decisions, and leaks harness routing into Mold output.

If it is too narrow, the template Mold receives source-summary details without Galaxy-shaped semantics, exemplar comparison has only a surface skeleton to diff, and tool discovery loses input/output shape context.

## Evidence

- nextflow-to-galaxy-channel-shape-mapping and nextflow-operators-to-galaxy-collection-recipes show why a Galaxy-shaped abstraction is needed between source summary and `gxformat2` template.
- `content/pipelines/nextflow-to-galaxy.md` places data-flow before template, exemplar comparison, and per-step implementation.
- `content/molds/summarize-nextflow/index.md` says source summarization should not produce Galaxy data flow.
- `content/molds/implement-galaxy-tool-step/index.md` owns concrete step implementation.

## TODOs

- Decide whether to author `galaxy-data-flow-draft.schema.json` now or wait for worked examples.
- Decide whether confidence should be a single enum or per-axis vector.
- Decide how much ordering guidance belongs in data-flow versus template.
- Decide whether built-in collection operations should be abstract placeholders or concrete template steps.
