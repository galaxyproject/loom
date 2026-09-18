---
name: reproduciblify
description: Use this skill to "reproduciblify" a Galaxy history — re-execute a real (often messy) analysis as a clean, fully on-graph, collection-structured history and author a Galaxy Notebook that extracts cleanly into a reusable, sample-agnostic workflow. Triggers on "reproduciblify this history", "make this history reproducible/extractable", "rebuild this analysis on-graph", "turn this history into a clean notebook/workflow".
metadata:
  surfaces: [loom]
---

# Reproduciblify

Take a real Galaxy history — often messy, with manual uploads of derived data, pasted figures, off-graph scratch steps, and one-sample-at-a-time structure — and **reproduciblify** it: re-execute the analysis so its entire computational closure lives on the Galaxy provenance graph, restructure it with collections for arbitrary arity, and author a **Galaxy Notebook** that documents it and extracts cleanly into a reusable, sample-agnostic workflow.

A Galaxy Notebook is a history-attached Galaxy-flavored markdown document. It documents an analysis and embeds its on-graph artifacts via directives; it does not execute anything. Its value here is that notebook-driven workflow extraction can recover a reusable workflow from the artifacts it references.

## When to Use

- The user has a Galaxy history (and optionally the plan/recipe/transcript that produced it) and wants it turned into something durable and reusable.
- The history "works" but was built ad-hoc: data computed outside Galaxy and uploaded, figures pasted as images, bash/manual steps, single-sample structure that should generalize.
- The goal is a clean Galaxy Notebook **and** a workflow that re-runs the documented analysis on new data.

If the user only wants a report template for an *already-clean* workflow, use `workflow-reports` instead. If they only want to manipulate collections, use `collection-manipulation`.

## The Core Principle: extractability = everything on-graph

Galaxy's notebook-driven workflow extraction walks **backward through the history provenance graph** from the artifacts a notebook references. It can only recover the computation behind artifacts the history actually produced as tool outputs.

This gives one hard test every step must pass:

> **Can Galaxy walk backward from this artifact, through real Galaxy jobs, to a logical input?**

Things that **fail** the test and anchor nothing:
- Data computed outside Galaxy and uploaded (a count matrix made in R/Python, a gene list made by a local script).
- Figures pasted as images rather than emitted by an on-graph plotting tool.
- Bash / "scratch" / manual reformatting steps done outside the tool framework.

Things that **pass**:
- A logical input dataset (raw reads, a public matrix that is the genuine starting boundary of the analysis).
- Any derived artifact produced by a real Galaxy tool run.

Reproduciblify is the act of converting every failing step into a passing one — replacing off-graph computation with on-graph tools — and structuring the result so it generalizes.

## Required Input

1. **A Galaxy history** (required). Connect via the Galaxy MCP server and inspect it — see `../galaxy-mcp-reference/SKILL.md`. The relevant calls: `get_history_contents`, `get_dataset_details` (with preview), `get_job_details` (the job that produced each dataset, including its inputs and tool id).
2. **A plan / recipe / transcript** (optional but valuable). If the user has the steps that produced the history — a methods note, a chat log, an SI recipe — use it to recover *intent*: which steps were exploratory dead-ends, which outputs mattered, why parameters were chosen. The history shows *what happened*; the recipe helps recover *what was meant*.

## Workflow

### Step 1 — Map the source history

Enumerate every dataset and the job that produced it. Classify each node:

| Class | Meaning | Action |
|-------|---------|--------|
| **Logical input** | The genuine starting boundary of the analysis (raw reads, a public reference matrix) | Keep as an upload/input |
| **On-graph derived** | Produced by a real Galaxy tool job | Keep — already extractable |
| **Off-graph intrusion** | Uploaded derived data, pasted figure, bash/manual step | **Must be replaced** with an on-graph tool (Step 3) |
| **Dead-end / exploratory** | Abandoned branch, superseded attempt | Drop from the clean rebuild |

Also identify the **meaningful outputs** — the datasets/figures/tables that *are the answer* and will anchor the notebook (and therefore the extraction).

### Step 2 — Plan the notebook

Write a plan (share it with the user before executing). Structure it as:

```
logical inputs  →  ordered on-graph steps  →  meaningful outputs
```

Decide arity up front: is this a single-sample analysis that should generalize to N samples? Where does map-over belong? Where is there a reduce/pairwise seam (a comparison between groups)? See Step 4.

This plan is the spine of both the rebuilt history and the notebook narrative.

### Step 3 — Replace off-graph computation with on-graph tools

For every off-graph intrusion from Step 1, the rule is **find superior, create as fallback**:

1. **Find (preferred).** Search for an existing Galaxy tool that performs the computation: `search_tools_by_name`, `search_tools_by_keywords`, `get_tool_panel`, and the IWC manifest. Prefer a well-maintained Tool Shed tool over a bespoke one — it is more reproducible, citable, and recognizable to reviewers.
2. **Create (fallback).** If no suitable tool exists, build one. Use the `udt-authoring` skill (`../udt-authoring/SKILL.md`) — wrap the script/computation as a User-Defined Tool with declared inputs, outputs, and a pinned container, which keeps the step on-graph without waiting on an admin to install anything.

After this step, **only genuine logical inputs remain as uploads.** Everything else is a tool output.

> Worked example: an analysis of "six uploads, six alignments, a bash gene-list step, and a pasted matrix" collapses into a clean all-tool DAG once the bash step becomes a tool and the matrix becomes an on-graph tool output. The pasted matrix anchored nothing until it was made on-graph.

