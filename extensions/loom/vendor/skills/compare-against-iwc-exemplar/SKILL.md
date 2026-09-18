---
name: compare-against-iwc-exemplar
description: "Find nearest IWC exemplar(s) and surface a structural diff against the upstream Galaxy design briefs to guide template authoring."
---

# compare-against-iwc-exemplar

Follow the procedure below and use the artifact/reference sections as the runtime contract.

## When To Use

- Find nearest IWC exemplar(s) and surface a structural diff against the upstream Galaxy design briefs to guide template authoring.

## Inputs

- Read artifact `nextflow-galaxy-interface`. Produced by `nextflow-summary-to-galaxy-interface`. Galaxy interface brief from nextflow-summary-to-galaxy-interface when running the NEXTFLOW → GALAXY pipeline.
- Read artifact `nextflow-galaxy-data-flow`. Produced by `nextflow-summary-to-galaxy-data-flow`. Galaxy data-flow brief from nextflow-summary-to-galaxy-data-flow when running the NEXTFLOW → GALAXY pipeline.
- Read artifact `cwl-galaxy-interface`. Produced by `cwl-summary-to-galaxy-interface`. Galaxy interface brief from cwl-summary-to-galaxy-interface when running the CWL → GALAXY pipeline.
- Read artifact `cwl-galaxy-data-flow`. Produced by `cwl-summary-to-galaxy-data-flow`. Galaxy data-flow brief from cwl-summary-to-galaxy-data-flow when running the CWL → GALAXY pipeline.
- Read artifact `freeform-galaxy-interface`. Produced by `freeform-summary-to-galaxy-interface`. Galaxy interface brief from freeform-summary-to-galaxy-interface when running the PAPER → GALAXY or INTERVIEW → GALAXY pipelines.
- Read artifact `freeform-galaxy-data-flow`. Produced by `freeform-summary-to-galaxy-data-flow`. Galaxy data-flow brief from freeform-summary-to-galaxy-data-flow when running the PAPER → GALAXY or INTERVIEW → GALAXY pipelines.
- Read artifact `open-requirements-ledger`. Produced by `advance-galaxy-draft-step`, `apply-galaxy-workflow-changeset`, `compare-against-iwc-exemplar`, `cwl-summary-to-galaxy-data-flow`, `cwl-summary-to-galaxy-interface`, `cwl-summary-to-galaxy-template`, `freeform-summary-to-galaxy-data-flow`, `freeform-summary-to-galaxy-interface`, `freeform-summary-to-galaxy-template`, `implement-galaxy-tool-step`, `interview-to-galaxy-workflow-changeset`, `mature-galaxy-workflow-for-iwc`, `nextflow-summary-to-galaxy-data-flow`, `nextflow-summary-to-galaxy-interface`, `nextflow-summary-to-galaxy-reference-data`, `nextflow-summary-to-galaxy-template`, `repair-galaxy-draft-topology`. Carried obligations ledger open-requirements-ledger: the run's open, resolved, and surrendered entries with their provenance. Absent on the first Mold of a run; start an empty one.

## Outputs

- Write artifact `iwc-comparison-notes` as `iwc-comparison-notes.md`. Format: `markdown`. Structural diff against the nearest IWC exemplar(s); guidance for the downstream *-summary-to-galaxy-template Mold before per-step authoring. Carries an inline, bounded gxformat2 excerpt of the nearest exemplar's relevant subgraph under a labeled section, cross-referencing the iwc-exemplar-gxformat2 sibling file.
- Write artifact `iwc-exemplar-gxformat2` as `iwc-exemplar.gxwf.yml`. Format: `yaml`. Cleaned gxformat2 conversion (via convert --to format2 --compact) of the nearest IWC exemplar's relevant subgraph — the concrete idiom the downstream template draft pattern-matches against. Bounded to the relevant subgraph, not the whole workflow. Absent when no nearest exemplar is found.
- Write artifact `open-requirements-ledger` as `open-requirements.ledger.yml`. Format: `yaml`. Carried obligations ledger re-emitted by this step: entries it appended or closed updated, every other entry passed through with its provenance intact.

## Required Tools

- **`gxwf`** (gxwf). `npm install -g '@galaxy-tool-util/cli@^1.8.1'`.
  Ephemeral run: `npx --yes --package @galaxy-tool-util/cli@1.8.1 gxwf`.
  Check: `gxwf --help | grep -q draft-validate`.
  Docs: https://github.com/jmchilton/galaxy-tool-util-ts/tree/main/packages/cli

## Load Upfront

- `references/notes/open-requirements-ledger.md`: Research note copied verbatim into the bundle. Close the open entries a corpus exemplar answers — a collection idiom, a label convention, a structural shape the corpus already settles — and append the ones no exemplar covers, so a structural divergence with no corpus precedent reaches the template tier as a recorded obligation.

## Load On Demand

- `references/cli/convert.json`: CLI command reference packaged as a sidecar. Normalize fetched IWC workflows into a consistent representation for structural comparison, and surface the nearest exemplar forward as a cleaned gxformat2 view (sibling file plus inline excerpt) for the downstream template Mold. Use when: after fetching a candidate IWC workflow file and before structural comparison; and again on the nearest exemplar after ranking to emit the iwc-exemplar-gxformat2 view.
- `references/notes/galaxy-data-flow-draft-contract.md`: Research note copied verbatim into the bundle. Compare against the design briefs' abstract intent without turning exemplar comparison into tool resolution. Use when: deciding whether to compare abstract data-flow shape, interface structure, or speculative implementation details.
- `references/notes/iwc-shortcuts-anti-patterns.md`: Research note copied verbatim into the bundle. Flag proposed shortcuts that are accepted in IWC versus shortcuts that should be treated as smells. Use when: the design briefs propose tests, assertions, labels, or expected-output comparisons.
- `references/notes/iwc-test-data-conventions.md`: Research note copied verbatim into the bundle. Compare proposed test-data placement and fixture shapes against IWC conventions. Use when: the design briefs hint at workflow tests or input fixture organization.

