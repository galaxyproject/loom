# Pi-Galaxy-Analyst

A [Pi.dev](https://pi.dev) package that transforms Pi into a Galaxy-focused co-scientist agent for bioinformatics analysis.

## What It Does

Pi-Galaxy-Analyst provides **plan-based analysis** — a structured approach to bioinformatics workflows where the agent:

1. **Understands** your research question and data
2. **Creates** a structured analysis plan
3. **Executes** steps using Galaxy tools and workflows
4. **Validates** results at QC checkpoints
5. **Documents** every decision and observation
6. **Iterates** based on findings

The agent works WITH you, not FOR you — you make the decisions, it helps execute them rigorously.

## Quick Start

### One-Line Install

```bash
curl -fsSL https://raw.githubusercontent.com/galaxyproject/pi-galaxy-analyst/main/install.sh | bash
```

Then run:
```bash
galaxy-analyst
```

The first time you run it, you'll be prompted for your Galaxy server URL and API key.

### What Gets Installed

- **Pi coding agent** — The AI agent framework
- **pi-mcp-adapter** — Connects Pi to MCP servers
- **galaxy-mcp** — MCP server for Galaxy API
- **pi-galaxy-analyst** — This package (skills + extensions)

## Manual Installation

If you prefer to install components separately:

### Prerequisites

1. Node.js 18+
2. [Pi coding agent](https://github.com/badlogic/pi-mono)
3. [uv](https://github.com/astral-sh/uv) or Python 3.10+

### Install Steps

```bash
# 1. Install Pi if needed
npm install -g @mariozechner/pi-coding-agent

# 2. Install pi-mcp-adapter
pi install npm:pi-mcp-adapter

# 3. Clone and install pi-galaxy-analyst
git clone https://github.com/galaxyproject/pi-galaxy-analyst.git
pi install git:./pi-galaxy-analyst

# 4. Clone galaxy-mcp
git clone https://github.com/galaxyproject/galaxy-mcp.git ~/.galaxy-mcp
```

### Configure Galaxy MCP

Create `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "galaxy": {
      "command": "uv",
      "args": ["run", "--python", "3.12", "--directory", "~/.galaxy-mcp/mcp-server-galaxy-py", "galaxy-mcp"],
      "lifecycle": "lazy",
      "directTools": [
        "connect", "get_histories", "create_history",
        "get_history_contents", "get_dataset_details",
        "upload_file", "search_tools_by_name",
        "get_tool_details", "run_tool", "get_job_details",
        "recommend_iwc_workflows", "invoke_workflow",
        "get_invocations"
      ]
    }
  }
}
```

Note: Python 3.12 is specified because newer Python versions (3.14+) have compatibility issues with pydantic-core.

### Set Galaxy Credentials

Either via environment:
```bash
export GALAXY_URL="https://usegalaxy.org"
export GALAXY_API_KEY="your-api-key"
```

Or use `/connect` command after starting — it will prompt you interactively.

### Using Local LLMs (Optional)

To use a local LLM provider like [LiteLLM](https://litellm.ai/) instead of commercial APIs:

1. Create `~/.pi/agent/models.json`:
```json
{
  "providers": {
    "litellm": {
      "baseUrl": "http://localhost:4000/v1",
      "api": "openai-completions",
      "apiKey": "your-litellm-key",
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

2. Create `~/.pi/agent/settings.json`:
```json
{
  "defaultProvider": "litellm",
  "defaultModel": "your-model-name"
}
```

The `api` field should be `openai-completions` for most OpenAI-compatible APIs.

## Usage

Start Pi and begin an analysis conversation:

```
$ pi

You: I have RNA-seq data from a drug treatment experiment. 6 samples - 3 treated, 3 control.
     I want to find differentially expressed genes.

Pi: I'll help you set up a structured RNA-seq differential expression analysis...
    [Creates analysis plan, walks through each step with you]
```

### Commands

| Command | Description |
|---------|-------------|
| `/connect` | Connect to Galaxy (prompts for credentials if not set) |
| `/status` | Show Galaxy connection and plan status |
| `/plan` | View current analysis plan summary |
| `/plan-decisions` | View recent decisions in the analysis |

### Skills Provided

| Skill | When Used |
|-------|-----------|
| `analysis-plan` | Starting any new analysis, creating structured plans |
| `rnaseq-analysis` | RNA-seq differential expression workflows |
| `data-assessment` | Inspecting and validating data |
| `result-review` | Interpreting and summarizing results |

### Custom Tools

The extension registers these tools for plan management:

| Tool | Purpose |
|------|---------|
| `analysis_plan_create` | Create new analysis plan |
| `analysis_plan_add_step` | Add step to plan |
| `analysis_plan_update_step` | Update step status |
| `analysis_plan_get` | Get plan details |
| `analysis_step_log` | Log decisions |
| `analysis_checkpoint` | Create QC checkpoints |

## Architecture

```
┌─────────────────────────────────────────┐
│           pi-galaxy-analyst             │
│  ┌─────────────┐  ┌─────────────────┐  │
│  │ Extensions  │  │     Skills      │  │
│  │ - state     │  │ - analysis-plan │  │
│  │ - tools     │  │ - rnaseq        │  │
│  │ - context   │  │ - data-assess   │  │
│  └─────────────┘  └─────────────────┘  │
│            │                            │
│    ┌───────┴───────┐                   │
│    │ galaxy-skills │ (knowledge ref)   │
│    └───────────────┘                   │
└────────────┬────────────────────────────┘
             │ pi-mcp-adapter
             ▼
      ┌─────────────┐
      │ galaxy-mcp  │
      └──────┬──────┘
             ▼
      ┌─────────────┐
      │   Galaxy    │
      └─────────────┘
```

## Example Session

```
You: I want to analyze some RNA-seq data

Pi: I'd be happy to help you set up an RNA-seq analysis. Let me ask a few questions first:

1. What's your research question - what are you trying to learn from this data?
2. What data do you have? (Number of samples, conditions, paired/single-end?)
3. What organism and which reference genome should we use?
4. What's your comparison design (e.g., treatment vs control)?

You: I'm studying gene expression changes after drug treatment in human cells.
     I have 6 samples - 3 treated, 3 DMSO control. Paired-end, 150bp.
     Human, GRCh38. Want to find genes changed by the drug.

Pi: Got it. Let me create an analysis plan...

[Creates plan with steps: QC → Trimming → Alignment → Quantification → DE Analysis]

Here's the proposed plan. Should I walk through each step, or does this look good to proceed?

You: Looks good, let's start

Pi: [Activates plan, begins Step 1]
    Starting Step 1: Raw Read Quality Assessment

    I'll run FastQC on your FASTQ files. First, let me connect to Galaxy and
    upload your data...
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT

## Related Projects

- [galaxy-mcp](https://github.com/galaxyproject/galaxy-mcp) - MCP server for Galaxy
- [galaxy-skills](https://github.com/galaxyproject/galaxy-skills) - Skills for Galaxy development
- [Pi coding agent](https://github.com/badlogic/pi-mono) - The Pi.dev agent framework
