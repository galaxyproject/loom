---
type: research
title: "Galaxy workflow draft format"
tags:
  - target/galaxy
status: draft
created: 2026-05-06
revised: 2026-05-10
revision: 2
related_notes:
  - "gxformat2-schema"
  - "galaxy-data-flow-draft-contract"
  - "discover-shed-tool"
  - "galaxy-workflow-draft"
  - "open-requirements-ledger"
related_molds:
  - "nextflow-summary-to-galaxy-template"
  - "cwl-summary-to-galaxy-template"
  - "freeform-summary-to-galaxy-template"
  - "compare-against-iwc-exemplar"
  - "implement-galaxy-tool-step"
  - "advance-galaxy-draft-step"
  - "repair-galaxy-draft-topology"
summary: "gxformat2 draft superset: wrapper-tier TODOs (tool_id, state, port names) plus _plan_state / _plan_context / _plan_in / _plan_out per tool step."
---

# Galaxy workflow draft format

The output artifact `galaxy-workflow-draft` produced by the `*-summary-to-galaxy-template` Molds is **gxformat2 with wrapper-tier relaxations and free-text planning fields**, sized to the gap between data-flow design and tool-resolved implementation.

Topology — workflow inputs and their collection shapes, workflow outputs, the step set, the producer→consumer edge graph, branches, and `when:` guards — is **settled by the template Mold itself**, drawing on the upstream interface and data-flow briefs (see galaxy-data-flow-draft-contract). The output is concrete gxformat2 with no topology TODOs. Wrapper-tier resolution — which Tool Shed wrapper, what parameters, the wrapper-determined port names that populate `in:` / `out:` / `outputSource` — is **evidence-gated per step** (see Resolution tiers below): a step resolves fully when the evidence pins wrapper and parameters together, pins identity alone when the wrapper is named but its settings are not, and defers entirely when the evidence is weak.

A step's declared `in:` arity is a topology decision and must be realizable by one wrapper. Combining N sources into one — concatenate, merge, union — is its own node (`gops_concat_1`, `cat1` for two/N datasets; `collapse_dataset` for a collection), never folded into a downstream 1→1 reshape. A step that would declare ≥2 dataset inputs under a reshape intent (awk, text-reformatting, "reshape") is a missing-combine-node smell: split it into an explicit combine step plus single-input reshapes. The relevant concat/merge/union recipes are reachable through the tabular, interval, and collection pattern indices the template already consults.

## Resolution tiers

Each tool step is resolved to the tier its evidence supports — **evidence-gated, not source-gated**. The source kind (free-form, nf-core, CWL) shifts how often a step reaches each tier but never caps it; each `*-summary-to-galaxy-template` Mold records its own source tendency.

- **Resolved** — concrete `tool_id`, `tool_shed_repository` / changeset (or a stable built-in id), and bound `state`; no `_plan_*`. Use when the evidence pins wrapper *and* parameters jointly: a built-in Galaxy tool with brief-determined params (`Filter1`, `Cut1`, a collection operation), or a pattern page / IWC exemplar worked example that supplies `tool_id`, changeset, and parameter values together. `draft-validate` rejects `_plan_*` on a fully-resolved step.
- **Identity-pinned** — concrete `tool_id` with `tool_version: TODO` (changeset deferred); `state` and `tool_shed_repository` absent; `_plan_state` (and any other open `_plan_*`) kept. The `tool_version: TODO` sentinel is load-bearing: it keeps the step drafty for draft-next-step and not-fully-resolved for draft-validate, so the retained `_plan_state` is legal rather than a `semanticError`. (A step is "fully-resolved" — and so forbidden from carrying `_plan_*` — exactly when it has *no* remaining TODO sentinel in `tool_id`, `tool_version`, or any `in:` / `out:` port; pinning identity without this sentinel would trip that gate.) Use when the evidence confidently names *which* wrapper but not its settings or exact changeset for this context: a portion of an IWC exemplar that compare-against-iwc-exemplar flags as a high-confidence match, a pattern page's worked example, or a source summary that names a specific `tool_id` with evidence.
- **Deferred** — `tool_id: TODO`, full `_plan_*`. Use when the evidence is weak, multi-candidate, a domain-specific scientific tool with no covering pattern or exemplar, or a corpus gap.

