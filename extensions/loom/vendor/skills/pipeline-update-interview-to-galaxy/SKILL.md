---
name: pipeline-update-interview-to-galaxy
description: "Interview-driven, edit-in-place modification of an existing Galaxy gxformat2 workflow via a reviewable change-set, reusing the per-step draft loop — orchestrates the Foundry skills of the UPDATE-INTERVIEW → GALAXY pipeline in order, in a per-run working directory."
---

# pipeline-update-interview-to-galaxy

Harness for the **UPDATE-INTERVIEW → GALAXY** Foundry pipeline. Runs the constituent skills in order inside a single per-run working directory. Assembled from `content/pipelines/update-interview-to-galaxy/index.md` (revision 2) — regenerate with `foundry-build assemble-pipeline update-interview-to-galaxy` if the pipeline changes; do not hand-edit.

## When To Use

- Interview-driven, edit-in-place modification of an existing Galaxy gxformat2 workflow via a reviewable change-set, reusing the per-step draft loop.

## Bootstrap (install these CLIs first)

Install the harness CLIs every constituent skill invokes before driving the pipeline. Deduped across all phases; bioinformatics tools the constructed workflow installs are out of scope (the discovery phase pins those).

- **`foundry`** (foundry). `npm install -g @galaxy-foundry/gxwf-foundry`.
  Ephemeral run: `npx --package @galaxy-foundry/gxwf-foundry foundry`.
  Check: `foundry --help`.
  Docs: https://github.com/galaxyproject/foundry/blob/main/packages/gxwf-foundry/README.md
- **`galaxy-tool-cache`** (galaxy-tool-cache). `npm install -g '@galaxy-tool-util/cli@^1.8.1'`.
  Ephemeral run: `npx --yes --package @galaxy-tool-util/cli@1.8.1 galaxy-tool-cache`.
  Check: `galaxy-tool-cache --help | grep -q summarize`.
  Docs: https://github.com/jmchilton/galaxy-tool-util-ts/tree/main/packages/cli
- **`gxwf`** (gxwf). `npm install -g '@galaxy-tool-util/cli@^1.8.1'`.
  Ephemeral run: `npx --yes --package @galaxy-tool-util/cli@1.8.1 gxwf`.
  Check: `gxwf --help | grep -q draft-validate`.
  Docs: https://github.com/jmchilton/galaxy-tool-util-ts/tree/main/packages/cli
- **`planemo`** (planemo). `uv tool install planemo==0.75.47` (or `pip install planemo==0.75.47`).
  Ephemeral run: `uvx --from planemo==0.75.47 planemo`.
  Check: `planemo --version`.
  Docs: https://planemo.readthedocs.io/

## Run options

Optional flags, given as leading arguments. Strip any you recognize; treat the remaining positional argument as the run slug. All default off and compose.

- `--use-subagents` — run each cast phase in its own subagent to keep this orchestrator's context small. For each phase whose skill is cast, spawn a subagent, tell it the run directory and to invoke the named skill with every default filename prefixed by `./<run-slug>/`, and have it return a short report (artifacts written, assumptions, status) rather than its full transcript; carry only that report forward. A cast loop phase runs **one subagent per iteration** — each advances a single step and returns its done-signal, and you inspect that signal to decide whether to spawn the next iteration. Branch phases run their whole fallback chain in one subagent. MANUAL (un-cast) phases are never delegated — including MANUAL loop phases — so handle those yourself regardless of the per-iteration rule above.
- `--checkpoint` — commit after every phase so the run directory's git history is a per-step record (a data source for workflow-implementation visualizations). When set, `git init ./<run-slug>/` during working-directory setup — this is a standalone per-run repo; do not add it to any surrounding repo you are working inside. Then after each phase's artifact is confirmed run `git -C ./<run-slug>/ add -A && git -C ./<run-slug>/ commit -m "phase <n>: <skill>"`. Loop phases commit **once per iteration** (`phase <n> step <k>: <skill>`); for a MANUAL loop, commit once per by-hand step. With `--use-subagents`, the subagent does the work and returns; you make the commit.
- `--feedback` — create `./<run-slug>/foundry-feedback.ledger.yml` before phase 1. Set `run.pipeline` to this pipeline's slug and `run.run_slug` to the chosen run slug. Copy the complete top-level roster from `_assembly.json` with `run.status: running` and every phase `pending`; set a phase `running` immediately before it starts and `done` after success. Keep one row per loop and increment `iterations`; record a branch's chosen path as `selected`. Pass the same ledger path to every skill and subagent. Before marking a phase `done`, require its feedback outcome — appended entry ids or an explicit `no feedback` — and record `feedback_checked: true` on that row; under `--use-subagents` the subagent's short report carries that line. Do the same pass yourself for a MANUAL phase, naming the pipeline source as the subject when the harness is what needs to change. On a terminating error mark the phase and run `failed`; on a graceful stop mark the run `cancelled`; after every intended phase is done mark the run `complete`. Never describe an empty incomplete ledger as a clean run.

