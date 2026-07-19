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

When you explicitly ask for a multi-step plan, the agent drafts a `## Plan X:`
section. The plan header carries a single routing tag that summarizes how the
whole plan runs:

- `[galaxy]` — the primary path: steps run on Galaxy's tools and workflows. The
  default whenever a matching Galaxy tool or workflow exists.
- `[remote]` — the entire plan is a single Galaxy workflow invocation, because an
  existing workflow matches it end to end.
- `[hybrid]` — a mix: some steps run locally, some on Galaxy.
- `[local]` — runs on your machine, reserved for personal-scale or ad-hoc work.

Individual steps don't repeat those bracket tags. Each step is a checklist item
that records its execution route, its tool, and the verification that must pass
before it can be marked done — all on indented sub-bullets:

```markdown
## Plan A: chrM Variant Calling [hybrid]

### Steps
- [x] 1. QC FASTQs {#plan-a-step-1} — fastp adapter trim + per-base QC
  - Routing: local
  - Tool: fastp
  - Verification: fastp report exists with per-base quality metrics
- [ ] 2. Align to chrM {#plan-a-step-2} — BWA-MEM, 4 samples, sorted BAM out
  - Routing: galaxy
  - Tool: bwa_mem
  - Verification: poll the Galaxy invocation to a terminal state, inspect the BAMs
```

Anchors like `{#plan-a-step-2}` are used where the model provider supports them,
so invocation records can point back to a step. `- [ ]` is pending, `- [x]` is
verified-done, `- [!]` is failed — and a step only becomes `- [x]` once the
verification evidence is written into the notebook, never on job completion alone.

## The approval sequence

For multi-step plans, the agent follows a four-stage sequence: it **drafts the
plan in chat** and waits for approval, then **shows the parameters** and waits
again, and only then **writes the plan into the notebook** and starts executing.

This is model guidance, not a hard runtime gate: the notebook is user-editable
markdown, and manual override is allowed when you explicitly ask for it.

## Live invocation tracking

When the agent invokes a Galaxy workflow it records a `loom-invocation` fenced
block in the notebook and hands control back immediately — the job runs on
Galaxy's infrastructure in the background. A polling tool reads those blocks,
queries Galaxy, and updates them in place as jobs finish or fail, notifying you
when the invocation reaches a terminal state.

```loom-invocation
invocation_id: f2db4a1c9e8b7654
galaxy_server_url: https://usegalaxy.org
notebook_anchor: plan-a-step-3
label: BWA-MEM alignment (chrM, 4 samples)
submitted_at: 2026-04-25T15:30:00Z
status: in_progress
completed_jobs: 1
total_jobs: 4
```

`status` advances `in_progress → completed` (or `failed`) on its own. A
`completed` invocation still isn't a finished step: the agent inspects the output
datasets and writes that evidence into the notebook before flipping the plan
checkbox to `- [x]`. Small structured blocks like this handle the parts that need
stable identity and programmatic updates, while the rest of the notebook stays
plain, readable markdown.

## Git-tracked notebooks

When Loom starts in a directory that isn't already a git repo, it runs `git init`,
drops a bioinformatics-friendly `.gitignore` (large FASTQ/BAM/VCF files and the
per-session activity logs stay out of history), and auto-commits every notebook
change. That gives you a full undo history, timestamped reproducibility evidence,
branchable exploration, and a notebook you can share on GitHub — for free. (If you
start Loom inside a repo you already manage, auto-commit is opt-in, so it never
touches your history without asking.)

## Skills

The agent pulls curated Galaxy know-how — collection recipes, MCP gotchas,
workflow reports, tool development — from
[`galaxyproject/galaxy-skills`](https://github.com/galaxyproject/galaxy-skills)
only when a task needs it, with a short per-repo cache.