## Validation

- None declared.

## Procedure

Find the nearest IWC exemplar workflow(s) for the upstream Galaxy design briefs and emit a structural diff that guides the downstream `*-summary-to-galaxy-template` skill before per-step authoring effort is spent.

This skill is the corpus-first check in Galaxy-targeting pipelines. It runs after the source-specific interface and data-flow briefs and before the gxformat2 template skill. Discovery, ranking, and comparison are one action — there is no separate retrieval skill.

### Procedure

- Clone or pull and merge the IWC corpus (`https://github.com/galaxyproject/iwc`) to `~/.foundry/iwc`.
- Normalize candidate workflows with convert as needed for structural comparison.
- Find the closest workflow and rank it.
- Surface the nearest exemplar forward (skip when the result is "no nearest exemplar"): see *Nearest exemplar (gxformat2) view*.

### Feature Hierarchy

1. Domain or analysis intent.
2. Input collection topology.
3. Primary tool families.
4. DAG motifs and structural recipes.
5. Output types and report shape.
6. Test style and fixture topology.

Domain comes first so a structurally similar workflow in the wrong science area does not become a misleading exemplar. Topology comes second because collection shape is one of the most important Galaxy-specific design decisions. Test style is useful after a workflow match, but should not drive initial retrieval. Briefs with no domain signal should not produce a high-confidence exemplar even if they share generic tools.

### Confidence Levels

| Level | Meaning |
|---|---|
| High | Same domain/subdomain, same input topology, same primary tool families, same major DAG motifs, and matching test fixture shape. |
| Medium | Same domain and topology, but partial tool-family or output match. Useful exemplar, not canonical. |
| Low | Cross-domain structural match only. Useful for a pattern comparison, not a nearest domain exemplar. |
| No nearest exemplar | Candidate lacks domain or topology alignment, or only shares generic tools such as MultiQC. |

### Routing findings forward

Each finding should name the authoring surface most likely to own the fix:

- Template/data-flow issue: missing node, wrong collection shape, wrong branch, placeholder too vague — surfaced for the downstream `*-summary-to-galaxy-template` skill to apply.
- Pattern issue: recurring Galaxy idiom should become or update a pattern page.
- Tool-step issue: exact wrapper or parameterization will be handled later in the per-step loop.
- Test issue: defer to `*-test-to-galaxy-test-plan` or `implement-galaxy-workflow-test`.

Do not block downstream authoring on low-confidence exemplar mismatches. Report them as review guidance for the template skill and the user.

### Nearest exemplar (gxformat2) view

The schema tells the template skill what is *legal* gxformat2; it does not show *idiom*. A real, domain-adjacent gxformat2 workflow is high-value signal for constructing the draft — input/collection shapes, map-over wiring, output promotion, post-job actions. Agents have seen far more legacy `.ga` JSON than gxformat2 YAML in training, so surface the converted view rather than leaving it as prose.

Once the nearest exemplar is chosen (High or Medium confidence):

- Convert it with convert (`--to format2 --compact`).
- Write the cleaned gxformat2 of the **relevant subgraph** to the `iwc-exemplar.gxwf.yml` sibling artifact — the slice that matches the briefs' structure, not the whole workflow.
- Inline a bounded excerpt (~10–40 lines) of that subgraph under a labeled section in `iwc-comparison-notes.md`, and cite the abstract IWC workflow ID (e.g. `transcriptomics/rnaseq-pe/rnaseq-pe`) plus the step labels it covers. Cross-reference the sibling file for the fuller view.

Keep it size-bounded — a whole large workflow is noise; the relevant subgraph is the signal. When the result is "no nearest exemplar," emit neither the sibling file nor the excerpt. A Low-confidence cross-domain match may surface a short excerpt for pattern comparison but should be labeled as such, not as a domain exemplar.

### Non-goals

- **No tool discovery.** Do not replace discover-shed-tool.
- **No automatic rewrite.** This skill emits structural diff guidance; the harness or user decides which changes to apply.
- **No forced nearest.** A no-match result is valid when IWC lacks a close exemplar.

## Feedback Mode

- Feedback mode is off unless the caller explicitly enables `--feedback` or supplies a feedback-ledger path.
- When enabled, read `_feedback.md` before doing the work and use its registered `foundry-feedback.ledger.yml` protocol.
- Preserve harness-owned run and phase state. Append only concrete observations about a canonical Foundry source asset or a related project that this run showed to be at fault; do not put ordinary workflow requirements in this ledger.
- Before reporting completion, make one explicit pass over the work you just did. Do not ask yourself whether anything was unclear — recall what happened: where you guessed at something the instructions should have settled, needed information this bundle does not carry, hit an instruction that contradicted another or contradicted the artifacts in front of you, used a packaged reference that did not cover your case, or did something the procedure never describes.
- Append an entry for each such event that clears the protocol's bar. If none do, append nothing and report `no feedback` explicitly. Silence and a clean pass are not the same thing, and nothing downstream can tell them apart unless you say which one it was.
- Pass the same ledger path to any subagent used for this work, and merge updates serially so one writer cannot overwrite another.

## Runtime Notes

- Do not read Foundry source files at runtime; use only files packaged in this skill bundle and user-supplied artifacts.
- Preserve declared artifact filenames unless the user or harness supplies explicit paths.
- Carry unresolved assumptions into the output artifact instead of silently inventing missing source evidence.
