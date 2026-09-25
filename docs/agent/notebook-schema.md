# Notebook schema and plans

## Project model

A "project" is the working directory you're invoked in. Inside, the
researcher does ad-hoc exploration, drafts plans, executes them,
interprets results, and may draft further plans based on the
interpretation. **Multiple plans coexist in one project's notebook**,
chronologically.

## `notebook.md` — the project log

The notebook is **plain user/agent-curated markdown** that you maintain
via the Edit and Write tools. It is auto-initialized on session start
and committed to git on every change.

When the user says "add / append / write something to the notebook" —
that is a file edit on `notebook.md`, nothing else. There are no
`analysis_*` plan tools.

## Plans as markdown sections

When the researcher asks for a plan, write a `## Plan X: <title>`
section into `notebook.md` using Edit/Write:

```markdown
## Plan A: chrM Variant Calling [hybrid]

Question: how do mtDNA variants distribute across tissues in this dataset?

### Steps

- [ ] 1. **QC FASTQ** {#plan-a-step-1} — fastp adapter trim + per-base QC
  - Routing: local
  - Verification: confirm fastp HTML/JSON report exists and includes per-base quality metrics
- [ ] 2. **Reference index** {#plan-a-step-2} — bwa index of chrM
  - Routing: local
  - Verification: confirm BWA index sidecar files and `.fai` exist
- [ ] 3. **Read alignment** {#plan-a-step-3} — bwa mem PE 4 samples
  - Routing: Galaxy (bwa-mem2/2.2.1)
  - Verification: poll Galaxy jobs to `ok` and inspect BAM outputs
- ...

### Parameters

| Step | Parameter | Value |
| ---- | --------- | ----- |
| 1    | min_qual  | 20    |
```

Conventions:

- `## Plan X: <Title> [routing]` — routing tag is `[galaxy]`, `[hybrid]`,
  `[local]`, or `[remote]`. `[galaxy]` is the default when a matching Galaxy
  tool/workflow exists. Future tooling greps for these literals.
- `{#plan-x-step-N}` anchors so invocation YAML can reference steps.
- Every step needs a concrete `Verification:` sub-bullet describing the
  evidence required before completion.
- Mark step status by editing the checkbox: `- [ ]` pending, `- [x]`
  verified completed, `- [!]` failed. Do not mark `- [x]` until the
  verification evidence is written into the notebook. Flipping a step to
  `- [x]` while the `loom-invocation` block bound to its anchor still
  reads `status: in_progress` is checked by the harness, not just asked
  for. See the evidence gate in `docs/agent/galaxy-routing.md`.
- If a verification check is blocked or inconclusive but the step itself
  has not failed, leave the checkbox pending and record the blocker.
- Multiple plans coexist; append new plan sections at the bottom of the
  notebook. Don't delete old plans.

Verification examples should be specific to the artifact: `samtools
quickcheck` / `flagstat` for BAM, header + record/sample checks for VCF,
read/sequence counts for FASTQ/FASTA, parser + required keys/columns for
JSON/YAML/CSV/TSV, and Galaxy state/datatype/metadata/peek checks for
remote datasets.

**Don't propose a plan unless asked.** Most user requests are questions,
explorations, summaries, ad-hoc edits — answer those directly. A plan
is for multi-step pipeline orchestration the user explicitly wants
driven (e.g. "draft a plan for variant calling on this data").

## `loom-invocation` and `loom-job` blocks

Every Galaxy submission gets a block. A workflow invocation gets
`loom-invocation`, keyed on `invocation_id`; a tool run gets `loom-job`,
keyed on `job_id`, one block per job (a mapped-over run produces several).
The background poller advances `status` from Galaxy job state.

```loom-invocation
invocation_id: ff1e2d3c4b5a6978
galaxy_server_url: https://usegalaxy.org
notebook_anchor: plan-a-step-3
label: BWA alignment
submitted_at: 2026-09-16T15:30:00Z
status: in_progress
summary:
server_verified: true
attempt_id: 01K5CJ6XWQ8QK4S2M7E9V0TZ3B
history_id: 0a248a1f62a0cc04
submitted_by: harness
enrichment: pending
```

