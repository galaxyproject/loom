# Loom & Orbit

An AI research harness for [Galaxy](https://galaxyproject.org) bioinformatics, built on [Pi.dev](https://pi.dev).

Loom weaves the threads of a research project -- question, data, analysis, interpretation, publication -- into a durable, resumable notebook. It creates plans, runs Galaxy tools, documents every decision, and keeps the whole record reproducible.

**Loom** is the agent brain -- the Pi.dev runtime in [`extensions/loom/`](extensions/loom/), the RPC contract, plan state, notebook persistence, Galaxy integration, the five-phase lifecycle, and provenance. Run it directly from the terminal with `loom` (`npm install -g loom`) or through **Orbit** (in [`app/`](app/)), the Electron desktop shell with a chat + dual-pane artifact layout and a Galaxy-themed step graph.

Future shells -- a Galaxy-embedded web UI, a hosted server mode, anything else -- talk to the same brain over RPC.

## How it works

1. You open Orbit (or run `loom`) in an analysis directory and describe what you want to do.
2. The agent builds a formal plan -- research question, phased steps, dependencies -- and stores it in a markdown notebook committed to git on every change.
3. Real jobs are expected to run in Galaxy by default. Local mode is an escape hatch for exceptional cases, not the normal execution path, and currently has weaker guarantees than the Galaxy path.
4. In Orbit, the artifact pane auto-reveals the Plan tab, the Steps tab renders a React Flow DAG, and the Notebook tab shows the live markdown record. In `loom`, the same state is viewable via slash commands.
5. Come back the next day -- opening the same directory resumes the plan from the notebook, in either consumer.

## Architecture

Engineer-facing architecture reference: [docs/architecture.md](docs/architecture.md)
Repo conventions and developer workflow: [CLAUDE.md](CLAUDE.md)

```
Brain (Loom)                                  Shells
────────────                                  ──────
extensions/loom/                    bin/loom.js              terminal CLI
  index.ts      extension entry               app/                      Orbit Electron shell
  state.ts      plan + notebook state           src/main/               Node.js main process
  tools.ts      34 LLM-callable tools           src/preload/            window.orbit bridge
  context.ts    system prompt injection         src/renderer/           chat + artifact panes
  ui-bridge.ts  plan mutations -> widgets         chat/                 streaming messages
  profiles.ts   Galaxy server profiles            artifacts/            plan / steps / notebook
                                              ProcMonitor               live subprocess stats
~/.loom/config.json  shared brain config
~/.orbit/            Orbit-specific state (window geometry, etc.)
```

## Current state

Implemented and locally tested; live Galaxy end-to-end validation is still in progress.

- TypeScript typecheck passes against `@mariozechner/pi-coding-agent` `0.67.3`
- Local automated suite: 131 tests passing
- Notebook persistence, plan state, workflow metadata, BRC context, and extension registration are covered by tests
- Provenance notebook sync has a dedicated regression check via `npm run validate:provenance`
- Runtime validation has confirmed extension loading, Galaxy connection/history state bridging, and notebook rewriting for `data_set_source`
- Remaining validation: stronger tool-calling model on the live MCP path, then Galaxy end-to-end with real histories, datasets, and jobs

### What Orbit ships today

- Dual-pane layout: streaming chat on the left, collapsible artifact pane on the right (auto-reveals on first plan, toggle with `Cmd/Ctrl+\`)
- Plan tab with rendered markdown + raw edit modes and a parameter form for reviewing step arguments
- Steps tab: React Flow + dagre DAG of the analysis plan with live status coloring
- Notebook tab: the live `notebook.md` rendered as markdown (refresh with `/notebook`) plus typed result blocks from `report_result`
- Chat: streaming, thinking indicator, tool cards, queue-while-streaming
- Process monitor strip: live CPU / memory / runtime for every subprocess the agent spawns
- Cost / token header with pricing for Claude 4.5 & 4.6, GPT-4o, Gemini 2.5, and local providers
- Local / Remote execution toggle in the masthead -- Remote is the supported Galaxy-first execution path; Local strips Galaxy MCP and acts as a guarded bypass for non-standard/debug flows
- Preferences dialog (`Cmd/Ctrl+,`): provider / model / API key, Galaxy credentials, default working directory
- First-run welcome screen: one-page setup for LLM key, optional Galaxy profile, working directory
- Galaxy brand dark theme with Inter + JetBrains Mono fonts bundled locally
- Session continuity: `--continue` on restart (model switch, preference save, Local/Remote toggle) preserves chat history; `/new` starts a clean slate; first launch in a directory with an existing Pi session auto-resumes

### What the Loom CLI ships today

Everything brain-side works through the CLI. The display is a terminal UI instead of a React artifact pane; structured widget events collapse down to text summaries. Slash commands (`/plan`, `/status`, `/notebook`, `/plan-decisions`, `/connect`, `/profiles`) behave the same. You can use `loom` without ever launching Orbit.

## Install

### Quick path -- CLI only

```bash
npm install -g loom
```

Or run without installing:

```bash
npx loom
```

You'll also need [uv](https://docs.astral.sh/uv/) for the Galaxy MCP server (invoked automatically via `uvx`):

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### Full install -- CLI + Orbit

Clone the repo and install both workspaces:

```bash
git clone https://github.com/galaxyproject/pi-galaxy-analyst.git
cd pi-galaxy-analyst
npm install
cd app && npm install
```

Launch Orbit:

```bash
npm start                              # from app/
```

Or use the CLI:

```bash
node bin/loom.js                      # from repo root
```

#### Linux (Ubuntu/Debian)

```bash
sudo apt update
sudo apt install -y git curl build-essential

# Node.js via nvm (if not already installed)
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install --lts

# uv (for galaxy-mcp)
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Then the "Full install" steps above.

#### macOS

```bash
# Homebrew, if not already installed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

brew install node git uv
```

Then the "Full install" steps above.

#### Windows (WSL2)

Orbit runs on Windows inside WSL2. From an elevated PowerShell:

```powershell
wsl --install --web-download -d Ubuntu
```

Reboot, set up your Ubuntu user, then inside the Ubuntu terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/galaxyproject/pi-galaxy-analyst/main/scripts/setup-wsl.sh | bash
source ~/.bashrc

cd ~/pi-galaxy-analyst/app && npm start
```

Keep your analysis data inside `~/` (the Linux filesystem) -- `/mnt/c/` paths are significantly slower across the filesystem boundary.

### After installation

In Orbit, on first launch, the welcome screen asks for an LLM provider + key and (optionally) a Galaxy server. You need at least one of: [Anthropic](https://console.anthropic.com/), [OpenAI](https://platform.openai.com/), or [Google AI](https://aistudio.google.com/). Local providers like [Ollama](https://ollama.com/) and LiteLLM work too.

In `loom`, the equivalent is editing `~/.loom/config.json` (see [Configuration](#configuration)) or running `loom --provider anthropic` and following the OAuth prompts.

## Usage

### CLI (`loom`)

```bash
loom
```

```
You: I have RNA-seq data from a drug treatment experiment -- 6 samples,
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
```

Come back the next day to the same directory and everything resumes:

```
$ loom

Pi:  Loaded notebook: RNA-seq Drug Treatment (1/5 steps completed)

     Last session completed Quality Control (passed).
     Next step: Read Trimming with Cutadapt.

     Ready to continue?
```

You can also load just the extension into Pi directly:

```bash
pi --no-extensions -e ./extensions/loom
```

If you're debugging the terminal path, prefer these commands before using Orbit.

### Orbit (Electron shell)

```bash
cd app && npm start
```

The artifact pane starts collapsed; as soon as the agent creates a plan, it auto-reveals on the Plan tab. The Steps tab shows the React Flow DAG. The Notebook tab renders the live markdown notebook (refresh with `/notebook`). Tab activity dots highlight updates since you last viewed each tab.

Keyboard shortcuts:
- `Cmd/Ctrl+\` -- collapse / expand the artifact pane
- `Cmd/Ctrl+,` -- open Preferences
- `Cmd/Ctrl+O` -- switch working directory and restart into a fresh agent session for that directory
- `Esc` -- dismiss modal prompts

## Configuration

Loom uses a single brain-level config at `~/.loom/config.json`. Every consumer (the `loom` CLI, Orbit, any future shell) reads and writes it:

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
  },
  "executionMode": "remote",
  "defaultCwd": "~/analyses"
}
```

All sections are optional. If `llm` is missing, consumers fall back to environment variables or OAuth login. If `galaxy` is missing, use `/connect` to add a server interactively -- credentials save to the config automatically. `executionMode` is `"remote"` by default (registers Galaxy MCP, Galaxy UDTs are the primary and preferred execution path). `"local"` strips Galaxy MCP and should be treated as an escape hatch, not a peer runtime.

Orbit-specific state (window geometry, pane preferences) lives in `~/.orbit/` so multiple shells can coexist without stepping on each other.

Environment variable overrides:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export GALAXY_URL="https://usegalaxy.org"
export GALAXY_API_KEY="your-api-key"
```

Galaxy credentials can also be provided via environment variables (`GALAXY_URL`, `GALAXY_API_KEY`) for CI or testing, but `~/.loom/config.json` is the primary source.

### Local LLMs

Pi supports any OpenAI-compatible API. For [LiteLLM](https://litellm.ai/), [Ollama](https://ollama.com/), or other local backends:

```json
{
  "llm": {
    "provider": "litellm",
    "apiKey": "your-key",
    "model": "your-model-name"
  }
}
```

You'll also need `~/.pi/agent/models.json` for model capability metadata (context window, token limits) -- see Pi's documentation. The Loom config handles provider selection and API keys; `models.json` handles model metadata Pi needs for request sizing.

Or pass flags directly: `loom --provider litellm --model your-model-name`.

## Commands

### Slash commands

| Command | What it does |
|---------|-------------|
| `/plan` | Show the current analysis plan |
| `/plan-decisions` | Show the decision log |
| `/notebook` | Show the live notebook content (or list notebooks in cwd) |
| `/status` | Galaxy connection + plan progress summary |
| `/connect [name]` | Connect to Galaxy (prompts for credentials, or switches profile) |
| `/profiles` | List saved Galaxy server profiles |
| `/new` | Start a fresh session (Orbit only) |

In Orbit, `/execute` (alias `/run`) tells the agent to advance the next pending step in the most recent plan section of `notebook.md`. Galaxy routing for each step is decided when the plan is drafted, not at execution time.

## Tool reference

Loom registers a small set of extension tools. Plans, decisions, results, and interpretation all live as markdown sections in `notebook.md` — the agent maintains them via the standard Edit/Write tools.

| Category | Tools |
|----------|-------|
| **GTN tutorials** | `gtn_search`, `gtn_fetch` |
| **Galaxy invocations** | `galaxy_invocation_record`, `galaxy_invocation_check_all`, `galaxy_invocation_check_one` |
| **Multi-agent (experimental)** | `team_dispatch` (gated by `LOOM_TEAM_DISPATCH=1`) |

Galaxy MCP (registered separately when credentials are present) provides `galaxy_connect`, `galaxy_search_tools_by_name`, `galaxy_run_tool`, `galaxy_invoke_workflow`, `galaxy_search_iwc`, history/dataset operations, etc.

## Project model

A "project" is a working directory. `notebook.md` in that directory is the durable record — chronological, accumulates over the project's lifetime: ad-hoc exploration notes, plan sections, executed steps, interpretations, new plans, and so on. Multiple plans coexist.

Plans are markdown sections (`## Plan A:`, `## Plan B:`) with checkbox steps and a routing tag in the header (`[local]`, `[hybrid]`, `[remote]`). The agent decides routing **per plan during drafting**, by consulting the Galaxy workflow registry and tool catalog when Galaxy is connected:

- A full IWC workflow match → entire plan runs as one Galaxy invocation (mode: **remote**).
- Otherwise step-by-step: heavy compute → Galaxy if available; light/exploratory → local.
- All decisions are documented inline in the markdown so the user can review and override.

Galaxy invocations get a typed sidecar: a `loom-invocation` fenced YAML block embedded in the notebook. Polling tools (`galaxy_invocation_check_all`) read these blocks, query Galaxy, and apply deterministic state transitions (all-jobs-ok → completed, any-error → failed) by rewriting the YAML in place.

Phases (problem definition → data acquisition → analysis → interpretation → publication) are narrative organizing concepts the agent uses when drafting the markdown — not enforced state transitions.

### Git-tracked notebooks

When Loom initializes `notebook.md` it sets up a git repo in the working directory (if one doesn't already exist) and commits every meaningful change as it happens. Each agent or user write to the notebook produces a commit.

This gives you:

- **Full undo history.** `git log` shows exactly what changed and when. Diff any two points; revert a bad step.
- **Reproducibility evidence.** The commit history is a timestamped, immutable record of every decision and result.
- **Branch-based exploration.** Try an alternative DE threshold or a different aligner on a branch, compare notebooks side by side with `git diff`.
- **Collaboration.** Push the repo to GitHub and collaborators can pull, review the analysis history, and continue.

The auto-created `.gitignore` excludes large bioinformatics files (FASTQ, BAM, VCF, etc.) so only the notebook markdown and small artifacts get tracked. Granular changes like Galaxy dataset references and literature additions bundle into the next structural commit rather than creating their own, keeping the history clean.

## Tech stack

| Component | Technology |
|---|---|
| Agent | Pi.dev (`@mariozechner/pi-coding-agent`) |
| MCP bridge | `pi-mcp-adapter`, `uvx galaxy-mcp` |
| Language | TypeScript (strict) |
| Tests | Vitest |
| Desktop | Electron 35 |
| Build | Vite + electron-forge |
| Markdown | `marked` |
| Fonts | Inter (body), JetBrains Mono (code) |
| Theme | Galaxy brand dark (`#2c3143` + gold accent `#ffd700`) |

## Terminal-only validation

For non-Electron validation:

```bash
npm run typecheck
npm test
npm run validate:provenance
pi --no-extensions -e ./extensions/loom
```

Then validate the wrapper in a plain working directory:

```bash
mkdir -p /tmp/loom-cli-validation
cd /tmp/loom-cli-validation
node /path/to/pi-galaxy-analyst/bin/loom.js --provider litellm --model gpt-oss-120b
```

For a full terminal-only runbook, see [docs/terminal-validation.md](docs/terminal-validation.md). For the provenance notebook regression, see [docs/live-validation-checklist.md](docs/live-validation-checklist.md).

## Related projects

- [Galaxy](https://galaxyproject.org) -- open-source platform for data-intensive biomedical research
- [galaxy-mcp](https://github.com/galaxyproject/galaxy-mcp) -- MCP server for the Galaxy API
- [Pi coding agent](https://github.com/badlogic/pi-mono) -- the Pi.dev agent framework

## License

MIT
