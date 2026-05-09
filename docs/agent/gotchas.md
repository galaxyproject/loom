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

## Common gotchas

- **Empty results from Galaxy queries**: Check `visible: true` filter,
  increase limits, verify dataset exists.
- **Dataset ID vs HID**: Galaxy MCP uses dataset IDs (long strings),
  not history item numbers.
- **Job monitoring**: `galaxy_invocation_check_all` advances in-flight
  invocations deterministically; agent doesn't have to poll job-by-job.
- **Pagination**: Large histories need offset/limit parameters.
- **SRA imports**: Use SRR accessions, not GSM numbers, for Galaxy
  import.
