---
title: Concepts
description: The notebook model, plans and routing, the approval sequence, and live invocation tracking.
group: Guides
order: 2
---

# Concepts

Agentic bioinformatics can produce useful work, but the familiar failure mode is
that decisions happen in chat, parameters drift, provenance is reconstructed after
the fact, and a plausible final answer hides weak intermediate validation. Loom's
answer is to make the working record explicit *while* the analysis is happening.

## The notebook is the project

`notebook.md` in the analysis directory is the durable working record. Plans,
parameter tables, execution notes, interpretation, and follow-up questions are all
written to a notebook you can inspect, edit, diff, and share. The agent reads and
writes that notebook directly — there is no parallel structured-state store to
drift out of sync.

Galaxy histories remain the computational truth. The notebook is the shareable,
inspectable record of *how you got there*.

## Plans and routing

When you ask for a plan, the agent drafts a `## Plan X:` section. Each plan header
carries a routing tag, and each step is tagged too:

- `[galaxy]` — runs on Galaxy (an IWC workflow matches, or the heavy tool lives on Galaxy). This is the primary execution path.
- `[local]` — runs on your machine.
- `[hybrid]` — a mix.

Steps use markdown checkboxes and stable anchors:

```markdown
## Plan A: chrM Variant Calling [hybrid]

### Steps
- [x] 1. QC FASTQ {#plan-a-step-1} — fastp trim + per-base QC
  - Routing: local
- [ ] 3. Read alignment {#plan-a-step-3} — bwa mem, 4 samples
  - Routing: Galaxy (bwa-mem2/2.2.1)
```

`- [ ]` is pending, `- [x]` is verified-done, `- [!]` is failed.

## The approval sequence

For multi-step plans, the agent follows a four-stage sequence: it **drafts the
plan in chat** and waits for approval, then **shows the parameters** and waits
again, and only then **writes the plan into the notebook** and starts executing.

This is model guidance, not a hard runtime gate: the notebook is user-editable
markdown, and manual override is allowed when you explicitly ask for it.

## Live invocation tracking

While a Galaxy step runs, a `loom-invocation` fenced YAML block in the notebook
tracks the invocation. A polling tool reads those blocks, queries Galaxy, and
updates them in place as jobs finish or fail.

```yaml
invocation_id: f2db4a1c9e8b7654
galaxy_server_url: https://usegalaxy.org
notebook_anchor: plan-a-step-3
label: BWA-MEM alignment (chrM, 4 samples)
status: in_progress      # in_progress | completed | failed
completed_jobs: 1
total_jobs: 4
```

Small structured blocks like this handle the parts that need stable identity and
programmatic updates, while the rest of the notebook stays plain, readable
markdown.

## Git-tracked notebooks

Loom `git init`s the analysis directory and auto-commits every notebook change.
That gives you a full undo history, timestamped reproducibility evidence,
branchable exploration, and a notebook you can share on GitHub — for free.

## Skills

The agent pulls curated Galaxy know-how — collection recipes, MCP gotchas,
workflow reports, tool development — from
[`galaxyproject/galaxy-skills`](https://github.com/galaxyproject/galaxy-skills)
only when a task needs it, with a short per-repo cache.
