# Loom

An AI research harness for [Galaxy](https://galaxyproject.org) bioinformatics, built on [Pi.dev](https://pi.dev).

Loom weaves the threads of a research project -- question, data, analysis, interpretation, publication -- into a durable, resumable notebook. It creates plans, runs Galaxy tools, documents every decision, and keeps the whole record reproducible.

## Architecture: Loom + its consumers

**Loom** is the *brain* -- the agent runtime in [`extensions/galaxy-analyst/`](extensions/galaxy-analyst/) plus the RPC contract it exposes. The brain owns plan state, the five-phase lifecycle, notebook persistence, Galaxy integration, and provenance.

Consumers sit on top of Loom and are named independently:

- **`gxypi`** -- the terminal CLI consumer. First-class and the primary validation path. Installed from npm, configured in `~/.gxypi/config.json`.
- **Orbit** (in [`app/`](app/)) -- the Electron desktop shell. Galaxy-branded; chat panel with streaming, a sidebar tab bar auto-populated with plan/decisions/notebook/status, window state persistence, and a working-directory picker. Orbit is optional -- the `gxypi` CLI is the supported primary path.
- **Future shells** -- a Galaxy-embedded web UI, a hosted server mode, and anything else can talk to the same brain over RPC.

The repo is still named `pi-galaxy-analyst`; a rename is a follow-up. Loom is the product identity.

## Current Status

Loom is implemented and locally tested, but live Galaxy validation is still in progress.

- TypeScript typecheck passes against `@mariozechner/pi-coding-agent` `0.55.0`
- Local automated suite: `113` tests passing
- Notebook persistence, plan state, workflow metadata, BRC context, and extension registration are covered by tests
- Provenance notebook sync now has a dedicated regression check via `npm run validate:provenance`
- Live runtime validation has confirmed extension loading, Galaxy connection/history state bridging, and notebook rewriting for `data_set_source`
- Remaining validation work: use a stronger tool-calling model for the live MCP path, then run Galaxy end-to-end with real histories, datasets, and jobs

If you are validating the runtime manually, use a `pi` CLI version that matches the SDK line used by this repo where possible.

## Install

Install the CLI (`gxypi`):

```bash
npm install -g gxypi
```

Or run without installing:

```bash
npx gxypi
```

You'll also need [uv](https://docs.astral.sh/uv/) for the Galaxy MCP server (installed automatically via `uvx`). If you don't have it:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

## Usage

### CLI (`gxypi`)

The terminal CLI is the primary validation path for Loom:

```bash
gxypi
```

```bash
npx gxypi
```

```bash
node bin/gxypi.js --provider anthropic --model claude-sonnet-4-5-20250929
```

You can also load just the extension into Pi directly:

```bash
pi --no-extensions -e ./extensions/galaxy-analyst
```

If you are validating or debugging the terminal path, prefer these commands before using the desktop app.

```
$ gxypi

You: I have RNA-seq data from a drug treatment experiment — 6 samples,
     3 treated and 3 control HeLa cells. I want to find differentially
     expressed genes. The data is at GEO accession GSE164073.

Pi:  I'll help you set up a structured analysis. Let me start by refining
     the research question.

     Research Question: "Does drug X treatment alter gene expression
     in HeLa cells, specifically in inflammatory response pathways?"

     I've created an analysis plan and saved it to:
     📓 rna-seq-drug-treatment-notebook.md

     The plan has 5 steps:
       1. ⬜ Quality Control (FastQC + MultiQC)
       2. ⬜ Read Trimming (Cutadapt)
       3. ⬜ Alignment (HISAT2 to hg38)
       4. ⬜ Quantification (featureCounts)
       5. ⬜ Differential Expression (DESeq2)

     Ready to start with QC?

You: Yes, run FastQC on all samples.

Pi:  Running FastQC via Galaxy...

     ✅ FastQC complete. Results:
     - All samples: Q30 > 88%
     - Adapter content detected in samples 2 and 5
     - Recommendation: proceed with trimming

     I've logged this as a QC checkpoint. Move on to trimming?
```

The next day, come back to the same directory and everything picks up where you left off:

```
$ gxypi

Pi:  Loaded notebook: RNA-seq Drug Treatment (1/5 steps completed)

     Last session completed Quality Control (passed).
     Next step: Read Trimming with Cutadapt.

     Ready to continue?
```

### Configuration

The `gxypi` CLI uses a single config file at `~/.gxypi/config.json` for both Galaxy credentials and LLM provider settings:

```json
{
  "llm": {
    "provider": "anthropic",
    "apiKey": "sk-ant-...",
    "model": "claude-sonnet-4-5-20250929"
  },
  "galaxy": {
    "active": "usegalaxy-org",
    "profiles": {
      "usegalaxy-org": {
        "url": "https://usegalaxy.org",
        "apiKey": "abc123"
      }
    }
  }
}
```

Both sections are optional. If `llm` is missing, the CLI falls back to environment variables or OAuth login. If `galaxy` is missing, use `/connect` to add a server interactively — credentials are saved to the config file automatically.

You can also set environment variables directly:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export GALAXY_URL="https://usegalaxy.org"
export GALAXY_API_KEY="your-api-key"
```

If you have an existing setup with `~/.pi/agent/galaxy-profiles.json` or `~/.pi/agent/models.json`, the CLI migrates them into `~/.gxypi/config.json` on first run.

### Commands

| Command | What it does |
|---------|-------------|
| `/status` | Galaxy connection state, current plan progress |
| `/plan` | View analysis plan with step status |
| `/plan-decisions` | View the decision log |
| `/notebook` | Notebook info or list available notebooks |
| `/connect` | Connect to a Galaxy server (prompts for credentials) |
| `/profiles` | List saved Galaxy server profiles |

## How It Works

Loom guides analyses through five phases:

**1. Problem Definition** — Refine your research question using the PICO framework, add literature references.

**2. Data Acquisition** — Track data sources (GEO, SRA, local files), register samples, generate samplesheets, link to Galaxy datasets.

**3. Analysis** — Create a step-by-step plan, execute tools/workflows via Galaxy, log every decision, record QC checkpoints with pass/fail criteria.

**4. Interpretation** — Review results in biological context, pathway analysis.

**5. Publication** — Generate methods sections from the tool versions actually used, track figures, prepare data sharing.

Everything is saved to a **notebook file** — a readable markdown document with YAML blocks for structured data. You can open it in any editor, share it with collaborators, or use it to reproduce the analysis later.

### Git-tracked notebooks

When Loom creates a notebook, it initializes a git repository in the working directory (if one doesn't already exist) and commits every meaningful change as it happens. Step completions, QC checkpoints, decisions, phase transitions — each gets its own commit with a descriptive message like `Add step: Read Mapping` or `QC: Post-alignment QC (passed)`.

This gives you a few things for free:

- **Full undo history.** If an analysis step goes sideways, `git log` shows exactly what changed and when. You can diff any two points in the analysis or revert a bad step.
- **Reproducibility evidence.** The commit history is a timestamped, immutable record of every decision and result. Reviewers and collaborators can see not just the final notebook but the entire sequence of how you got there.
- **Branch-based exploration.** Want to try an alternative DE threshold or a different aligner? Branch, run the variant, and compare notebooks side by side with `git diff`.
- **Collaboration.** Push the repo to GitHub and collaborators can pull, review the analysis history, and continue where you left off.

The `.gitignore` auto-created with the repo excludes large bioinformatics files (FASTQ, BAM, VCF, etc.) so only the notebook markdown and any small analysis artifacts get tracked.

Granular changes like Galaxy dataset references and literature additions are bundled into the next structural commit rather than creating their own, keeping the history clean.

## Using Local LLMs

Pi supports any OpenAI-compatible API. To use a local provider like [LiteLLM](https://litellm.ai/), set it in `~/.gxypi/config.json`:

```json
{
  "llm": {
    "provider": "litellm",
    "apiKey": "your-key",
    "model": "your-model-name"
  }
}
```

You'll also need a `~/.pi/agent/models.json` to tell Pi the model's capabilities (context window, token limits, etc.) — see the Pi documentation for the format. The config file handles provider selection and API keys; `models.json` handles the model metadata that Pi needs for request sizing.

Alternatively, pass flags directly: `gxypi --provider litellm --model your-model-name`.

## Terminal-Only Validation

For non-Electron validation, use the CLI/runtime path directly:

```bash
npm run typecheck
npm test
npm run validate:provenance
pi --no-extensions -e ./extensions/galaxy-analyst
```

Then validate the wrapper itself in a plain working directory:

```bash
mkdir -p /tmp/gxypi-cli-validation
cd /tmp/gxypi-cli-validation
node /Users/dannon/work/pi-galaxy-analyst/bin/gxypi.js --provider litellm --model gpt-oss-120b
```

For a full terminal-only runbook, see [docs/terminal-validation.md](/Users/dannon/work/pi-galaxy-analyst/docs/terminal-validation.md).

## Tool Reference

Loom currently registers `34` extension tools across the analysis lifecycle:

| Category | Tools |
|----------|-------|
| **Phase management** | `analysis_set_phase` |
| **Problem definition** | `research_question_refine`, `research_add_literature` |
| **Data acquisition** | `data_set_source`, `data_add_sample`, `data_add_file`, `data_link_galaxy`, `data_generate_samplesheet`, `data_get_provenance` |
| **Analysis** | `analysis_plan_create`, `analysis_plan_add_step`, `analysis_plan_update_step`, `analysis_plan_get`, `analysis_plan_activate`, `analysis_plan_summary`, `analysis_step_log`, `analysis_checkpoint` |
| **Notebooks** | `analysis_notebook_create`, `analysis_notebook_open`, `analysis_notebook_list` |
| **Interpretation** | `interpretation_add_finding`, `interpretation_summarize` |
| **Publication** | `publication_init`, `publication_generate_methods`, `publication_add_figure`, `publication_update_figure`, `publication_recommend_figures`, `publication_get_status` |
| **Workflow integration** | `workflow_to_plan`, `workflow_invocation_link`, `workflow_invocation_check` |
| **BRC context** | `brc_set_context` |
| **GTN tutorials** | `gtn_search`, `gtn_fetch` |

For a step-by-step live validation runbook, see [docs/live-validation-checklist.md](/Users/dannon/work/pi-galaxy-analyst/docs/live-validation-checklist.md). For the provenance notebook regression specifically, run `npm run validate:provenance`.

## Related Projects

- [Galaxy](https://galaxyproject.org) — Open-source platform for data-intensive biomedical research
- [galaxy-mcp](https://github.com/galaxyproject/galaxy-mcp) — MCP server for the Galaxy API
- [Pi coding agent](https://github.com/badlogic/pi-mono) — The Pi.dev agent framework

## License

MIT
