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
     Routing: local
- [ ] 2. **Reference index** {#plan-a-step-2} — bwa index of chrM
     Routing: local
- [ ] 3. **Read alignment** {#plan-a-step-3} — bwa mem PE 4 samples
     Routing: Galaxy (bwa-mem2/2.2.1)
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
- Mark step status by editing the checkbox: `- [ ]` pending, `- [x]`
  completed, `- [!]` failed.
- Multiple plans coexist; append new plan sections at the bottom of the
  notebook. Don't delete old plans.

**Don't propose a plan unless asked.** Most user requests are questions,
explorations, summaries, ad-hoc edits — answer those directly. A plan
is for multi-step pipeline orchestration the user explicitly wants
driven (e.g. "draft a plan for variant calling on this data").

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