## Working directory (do this first)

Every constituent skill writes fixed filenames to its working directory. To keep one run's artifacts namespaced and avoid clobbering a prior run (foundry#282):

1. Pick a run slug — use the harness argument if given; else ask the user for a short project name up front (the directory must exist before phase 1 writes its first artifact, so don't wait for a source title); else default `update-interview-to-galaxy-run`.
2. Create `./<run-slug>/` in the current directory. If it exists, suffix `-2`, `-3`, … . If invoked with `--checkpoint`, run `git init ./<run-slug>/` now (see Run options).
3. Run **every** skill invocation below with `./<run-slug>/` as its working directory: **prefix every default input and output filename with `./<run-slug>/`** when you invoke the skill. The skills preserve their declared basenames and honor a harness-supplied directory; you supply the prefix on **both reads and writes**, so each phase finds the prior phase's output and nothing lands in the repo root.

Announce the chosen directory before starting.

## Pipeline

Run these phases in order. After each, confirm the expected artifact exists in the run directory before advancing.

1. **summarize-galaxy-workflow** — invoke the `summarize-galaxy-workflow` skill. Read an existing Galaxy gxformat2 (or .ga) workflow and emit a structured summary for interview and change-set steps.
2. **interview-to-galaxy-workflow-changeset** — invoke the `interview-to-galaxy-workflow-changeset` skill. Interview a user against an existing Galaxy workflow summary and emit a reviewable, step-anchored change-set.
3. **apply-galaxy-workflow-changeset** — invoke the `apply-galaxy-workflow-changeset` skill. Apply a reviewed change-set to a concrete Galaxy workflow: untouched regions preserved, tool-introducing edits injected as drafty steps.
4. **advance-galaxy-draft-step** (loop) — invoke the `advance-galaxy-draft-step` skill, once per step. It owns its own endstate oracle (`gxwf draft-next-step`) and concretizes one drafty step per call; re-invoke until it reports `draft: false`, then it extracts the concrete `galaxy-workflow.gxwf.yml` (via `gxwf draft-extract`) and continues.
5. **changeset-to-galaxy-test-plan** — invoke the `changeset-to-galaxy-test-plan` skill. Carry an existing Galaxy workflow's tests forward as a regression baseline and augment them for a change-set's deltas, emitting a Galaxy test plan.
6. **implement-galaxy-workflow-test** — invoke the `implement-galaxy-workflow-test` skill. Assemble Galaxy workflow test fixtures and assertions.
7. **validate-galaxy-workflow** — invoke the `validate-galaxy-workflow` skill. Run terminal gxwf validation on an assembled Galaxy workflow and classify workflow-level failures.
8. **run-workflow-test** — invoke the `run-workflow-test` skill. Execute a workflow's tests via Planemo; emit structured pass/fail and outputs.
9. **debug-galaxy-workflow-output** — invoke the `debug-galaxy-workflow-output` skill. Triage failing Galaxy run outputs; classify the failure surface and capture evidence before recommending repairs.

## Done

Report the final artifacts in `./<run-slug>/`.

If the run was invoked with `--feedback`, close the ledger first: set the final `run.status`, then tell the user the ledger path `./<run-slug>/foundry-feedback.ledger.yml` and how many entries it holds. If it holds any, offer to run the `report-foundry-run-feedback` skill on it, which triages them into local drafts and files nothing without explicit confirmation. Report an empty ledger as "no feedback recorded", never as evidence the Foundry worked well.

## Notes

- Do not re-implement any skill's internal logic here; this harness only sequences and routes.
- Carry unresolved assumptions forward as notes rather than inventing missing inputs.
- The workflow is both an input and the output — the Foundry's first GALAXY → GALAXY (edit) pipeline. Untouched regions must stay byte-stable; only change-set targets change.
- The live interview mechanics are harness-owned and precede phase 2, exactly as in INTERVIEW → GALAXY.
- A `.ga` input is converted to gxformat2 inside phase 1 (summarize-galaxy-workflow); the modification is judged against the converted baseline.
- Only edits that introduce or replace a tool make the phase-4 loop run; a change-set of purely direct edits leaves the draft concrete (`draft: false`) and the loop is a no-op.
- Tests: the existing workflow's `*-tests.yml` (captured in the phase-1 summary) is the regression baseline. changeset-to-galaxy-test-plan carries those cases forward and augments them for the change-set's behavioral deltas, emitting the `galaxy-test-plan` that implement-galaxy-workflow-test authors into the final tests; run-workflow-test then runs them as the regression check. `test-data-refs` come from the baseline's existing fixtures (or find-test-data when a change-set-added input needs new data).
