---
name: workflow-reports
description: Use this skill when asked to create, draft, or write a Galaxy workflow report template for the Workflow Editor's Report tab. Triggers on requests like "create a report for this workflow", "draft a workflow report template", "write a Galaxy report for workflow <id/url>".
metadata:
  surfaces: [loom]
---

# Galaxy Workflow Report Templates

Draft reusable Galaxy markdown report templates for the Workflow Editor's **Report** tab.

## Required Input

**This skill requires the full workflow definition.** Two equivalent options:

**Option A — `.ga` file** (preferred for local/IWC workflows):
Read the `.ga` file directly. It is a JSON object with the same structure as the API response. The `report.markdown` field is what this skill writes — it defaults to a minimal template (`invocation_inputs`, `invocation_outputs`, `workflow_display`) that should be replaced.

**Option B — Galaxy API**:
```
GET https://<instance>/api/workflows/<id>/download?style=editor
```
> **Critical:** Use the `/download?style=editor` endpoint — not `/api/workflows/<id>`. The regular endpoint does **not** return `step.label` or `workflow_outputs`, which are essential for writing directives. Without them, no `output="..."`, `input="..."`, or `step="..."` references will work.

If the user provides a browser URL like `https://usegalaxy.eu/workflows/run?id=abc123`, extract the ID and construct the download URL yourself.

**Output:** The drafted report markdown is written into the `report.markdown` field of the `.ga` file (with user confirmation), or presented as a code block for pasting into the Workflow Editor's Report tab.

---

## Core Philosophy

Reports are **templates** — they are written before knowing what inputs the user will provide or whether the run will succeed. Never assume:
- Inputs are valid, in the expected format, or of the expected type
- The run completed successfully or produced expected outputs
- Biological/scientific meaning of results (the same workflow can be used in different contexts)

Use conditional, descriptive language throughout:
- Summary: "is designed to", "expects", "should produce"
- Output sections: "if the run completed successfully, this should show..."
- Column descriptions: what a column *measures*, not what it *means*

---

## Step 1 — Parse the workflow

From the JSON response, extract:

**Inputs** — steps where `type` is `data_input` or `data_collection_input`:
- `steps[N].label` → used in `input="..."` directives
- `steps[N].annotation` → describes what data is expected (use for prose, not directives)
- `steps[N].type` → `data_input` (single dataset) vs `data_collection_input` (list/paired collection)

**Workflow outputs** — steps where `steps[N].workflow_outputs` is a non-empty array:
- `steps[N].workflow_outputs[].label` → used in `output="..."` directives
- `steps[N].label` → the step's short name, used in `step="..."` for `job_parameters`
- `steps[N].annotation` → use for prose about what this output represents

> **Important distinction:** `steps[N].label` is the short identifier (e.g. `"Color Deconvolution"`) used in directives. `steps[N].annotation` is a longer description useful only for prose. Do not confuse them.

**Top-level metadata**: `name` (report title), `annotation` (primary source for Summary prose), `tags` (domain context), `license`, `creator`

If working from a `.ga` file, also check for a co-located `README.md` in the same directory — IWC workflows often have one with richer descriptions than the `annotation` field.

---

## Step 2 — Select which outputs to feature

Not every `workflow_outputs` entry deserves its own section. Apply these rules:

**Always include:**
- The final/terminal tabular output (primary quantitative result)
- Any output that is the direct basis for the quantitative result (e.g. the binary mask an area measurement is computed from)

**Include selectively:**
- Intermediate images that help the user understand whether the pipeline worked correctly (e.g. a segmentation mask is more informative than a raw deconvolved channel)
- Prefer outputs closest to the end of the pipeline over early intermediates

**Skip or collapse:**
- Purely intermediate outputs that are only inputs to subsequent steps
- Outputs that duplicate information already shown

**When in doubt:** ask yourself — if the run produced unexpected results, which output would a user look at first to debug it? That's the one to feature.

---

## Step 3 — Classify selected outputs

