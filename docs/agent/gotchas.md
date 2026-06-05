# Gotchas and operational notes

## Local-tool environment

When running tools locally, use a per-analysis conda environment rooted
at `.loom/env/` inside the project directory. Conventions:

- Env path: `.loom/env/` (`-p .loom/env`, not `-n name`).
- Channel priority: `-c bioconda -c conda-forge`.
- Prefer `mamba` if available; fall back to `conda`.
- Lazy lifecycle: create on first tool need, install in batches, run
  via `conda run -p .loom/env <cmd>` or full path
  `.loom/env/bin/<cmd>`.
- Record installs under a `## Environment` heading in the notebook.

If neither conda nor mamba is installed, ask the user once whether to
fall back to system tools (non-reproducible) or abort.

## Bash timeouts on long-running tools

Pi's `bash` tool's `timeout` is **optional** and in **seconds**. When
omitted, the command runs to completion — correct default for
bioinformatics pipelines whose runtime you cannot reliably predict
(PGGB / assembly / minimap2 / bwa-on-WGS / long variant calling).

**Do not guess-cap at 3600 s.** Real pangenome builds will cross an hour
and be killed partway. When you do need a bound, pick generously: 300 s
quick commands, 3600 s short pipelines, 86400 s overnight. Prefer
**omitting `timeout` entirely** over capping too low.

## GTN tutorials

Galaxy Training Network (GTN) tutorials are an excellent reference for
learning analysis workflows. Two tools support this:

1. **`gtn_search`** — Discover topics and tutorials. Call with no args
   to list all topics, or with a topic ID to browse its tutorials. Add
   a keyword query to filter results.
2. **`gtn_fetch`** — Read a specific tutorial's full text content given
   its URL.

**Always use `gtn_search` to find tutorials before calling `gtn_fetch`.**
Do NOT guess or construct GTN URLs — the URL structure is not
predictable. The correct workflow is:

```
gtn_search()                              → browse topics
gtn_search(topic: "transcriptomics")      → find tutorials in a topic
gtn_search(topic: "transcriptomics", query: "rna-seq")  → filter
gtn_fetch(url: "<url from search>")       → read the tutorial content
```

## Calling Galaxy tools: build inputs from the schema

Before `galaxy_run_tool`, look up the tool's real parameter schema and
match it exactly — do not guess input names. The fastest path:

1. **`galaxy_get_tool_details(tool_id, io_details=True)`** returns the
   full parameter schema. (`galaxy_get_tool_input_template(tool_id)` is
   the shortcut — it hands back a ready-to-fill `inputs` skeleton with
   placeholders.)
2. Build `inputs` to the exact parameter names. They are often not what
   you would guess — e.g. `cat1`'s first input is `input1`, not `input`.
3. Use flattened keys for nested params: `section|param`,
   `conditional|selector`, `repeat_0|param` (and `repeat_1|...` for more
   repeat instances).

If a tool call fails with an opaque or parameter-shaped error — in
particular `Required parameter(s) kwd not provided in request` — treat it
as **your `inputs` not matching this tool**, not as the MCP or the Galaxy
version being incompatible. Re-fetch the schema, fix `inputs`, and retry.
That `kwd` message is a known Galaxy server quirk that masks an input
error; it does not mean a parameter literally named `kwd` is missing.

## Common gotchas

- **"kwd not provided" / opaque tool-run errors**: Almost always your
  `inputs` not matching the tool schema, not an incompatibility — see
  "Calling Galaxy tools" above. Re-fetch the schema and retry.
- **Empty results from Galaxy queries**: Check `visible: true` filter,
  increase limits, verify dataset exists.
- **Dataset ID vs HID**: Galaxy MCP uses dataset IDs (long strings),
  not history item numbers.
- **Job monitoring**: `galaxy_invocation_check_all` advances in-flight
  invocations deterministically; agent doesn't have to poll job-by-job.
- **Pagination**: Large histories need offset/limit parameters.
- **SRA imports**: Use SRR accessions, not GSM numbers, for Galaxy
  import.
