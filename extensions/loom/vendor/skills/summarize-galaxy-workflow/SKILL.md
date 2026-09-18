---
name: summarize-galaxy-workflow
description: "Read an existing Galaxy gxformat2 (or .ga) workflow and emit a structured summary for interview and change-set steps."
---

# summarize-galaxy-workflow

Follow the procedure below and use the artifact/reference sections as the runtime contract.

## When To Use

- Read an existing Galaxy gxformat2 (or .ga) workflow and emit a structured summary for interview and change-set steps.

## Inputs

- No upstream artifact inputs declared. See the procedure for user-supplied runtime inputs.

## Outputs

- Write artifact `summary-galaxy-workflow` as `summary-galaxy-workflow.json`. Format: `json`. Schema: summary-galaxy-workflow. Structured summary of an existing Galaxy workflow: source/format provenance, inputs, outputs, per-step tool_id/version/tool_state, edge graph, and any existing tests as a regression baseline.
- Write artifact `starting-galaxy-workflow` as `starting-galaxy-workflow.gxwf.yml`. Format: `yaml`. The normalized concrete gxformat2 workflow this summary describes — passthrough when the input was already gxformat2, the `.ga`→gxformat2 conversion otherwise. The substrate apply-galaxy-workflow-changeset edits; distinct from the summary JSON, which is only context.

## Required Tools

- **`foundry`** (foundry). `npm install -g @galaxy-foundry/gxwf-foundry`.
  Ephemeral run: `npx --package @galaxy-foundry/gxwf-foundry foundry`.
  Check: `foundry --help`.
  Docs: https://github.com/galaxyproject/foundry/blob/main/packages/gxwf-foundry/README.md
  Bundled reference: `references/cli/foundry.md`.
- **`gxwf`** (gxwf). `npm install -g '@galaxy-tool-util/cli@^1.8.1'`.
  Ephemeral run: `npx --yes --package @galaxy-tool-util/cli@1.8.1 gxwf`.
  Check: `gxwf --help | grep -q draft-validate`.
  Docs: https://github.com/jmchilton/galaxy-tool-util-ts/tree/main/packages/cli

## Load Upfront

- `references/cli/validate.json`: CLI command reference packaged as a sidecar. Validate the gxformat2 workflow before extraction and record diagnostics under documents.validation. Use when: before extracting structure from the workflow document.
- `references/cli/foundry.md`: CLI tool reference copied verbatim into the bundle. Schema-check summary-galaxy-workflow.json with `foundry validate-summary-galaxy-workflow` before returning it from the skill.
- `references/schemas/summary-galaxy-workflow.schema.json`: Schema file copied verbatim into the bundle. Validate the emitted Galaxy workflow summary JSON and provide downstream consumers the output contract.

## Load On Demand

- `references/cli/convert.json`: CLI command reference packaged as a sidecar. Convert a legacy `.ga` workflow to gxformat2 before summarizing, and record the conversion under documents.converted_path. Use when: the supplied workflow is native `.ga` rather than gxformat2.

## Validation

- Validate `summary-galaxy-workflow.json` before returning it: run `foundry validate-summary-galaxy-workflow summary-galaxy-workflow.json` from `@galaxy-foundry/gxwf-foundry`. If the command is not on PATH, run `npx --package @galaxy-foundry/gxwf-foundry foundry validate-summary-galaxy-workflow summary-galaxy-workflow.json`. This checks artifact `summary-galaxy-workflow` against the summary-galaxy-workflow schema.

## Procedure

Read an existing Galaxy workflow and emit `summary-galaxy-workflow.json`. This skill is source-specific and target-agnostic: it records what the workflow *is* — inputs, outputs, steps, wiring, and existing tests — and leaves every modification decision to the downstream change-set and apply skills. It mirrors summarize-cwl on the Galaxy-as-source side.

gxformat2 is already a typed workflow graph, so do not infer structure — read it. The summary is an LLM-digestible index of the existing workflow that anchors the interview and the change-set; it is **context**, not the substrate edits apply to. The substrate the edits are applied against is the normalized gxformat2 workflow file, emitted here as `starting-galaxy-workflow.gxwf.yml` and consumed by apply-galaxy-workflow-changeset — not this JSON summary. Because this skill already normalizes `.ga` to gxformat2, it is the natural carrier for that substrate: a `.ga` input's converted form would otherwise have no declared home.

