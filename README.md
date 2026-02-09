# gxypi

An AI co-scientist for [Galaxy](https://galaxyproject.org) bioinformatics, built on [Pi.dev](https://pi.dev).

gxypi turns Pi into a structured analysis partner — it creates plans, runs Galaxy tools, documents every decision, and saves everything to a persistent notebook you can share, resume, and reproduce.

## Install

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

### Galaxy Credentials

Use `/connect` after starting gxypi — it prompts for your server URL and API key, and saves them for future sessions.

Or set environment variables:

```bash
export GALAXY_URL="https://usegalaxy.org"
export GALAXY_API_KEY="your-api-key"
```

### Commands

| Command | What it does |
|---------|-------------|
| `/status` | Galaxy connection state, current plan progress |
| `/plan` | View analysis plan with step status |
| `/plan-decisions` | View the decision log |
| `/notebook` | Notebook info or list available notebooks |
| `/connect` | Connect to a Galaxy server (prompts for credentials) |

## How It Works

gxypi guides analyses through five phases:

**1. Problem Definition** — Refine your research question using the PICO framework, add literature references.

**2. Data Acquisition** — Track data sources (GEO, SRA, local files), register samples, generate samplesheets, link to Galaxy datasets.

**3. Analysis** — Create a step-by-step plan, execute tools/workflows via Galaxy, log every decision, create QC checkpoints that require your approval before proceeding.

**4. Interpretation** — Review results in biological context, pathway analysis.

**5. Publication** — Generate methods sections from the tool versions actually used, track figures, prepare data sharing.

Everything is saved to a **notebook file** — a readable markdown document with YAML blocks for structured data. You can open it in any editor, share it with collaborators, or use it to reproduce the analysis later.

## Using Local LLMs

Pi supports any OpenAI-compatible API. To use a local provider like [LiteLLM](https://litellm.ai/), create `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "litellm": {
      "baseUrl": "http://localhost:4000/v1",
      "api": "openai-completions",
      "apiKey": "your-key",
      "models": [
        {
          "id": "your-model-name",
          "contextWindow": 128000,
          "maxTokens": 16384
        }
      ]
    }
  }
}
```

Then start with `gxypi --provider litellm --model your-model-name`, or set defaults in `~/.pi/agent/settings.json`.

## Tool Reference

gxypi registers 26 tools across the analysis lifecycle:

| Category | Tools |
|----------|-------|
| **Phase management** | `analysis_set_phase` |
| **Problem definition** | `research_question_refine`, `research_add_literature` |
| **Data acquisition** | `data_set_source`, `data_add_sample`, `data_add_file`, `data_link_galaxy`, `data_generate_samplesheet`, `data_get_provenance` |
| **Analysis** | `analysis_plan_create`, `analysis_plan_add_step`, `analysis_plan_update_step`, `analysis_plan_get`, `analysis_plan_activate`, `analysis_plan_summary`, `analysis_step_log`, `analysis_checkpoint` |
| **Notebooks** | `analysis_notebook_create`, `analysis_notebook_open`, `analysis_notebook_list` |
| **Publication** | `publication_init`, `publication_generate_methods`, `publication_add_figure`, `publication_update_figure`, `publication_recommend_figures`, `publication_get_status` |

## Related Projects

- [Galaxy](https://galaxyproject.org) — Open-source platform for data-intensive biomedical research
- [galaxy-mcp](https://github.com/galaxyproject/galaxy-mcp) — MCP server for the Galaxy API
- [Pi coding agent](https://github.com/badlogic/pi-mono) — The Pi.dev agent framework

## License

MIT
