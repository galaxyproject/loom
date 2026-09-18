# Workflow Reports Skill

Claude Code skill for drafting Galaxy workflow report templates for the Workflow Editor's **Report** tab.

## Quick Start

**From a `.ga` file** (e.g. IWC workflows):
1. Point Claude at the file: *"Write a report for this workflow: `path/to/workflow.ga`"*
2. Claude drafts the template and writes it into `report.markdown` in the `.ga` file (with confirmation).

**From a live Galaxy instance:**
1. Get the workflow JSON: `GET https://<instance>/api/workflows/<id>/download?style=editor`
2. Pass it to Claude: *"Create a report template for this workflow: [URL or paste JSON]"*
3. Claude drafts the template — paste it into the Workflow Editor's **Report** tab and save.

## Installation

```bash
# Personal skills (all projects)
ln -s /path/to/workflow-reports ~/.claude/skills/workflow-reports

# Project skills (shared via git)
ln -s /path/to/workflow-reports .claude/skills/workflow-reports
```

## File Organization

| File | Purpose | When to read |
|------|---------|--------------|
| `SKILL.md` | Main skill — fetch logic, output selection, report structure, gotchas | **Start here** |
| `references/directives.md` | Full Galaxy markdown directive reference | Looking up syntax |
| `examples/histology-staining.md` | Complete worked example with extracted metadata and final template | Understanding expected output |

## Key Concepts

- Reports are **templates**, not post-hoc analyses — written before knowing if the run will succeed
- All directives use **block syntax only** — `${galaxy ...}` inline syntax does not work
- When using the API, use `/download?style=editor` — the regular API endpoint is missing step labels and workflow outputs
- `.ga` files contain a `report.markdown` field — this is what the skill writes; the default is a minimal placeholder that should be replaced

## Decision Tree

```
Do you have the workflow JSON or URL?
│
├─ Yes → Follow SKILL.md steps 1–4
│
└─ No → Get it first:
         GET https://<instance>/api/workflows/<id>/download?style=editor
```

```
What outputs does the workflow have?
│
├─ Image outputs → history_dataset_as_image(output="<label>")
│
├─ Tabular outputs → history_dataset_as_table(...) + history_dataset_link(...)
│
├─ No workflow_outputs marked → flag to user, use invocation_outputs() as fallback
│
└─ Multiple images at different stages → prefer output closest to final result
```

## Common Issues

| Problem | Solution |
|---------|----------|
| Step labels are null | Skip `job_parameters` for unlabeled steps |
| No `workflow_outputs` marked | User must star outputs in the Workflow Editor |
| Key terminal output not marked | Flag it by name — don't silently use an upstream substitute |
| Report uses `${galaxy ...}` syntax | Replace with block syntax — inline does not work |