Pin identity only on strong evidence — a wrapper an exemplar actually uses for the same operation, a worked pattern example, or a tool the source names explicitly — never on plausibility: a wrong pinned `tool_id` lets discover-shed-tool resolve the wrong tool's changeset instead of searching afresh. Port names follow the wrapper: real on a Resolved step, `TODO_<hint>` sentinels until the step resolves.

The per-step loop does not edit topology — but it may **escalate back to a template-tier Mold** when implementation proves the settled topology can't support a declared step (see "Topology repair escalation" below). Wiring authority stays in the template tier; the loop only gains a path back to it.

## Relaxations vs. gxformat2

For tool steps, when the wrapper has not been picked:

- `tool_id` and `tool_version` MAY be the literal string `TODO`. Resolution belongs to discover-shed-tool and the per-step implementation Mold.
- `tool_shed_repository` (the `{ changeset_revision, name, owner, tool_shed }` block) MAY be absent.
- `state` MAY be absent. A draft is authored, so it uses `state` — never the export-side
  `tool_state`; see gxformat2-schema for the distinction.
- Step `out[].id` and `in[]` keys MAY be `TODO_<hint>` sentinels (e.g. `TODO_trimmed_paired`, `TODO_input`). Workflow `outputs[].outputSource` MAY reference such a sentinel via `step/TODO_<hint>` so the connection graph still resolves syntactically. The connection itself (which step's output feeds which step's input) is topology and MUST be present; only the wrapper-determined port names are deferred.

Workflow inputs (types, collection shapes, formats, optionality), workflow outputs, step labels, and the producer→consumer edge set MUST be expressed in normal gxformat2 form with concrete values — never `TODO`. The template Mold is the locus where these decisions are made; if the upstream brief leaves a topology choice open, decide it here from source evidence, IWC exemplars, and pattern pages rather than punting downstream.

## Additions: `_plan_*` planning fields

Free-text fields per tool step capture the template Mold's intent for the downstream per-step implementation Mold. All optional, but expected on any Identity-pinned or Deferred step (`tool_id` is `TODO`, or `tool_id` is pinned but `state` is absent); a Resolved step carries none.

- `_plan_state` — parameter binding intent: which knobs matter, value or range, why. Read by the per-step Mold to bind real `state` once a wrapper is selected.
- `_plan_context` — extras the per-step Mold needs to pick a wrapper: source `command:` block, conda packages, Docker/Singularity images, environment variables, preconditions, postconditions, container entrypoints, scratch-disk needs.
- `_plan_in` — wrapper input port mapping intent. The connection graph already says "this source feeds this step"; `_plan_in` records the semantic role of each port and likely wrapper-side names (`single_paired` vs `paired_input` vs `input`) so the per-step Mold can collapse `TODO_*` keys to the real ones.
- `_plan_out` — wrapper output surface intent: which outputs downstream consumers depend on (with the existing edges as evidence) so the per-step Mold can pick a wrapper that exposes them, or insert a follow-up step if it does not.

The `_plan_*` family is **wrapper-tier**: each entry exists because the wrapper is not yet fully resolved and disappears the moment the step is. Topology decisions do not belong here.

`_plan_*` fields are **draft-only**. They MUST be removed before the workflow is treated as a runnable gxformat2 document. Any remaining `TODO` / `TODO_*` sentinels MUST also be resolved at the same time.

## Example (sketch)