### Inputs

- A local workflow path or an HTTP(S) URL. Accept both gxformat2 (`.gxwf.yml` / `.gxfmt2.yml`) and legacy native `.ga`.
- Optional pin/version metadata supplied by the harness or user.
- Optional sibling tests file (`*-tests.yml`); if none is supplied or discoverable, emit `tests: []`.

### Procedure

1. **Normalize format.** If the input is native `.ga`, convert it to gxformat2 with convert (`--to format2`) and record the output path in `documents.converted_path`. If it is already gxformat2, leave `converted_path` null. Set `source.original_format` accordingly. All downstream extraction reads the gxformat2 form. Emit this normalized gxformat2 as the `starting-galaxy-workflow.gxwf.yml` output — the substrate apply-galaxy-workflow-changeset edits, so a `.ga` input's converted form has a real carrier rather than living only inside the summary.
2. **Validate.** Run gxwf validate on the gxformat2 workflow and record `command`, `status`, and `diagnostics` under `documents.validation`. If invalid, still emit source provenance and diagnostics; do not invent graph structure past what parses.
3. **Extract the interface.** Record `workflow_inputs` (class `data` / `collection` / `parameter`, `collection_type`, optionality, defaults, format restrictions) and `workflow_outputs` (each promoted `step/output` source), preserving gxformat2 labels verbatim — those labels are the anchors the change-set will address.
4. **Extract steps.** For each step record its class, `tool_id`, `tool_version`, pinned `tool_shed_repository`, verbatim `tool_state`, named input connections with their upstream sources, declared outputs, and any `when:` guard. Keep `tool_state` verbatim so a later change-set can address an individual parameter. Record each declared output under `out[]` as `{id, actions}`, preserving the gxformat2 post-job actions on that output (`hide`, `rename`, `add_tags`, `remove_tags`, `change_datatype`, `delete_intermediate`, …) verbatim in `actions` — `actions: null` when the output has none. A hidden output that is not promoted to a `workflow_outputs` entry is only visible through its `hide` action here, so dropping it would blind an expose-output change-set to the very anchor it edits.
5. **Build the graph.** Emit workflow-input → step, step → step, and step → workflow-output edges. Add `via` markers for shape-affecting features (map-over, batch, collection reduction).
6. **Record tests.** When a sibling tests file or embedded tests exist, record each case's name, job path, and expected outputs as the regression baseline. Do not fabricate expected outputs from tool names.
7. **Schema-check.** Validate the assembled object with `foundry validate-summary-galaxy-workflow summary-galaxy-workflow.json` before returning it.

### Caveats Baked Into The Procedure

- **Labels are load-bearing.** Preserve step and input labels exactly; the change-set anchors edits to them, and a relabel here would silently break that anchoring.
- **`tool_state` is preserved, not interpreted.** Record it verbatim. Deciding which parameter an interview wants changed is the change-set's job, not this skill's.
- **Post-job actions are preserved, not interpreted.** Record each output's gxformat2 actions verbatim under `out[].actions` (`hide`, `rename`, `add_tags`, …); whether to expose a hidden output or drop a rename is the change-set's decision, not this skill's. Flattening `out` to bare names would erase that anchor.
- **Existing tests are the regression baseline.** Capture them faithfully; the update pipeline judges the modified workflow against them.
- **Conversion is lossy-aware.** If `.ga` → gxformat2 conversion drops or rewrites anything, surface it in `warnings[]` rather than presenting a clean summary.

### Non-Goals

- **Modification.** Interviewing for changes, building a change-set, and applying edits belong to interview-to-galaxy-workflow-changeset and apply-galaxy-workflow-changeset.
- **Tool discovery or wrapper authoring.** `tool_id` / `tool_shed_repository` are recorded as-found; resolving newly introduced tools is the per-step Galaxy loop's job.
- **Runtime execution.** This skill summarizes structure; run-workflow-test owns execution.

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
