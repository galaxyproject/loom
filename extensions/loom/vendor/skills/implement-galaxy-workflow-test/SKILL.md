---
name: implement-galaxy-workflow-test
description: "Assemble Galaxy workflow test fixtures and assertions."
---

# implement-galaxy-workflow-test

Follow the procedure below and use the artifact/reference sections as the runtime contract.

## When To Use

- Assemble Galaxy workflow test fixtures and assertions.

## Inputs

- Read artifact `galaxy-test-plan`. Schema: galaxy-workflow-test-plan. Produced by `changeset-to-galaxy-test-plan`, `cwl-test-to-galaxy-test-plan`, `freeform-summary-to-galaxy-test-plan`, `nextflow-test-to-galaxy-test-plan`. Schema-valid Galaxy test plan (galaxy-workflow-test-plan) from a *-test-to-galaxy-test-plan Mold; carries job inputs, expected outputs, assertion intent, fixture provenance, label assumptions, unresolved mappings, and omissions.
- Read artifact `galaxy-workflow`. Produced by `advance-galaxy-draft-step`, `mature-galaxy-workflow-for-iwc`. Concrete gxformat2 workflow being tested — the loop-endstate `galaxy-workflow.gxwf.yml` from advance-galaxy-draft-step (`class: GalaxyWorkflow`); provides the real input/output labels, outputs, and collection shapes the test must assert against.
- Read artifact `test-data-refs`. Produced by `cwl-to-test-data`, `find-test-data`, `nextflow-to-test-data`, `paper-to-test-data`. Resolved test data references (URLs, paths, expected shapes) from paper-to-test-data or find-test-data.

## Outputs

- Write artifact `galaxy-workflow-test` as `galaxy-workflow.gxwf-tests.yml`. Format: `yaml`. Galaxy workflow test file (tests-format) with job inputs, expected outputs, assertions; passes static schema + label cross-check. Named as the workflow basename + `-tests.yml` so Planemo discovers it as the companion of `galaxy-workflow.gxwf.yml`.

## Required Tools

- **`gxwf`** (gxwf). `npm install -g '@galaxy-tool-util/cli@^1.8.1'`.
  Ephemeral run: `npx --yes --package @galaxy-tool-util/cli@1.8.1 gxwf`.
  Check: `gxwf --help | grep -q draft-validate`.
  Docs: https://github.com/jmchilton/galaxy-tool-util-ts/tree/main/packages/cli
- **`planemo`** (planemo). `uv tool install planemo==0.75.47` (or `pip install planemo==0.75.47`).
  Ephemeral run: `uvx --from planemo==0.75.47 planemo`.
  Check: `planemo --version`.
  Docs: https://planemo.readthedocs.io/
  Bundled reference: `references/cli/planemo.md`.

## Load Upfront

- `references/cli/planemo.md`: CLI tool reference copied verbatim into the bundle. Runtime for workflow_test_init / workflow_test_on_invocation; install before authoring tests against a live invocation.
- `references/schemas/galaxy-workflow-test-plan.schema.json`: Schema file copied verbatim into the bundle. Input contract: read the schema-valid Galaxy test plan (job inputs, expected outputs, assertion intent, tolerances, label assumptions, unresolved mappings, omissions) and convert it into tests-format output, reconciling assumed labels and fixtures against the real draft.
- `references/schemas/tests-format.schema.json`: Schema file copied verbatim into the bundle. JSON Schema contract for the Galaxy workflow test format. Output of this Mold must validate against it.

## Load On Demand

- `references/cli/validate-tests.json`: CLI command reference packaged as a sidecar. Run the cheap static workflow-test validation and workflow-label cross-check before Planemo execution. Use when: after authoring or editing a Galaxy workflow test file and before Planemo invocation.
- `references/notes/galaxy-workflow-testability-design.md`: Research note copied verbatim into the bundle. Revise workflow inputs, outputs, labels, checkpoints, and collection identifiers so meaningful tests can be authored. Use when: test authoring reveals missing labels, omitted workflow-level outputs, unstable collection identifiers, weakly assertable final outputs, or fixture-shape pressure on workflow inputs.
- `references/notes/iwc-shortcuts-anti-patterns.md`: Research note copied verbatim into the bundle. Flag assertion shortcuts that are acceptable in IWC versus shortcuts that should be avoided. Use when: considering existence-only, size-only, image-only, checksum, output-label, or negative-test patterns.
- `references/notes/iwc-test-data-conventions.md`: Research note copied verbatim into the bundle. Assemble job input fixtures, remote URLs, hashes, collection shapes, and test-data layout in IWC style. Use when: writing or revising the job/input side of a Galaxy workflow test file.
- `references/notes/planemo-asserts-idioms.md`: Research note copied verbatim into the bundle. Choose assertion families, tolerance magnitudes, and the static/Planemo validation loop. Use when: writing or revising output assertions for a Galaxy workflow test file.
- `references/notes/planemo-workflow-test-architecture.md`: Research note copied verbatim into the bundle. Write tests with stable labels and artifacts that Planemo can connect back to Galaxy invocations, jobs, and outputs. Use when: adding or revising workflow tests that will be iterated with Planemo or generated from existing invocations.