### Step 4 — Restructure for arity with collections

If the analysis should accept an arbitrary number of samples, encode that with Galaxy **collections** and map/reduce structure rather than copy-pasted per-sample steps. See `collection-manipulation/SKILL.md`.

- **Map-over** — a per-sample step runs once per collection element. N samples in → N results out, with no change to the workflow graph.
- **Nested `list:list`** — carry experimental design *structurally* through collection shape (e.g. outer level = condition, inner level = replicate). This lets one MACS2/DESeq2-style step map over conditions while pooling replicates, with no metadata-aware tooling. A hand-authored sample sheet is the ideal description of design, but it is **not** an extraction target — the nested collection is.
- **Reduce / pairwise seams** — a step that compares two specific groups is a reduce. If it selects named elements out of a collection and feeds a single-dataset tool input, it has **no representation as a workflow edge** — it is an *irreducible comparison*.

**The irreducible-comparison rule:** when a seam can't be made sample-agnostic inside one workflow, don't force it. Split into two reusable pieces — a **map-over producer** (collections in, per-group results out) and a **pairwise comparator** (any two results in, differential out). Only their composition (which two groups to contrast) stays analyst-supplied. Surface this boundary to the user explicitly rather than hiding it.

### Step 5 — Re-execute the clean pipeline on Galaxy

Galaxy Notebooks are **not** executable — execution stays in real Galaxy tools, histories, and workflows. So actually run the rebuilt pipeline via MCP (`run_tool`) into a fresh history, in the order from the plan, verifying each step emits a real on-graph output. Produce every meaningful output — including every figure — as a genuine tool run (e.g. `ggplot2_*`, plotting tools that emit image outputs), never as a pasted image.

> A figure emitted as PDF can be brought on-graph as an image output and referenced directly — so even "plot" steps seed extraction.

### Step 6 — Author the Galaxy Notebook

Create a history-attached notebook (a Page with `history_id` set) via the Galaxy MCP page tools (`create_page` with the history id, `update_page` to revise; edits are recorded as `edit_source="agent"`). Write Galaxy-flavored markdown that:

- Narrates **logical inputs → steps → meaningful outputs**, recording *why* choices were made (the communicative record the history alone can't hold).
- **Embeds every meaningful output as a real on-graph directive** — `history_dataset_as_image(output=...)`, `history_dataset_as_table(...)`, etc. Every embedded artifact must be an on-graph tool output. For the directive syntax and full catalog, see `references/directives.yml`.

The discipline is identical to a good workflow report, but stricter: here, every referenced artifact *is* an extraction anchor, so a pasted figure is not just poor documentation — it is a hole in the recoverable workflow.

### Step 7 — Verify extractability

Before declaring done:

- **Audit anchors:** every artifact the notebook references is an on-graph tool output. Zero pasted figures, zero uploaded derived data.
- **Walk backward:** mentally (or by extracting) trace each meaningful output back through jobs to a logical input. No dangling inputs.
- **Check generality:** the recovered workflow should be sample-agnostic — passing the input collection (not its individual element datasets) keeps the input surface clean; a larger/fresh cohort re-runs without edits.
- **Extract and re-run** (if the instance supports it) and confirm the result is science-identical to the original. Byte-identical is the gold standard for a clean map-over pipeline.

## Decision Cheat-Sheet

| Situation | Do this |
|-----------|---------|
| Derived data was uploaded from outside Galaxy | Find a superior Galaxy tool; author a User-Defined Tool (`udt-authoring`) only as fallback |
| A figure is a pasted image | Re-emit it from an on-graph plotting tool |
| A bash/manual reformatting step | Find a native equivalent, or wrap it as a User-Defined Tool |
| Analysis is one-sample, should be N-sample | Map-over a list collection |
| Experimental design (condition × replicate) | Nested `list:list` collection — carry design through shape |
| A step compares two named groups | It's a reduce; if irreducible, **split** into map-over producer + pairwise comparator |
| An exploratory dead-end branch | Drop it from the clean rebuild |

## Common Mistakes

| Mistake | Why it's wrong | Fix |
|---------|----------------|-----|
| Documenting the messy history as-is | Off-graph anchors aren't extractable; the notebook looks reproducible but isn't | Rebuild on-graph first, then document |
| Pasting a figure into the notebook | Anchors nothing for extraction | Emit it from a tool as an image output |
| Forcing an irreducible comparison into one workflow | Produces a condition-pinned workflow that can't generalize | Split into producer + comparator; surface the seam |
| Passing collection *element datasets* as workflow inputs | Bloats and pins the input surface | Pass the collection itself |
| Treating the notebook as executable | Galaxy Notebooks are narrative, not execution | Run real tools to build the history, then narrate |
| Creating a new tool when a good one exists | Less reproducible, less recognizable, more maintenance | Search first; create only as fallback |

## See Also

- `../galaxy-mcp-reference/SKILL.md` — Galaxy MCP tools (history/dataset/tool/page access, `run_tool`).
- `../collection-manipulation/SKILL.md` — map/reduce restructuring with native collection tools.
- `../udt-authoring/SKILL.md` — authoring a User-Defined Tool when no suitable tool exists (fallback path).
- `references/directives.yml` — Galaxy markdown directive metadata for embedding on-graph artifacts (synced from upstream Galaxy via `make sync-directives`).