```yaml
class: GalaxyWorkflowDraft
inputs:
  reads:
    type: collection
    collection_type: list:paired
    format: fastqsanger.gz
outputs:
  trimmed:
    outputSource: fastp/TODO_trimmed_paired
steps:
  fastp:
    tool_id: TODO
    label: trim and QC paired reads
    in:
      TODO_input: reads
    out:
      - id: TODO_trimmed_paired
      - id: TODO_html_report
    _plan_state: |
      adapter trimming on, quality cutoff ~Q20, min length ~50.
      preserve paired-end pairing for downstream alignment.
    _plan_context: |
      upstream: nf-core FASTP module.
      conda: bioconda::fastp=0.23.4
      container: quay.io/biocontainers/fastp:0.23.4--h5f740d0_0
      precondition: paired list collection with sane element identifiers
    _plan_in: |
      single semantic port `reads`: feeds workflow `reads` (list:paired).
      wrapper input port name likely one of `single_paired` | `paired_input` |
      `input` depending on which fastp wrapper is picked.
    _plan_out: |
      need a paired output that preserves list:paired shape (downstream
      alignment step consumes it). also expose the HTML report as a
      checkpoint output for QC.
```

## Why this shape

- Keeps the artifact recognizably gxformat2 so static tooling (`gxwf validate --no-tool-state`, structural diff against IWC) still applies to topology and port wiring.
- Carves a stable handoff between the template Mold and the per-step implementation Mold without sneaking tool resolution into either side.
- Makes the boundary between topology (settled upstream) and wrapper-tier (deferred) explicit — the `_plan_*` family lives squarely on the deferred side.
- Free-text `_plan_*` is intentional for v1: it lets the templating agent record intent without a contract pretending to be parameterizable yet. Structuring those fields is open work — see each template Mold's `refinement.md`.

## Topology repair escalation

The template Mold settles topology, but it can miss a **computability** gap: a step whose declared output needs evidence no wired input carries. The connection graph validates — ports connect — yet the step can't be implemented. The template's computability review pass catches most of these and either wires the producer or records the gap in the open-requirements-ledger; the rest surface in the per-step loop.

When one surfaces, the per-step loop does not author topology to fix it. It **escalates**:

- implement-galaxy-tool-step detects, while implementing, that the declared output can't be computed from the wired inputs. It appends a blocking entry to the open-requirements-ledger and falls through rather than fabricating the output.
- repair-galaxy-draft-topology — a template-tier Mold sharing the template's reference set — reads the blocking entries and re-wires the affected region: one producer step, a small sub-path, or honest narrowing of the output. New steps land at draft (wrapper-tier `TODO`) tier, so the existing discover-or-author → implement machinery realizes them.

This is **repair**, distinct from **settling**: it is narrow (one named region), reactive (only a detected computability gap triggers it), and bounded. The loop's convergence gate counts open blocking entries in the ledger; each escalation must strictly reduce that count, under a hard cap on escalations. When the cap is reached with entries still open, they are **surrendered** — written into the final draft as labelled gaps — the clean terminal that replaces spin-or-fabricate. So the boundary "topology decisions do not belong in the per-step loop" still holds: the loop never decides topology, it returns the decision to the template tier.

## Open work

- Decide whether `_plan_state` should grow structure (parameter-name hints, value ranges, references back to the source summary).
- Decide whether `_plan_context` should be split into typed fields (`source_command`, `conda`, `containers`, `env`, `pre`, `post`).
- Decide structure for `_plan_in` and `_plan_out` once two or three worked drafts exercise them. Candidate `_plan_out`: array of `{ semantic_name, downstream_consumers[], required_for }`. Candidate `_plan_in`: map keyed by the `TODO_*` placeholder key to `{ semantic_name, source_step_output, shape_constraint }`.
- Pick a JSON Schema strategy: extend the gxformat2 schema with `_plan_*` and the relaxed wrapper / port-name rules, or validate the draft via a sibling schema that wraps gxformat2 with the relaxations.
- Specify the strip step that converts a draft into a runnable gxformat2 workflow. It MUST drop all `_plan_*` fields and reject any remaining `TODO` or `TODO_<hint>` sentinel in `tool_id`, `tool_version`, `out[].id`, `in[]` keys, or `outputSource`.