## Validation

- None declared.

## Procedure

Assemble a Galaxy workflow test file (`tests-format`) from the schema-valid Galaxy test plan (galaxy-workflow-test-plan), the concrete gxformat2 workflow (`galaxy-workflow.gxwf.yml`), and the resolved test-data refs. One invocation produces the companion test file whose job inputs come from the workflow inputs and whose assertions come from the plan's assertion intent. The output must validate against tests-format and pass the workflow-label cross-check before any Planemo run.

**Name the companion off the workflow's basename.** Planemo discovers the test file by stripping only the workflow's final extension and appending `-tests.yml`, so the companion of `galaxy-workflow.gxwf.yml` is `galaxy-workflow.gxwf-tests.yml` (keep the `.gxwf`) — not `galaxy-workflow-tests.yml`. Derive the name from whatever the workflow file is actually called; a `.ga` workflow would instead pair with `<basename>-tests.yml`.

The workflow is the contract: input and output labels in the test file must address real workflow input/output labels. The test plan's bindings may be `assumed` or `unresolved` — especially for synthesized (freeform-sourced) plans whose `workflow.label_source` is `interface-brief` — so reconcile each plan binding against the real workflow labels here, and resolve `unresolved[]` entries and `storage: unresolved` fixtures against the workflow and the resolved test-data refs. When authoring reveals a missing label, an omitted workflow output, or an unstable collection identifier, treat it as testability pressure on the workflow itself — surface it per galaxy-workflow-testability-design rather than asserting around it.

### Sequence

1. **Bootstrap.** Prefer generating the test skeleton from a real invocation, not from scratch:
   - **`planemo workflow_test_init --from_invocation <id>`** (planemo-workflow_test_init) — preferred bootstrap for new test files; reviewer convention. See planemo-asserts-idioms §7.
   - **`planemo workflow_test_on_invocation <tests.yml> <id>`** (planemo-workflow_test_on_invocation) — fast assertion-iteration loop without re-running the workflow.
2. **Author job inputs and stage their data.** Wire each workflow input to a `test-data-refs` entry, and make the data the test references actually exist on disk before any Planemo run:
   - **Prefer a bare remote `location:`** (iwc-test-data-conventions, remote-URL-first) whenever the ref is a single fetchable artifact — Galaxy fetches it at upload time, so nothing is staged locally. Record the hash when known.
   - **Materialize a local `test-data/` layout only when the ref needs prep a URL can't express** — a concatenation (e.g. per-isolate chromosome+plasmid into one FASTA), a subset (one chromosome, selected loci), or a column split into named collection elements. In that case the test file's `path:` entries point at files this skill writes: fetch from the ref's verified source URLs, run the documented prep, and lay the result out in the `test-data/` directory addressed by the `*-tests.yml`, relative to the workflow. The collection element identifiers in the staged layout must match the test file and the workflow labels exactly.
   - Never emit a `path:` (or `location:`) the test references but no source produces — an un-materialized path passes the static cross-check and fails only at upload, far from here. If a ref is `resolved: false`, surface the gap rather than authoring a path to a file that does not exist.

   Inputs must match the workflow's collection shapes and datatypes.
3. **Author assertions.** Materialize the plan's assertion intent into concrete output assertions. Choose assertion families and tolerances per planemo-asserts-idioms; check each shortcut against iwc-shortcuts-anti-patterns so an existence-only or size-only assertion is a deliberate choice, not an evasion. Honor the plan's `omissions[]` and treat low-`confidence` synthesized intent as a starting point to tighten against the real invocation.
4. **Validate static.** Run validate-tests for the schema gate, then the workflow-label cross-check (`checkTestsAgainstWorkflow`): zero missing input labels, zero missing output labels, no collection/datatype mismatches. Fix before spending a Planemo run.
5. **Run green.** Drive planemo `test` with the staged data. "Managed Galaxy" here means **Planemo-managed**: `planemo test` bootstraps its own Galaxy and installs the workflow's tools from the Tool Shed/conda — it does **not** require a pre-provisioned external server, so absence of a running Galaxy is not a reason to skip this gate (cost/runtime of heavy tool or reference-DB installs may be, but that is a deliberate deferral, not an impossibility). On green, hand off the test file plus enough invocation/job/assertion context for run-workflow-test and debug-galaxy-workflow-output to use if a later run fails.

Author tests with stable labels and artifacts that Planemo can connect back to Galaxy invocations, jobs, and outputs (planemo-workflow-test-architecture) — that traceability is what makes the downstream debug skill able to locate failure evidence.

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