The first block of fields is the record: `label` and `notebook_anchor` say
what the run is and which plan step it belongs to, and those are yours to
set. `server_verified` says whether Galaxy has confirmed the id -- `true`
when it was read out of Galaxy's own response to the submission or a poll
has since answered for it, `false` when a record call asked and Galaxy did
not answer. Everything from `attempt_id` down is **harness-only**:

- `attempt_id` -- ULID minted when the submission was dispatched. Joins the
  block to its full provenance record under `.loom/provenance/`.
- `history_id` -- the Galaxy history the work landed in.
- `submitted_by` -- `harness` when Loom watched the submission happen,
  `agent` when only a record call reported it, `unknown` when reconciliation
  found it on Galaxy with nothing here to match.
- `enrichment` / `enrichment_attempts` -- whether per-job tool versions,
  parameters, inputs and outputs have been backfilled from Galaxy yet
  (`pending`, `complete`, `unavailable`).
- `jobs` -- compact per-job summary, single-line JSON:
  `[{"job_id":"...","tool_id":"...","tool_version":"...","state":"ok"}]`.
- `drift` -- tool versions that moved between attempts bound to the same
  step: `[{"tool_id":"...","from":"0.7.17","to":"0.7.18"}]`.

Do not write these yourself. They are stripped from anything the record
tools are handed, so setting them has no effect -- the harness writes them
from what Galaxy returned, and that is exactly what makes them worth
anything. Blocks are also written automatically the moment a submission
succeeds, so you do not need a record call to make a run pollable; what a
record call is still for is naming the step the run belongs to.

## `loom-galaxy-page` binding block

Records the binding between this notebook and a Galaxy page (see
galaxyproject/galaxy#22361, Galaxy Notebooks). One block per notebook for
now -- the upsert grammar is keyed on `page_id` so future per-plan
bindings are forward-compatible.

```loom-galaxy-page
page_id: <encoded page id>
page_slug: <optional slug>
galaxy_server_url: "<scheme://host>"
history_id: <encoded history id>
last_synced_revision: <encoded revision id or empty>
bound_at: <ISO 8601 timestamp>
```

This block is **stripped from the body** when pushing to Galaxy and
**re-applied on top** of the remote body when pulling. It is the durable
record of where this notebook lives on Galaxy. Don't edit it by hand --
use the `notebook_link_galaxy_page` tool to create or change a binding.

Sync semantics:

- `notebook_push_to_galaxy` -- unconditional local-wins. Overwrites the
  Galaxy page body. Bumps `last_synced_revision` to the new revision id.
- `notebook_pull_from_galaxy` -- unconditional remote-wins. Replaces local
  notebook content with the Galaxy page body. Bumps `last_synced_revision`
  to the latest revision id.
- `notebook_resume_from_galaxy` -- one-shot link + pull for picking up a
  page that was started or last edited in the Galaxy UI. On a fresh
  (unbound) notebook it writes the binding block and replaces the body
  with the remote page content in a single locked op. If the notebook is
  already bound to the same page it just refreshes (preserving
  `bound_at`). If it's bound to a different page on the same server the
  tool refuses -- use `notebook_link_galaxy_page` to switch explicitly.
- Server URL mismatch fails closed: if `galaxy_server_url` does not match
  the currently connected Galaxy, push / pull / resume all error out
  before any network call. Use `/connect` to switch.

## Notebook persistence and git

When `notebook.md` is created in a directory that isn't a git repo,
Loom runs `git init`, drops a bioinformatics-friendly `.gitignore`,
and marks the repo with `git config loom.managed true`. From then on
every notebook write triggers an auto-commit. This gives you:

- **Full undo history.** `git log` shows exactly what changed and when.
- **Reproducibility evidence.** Timestamped, immutable record.
- **Branch-based exploration.** Try alternatives on branches.
- **Collaboration.** Push to GitHub; collaborators can pull.

If the user starts Loom in an **existing** git repo, auto-commit stays
off by default -- Loom won't write commits into a project it didn't
create. The user can opt in with `git config loom.managed true`. This
is the right default; do not work around it by calling git directly.

The auto-created `.gitignore` excludes large bioinformatics files
(FASTQ, BAM, VCF) and the per-session `activity.jsonl` /
`session.jsonl` sidecars, so only the notebook markdown and small
artifacts get tracked.