| Output type | Directive |
|-------------|-----------|
| Image (TIFF, PNG, JPEG) | `history_dataset_as_image(output="<label>")` |
| Collection of images | `history_dataset_as_image(output="<label>")` — same directive, works for collections too |
| Tabular / TSV / CSV | `history_dataset_as_table(output="<label>", show_column_headers=true, compact=true)` + `history_dataset_link(output="<label>", label="Download ...")` |
| HTML / text | `history_dataset_embedded(output="<label>")` |
| Unknown | `history_dataset_display(output="<label>")` |

For image-type **inputs**, use `history_dataset_as_image(input="<input label>")`.  
For non-image inputs or a general input listing, use `invocation_inputs()`.

---

## Step 4 — Build the report

### Required sections

**1. Title + run timestamp**

````
# <Workflow Name>

```galaxy
invocation_time()
```
````

**2. Summary**
- One paragraph: what the workflow is designed to do, what inputs it expects, what outputs it should produce.
- Use the top-level `annotation` and step annotations to inform the prose — do not copy them verbatim.
- End the section with `workflow_image()`.

**3. Inputs**
- Brief prose describing what the input(s) represent and what format/type is expected.
- For image inputs: `history_dataset_as_image(input="<label>")`.
- For non-image or multiple inputs: `invocation_inputs()`.

**4. Key output sections** (one subsection per selected output)
- Brief prose: what this output represents and how it was produced — phrased conditionally.
- The appropriate directive immediately follows.
- For processed images (masks, segmentations): explain the visual encoding conditionally ("in a successful run, white pixels should represent...").

**5. Results** (when tabular outputs exist)
- A markdown table of expected columns: name and description (factual/definitional only) — this goes **before** the directive so the reader understands the columns before seeing the live data.
- Then `history_dataset_as_table(...)` followed by `history_dataset_link(...)`.

**6. Reproducibility**

```galaxy
history_link()
```

### Optional sections

- `job_parameters(step="<label>", collapse="Show <step> parameters")` — for analytical steps where the chosen parameters significantly affect interpretation
- `invocation_outputs()` — useful when the workflow has many outputs and a full listing helps
- `workflow_display(collapse="Show full workflow details")`

---

## Directive Syntax Rules

**Block syntax only — no exceptions:**

```galaxy
directive_name(arg=value)
```

One directive per fenced block. Never stack multiple directives in one block. The `${galaxy ...}` inline syntax does **not** work.

**Abstract references in workflow templates** (never hardcode IDs):
- `input="<label>"` — workflow input by its label
- `output="<label>"` — marked workflow output by its label
- `step="<label>"` — step by its label

Quotes are required when the value contains spaces.

See `references/directives.md` for the full directive reference (synced from upstream Galaxy via `make sync-directives`).

---

## Gotchas

| Issue | What to do |
|-------|-----------|
| `step.label` is null for many steps | Only use `job_parameters(step=...)` for steps that have a non-null `label`. Silently skip others. |
| `workflow_outputs` is empty for a step that should be an output | Flag to the user: they must open the step in the Workflow Editor, star the output, and save. Then the `output="..."` directive can reference it. |
| An important terminal output isn't marked (e.g. a final column-computation step) | Flag it specifically — name the step and describe what it produces. Don't silently omit it or use a less complete upstream output as a substitute without noting the limitation. |
| Step annotations are very long | Use them to inform prose — do not copy them verbatim into the report. |
| Multiple image outputs at different pipeline stages | Prefer the output closest to the final result. Intermediate outputs can be omitted or mentioned in prose only. |

---

## After drafting

Present the template in a code block ready to paste into the Workflow Editor's Report tab.

Also explicitly flag:
1. Any important steps whose output is **not** marked as a `workflow_output` — name the step, what it produces, and instruct the user to star it in the editor.
2. Any steps referenced in prose that have no `label` and therefore cannot be used with `job_parameters`.

See `examples/histology-staining.md` for a complete worked example.
