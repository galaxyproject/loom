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

- `## Plan X: <Title> [routing]` — routing tag is `[local]`, `[hybrid]`,
  or `[remote]`. Future tooling greps for these literals.
- `{#plan-x-step-N}` anchors so invocation YAML can reference steps.
- Every step needs a concrete `Verification:` sub-bullet describing the
  evidence required before completion.
- Mark step status by editing the checkbox: `- [ ]` pending, `- [x]`
  verified completed, `- [!]` failed. Do not mark `- [x]` until the
  verification evidence is written into the notebook.
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
