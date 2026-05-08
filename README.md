# Loom & Orbit

![Ask me about Loom](app/src/renderer/assets/badges/ask-me-about-loom.svg)

An AI research harness for [Galaxy](https://galaxyproject.org) bioinformatics, built on [Pi.dev](https://pi.dev).

Loom turns a working directory into a co-scientist project: ad-hoc exploration, plans, executed steps, interpretations, and follow-up plans all accumulate as markdown in a single, durable, git-tracked `notebook.md`. The agent reads and writes that notebook directly; there is no parallel structured-state store. When Galaxy is configured the agent surveys the workflow registry and tool catalog while drafting plans and routes individual steps to Galaxy or local execution as appropriate.

**Loom** is the agent brain — the Pi.dev runtime in [`extensions/loom/`](extensions/loom/), the system-prompt context, Galaxy invocation tracking, the skills system, and the RPC contract. Run it directly from the terminal with `loom` (`npm install -g @galaxyproject/loom`) or through **Orbit** (in [`app/`](app/)), the Electron desktop shell with a chat + tabbed-artifact layout.

The names trace real cosmology. The universe's large-scale structure is the _cosmic web_ -- galaxies strung along filaments of dark matter, woven into sheets and voids. Loom weaves your research record the way the cosmic web weaves galaxies; Orbit is the electron shell you observe it from.

Future shells — a Galaxy-embedded web UI, a hosted server mode, anything else — talk to the same brain over RPC.

## How it works

1. You open Orbit (or run `loom`) in an analysis directory. A `notebook.md` is created on first launch and committed to git.
2. You chat with the agent: ask questions, drop file paths, request data lookups. None of this requires a "plan" — the conversation is just a conversation.
3. When you ask for a plan, the agent drafts it **in chat** as a markdown section, then waits for you to approve. Once you approve, it asks you to review parameters; once you approve those too, it writes the plan section into `notebook.md` and starts executing.
4. If Galaxy is connected, the agent considers per-step routing during drafting (does an IWC workflow match? does Galaxy have the heavy tool installed?) and tags each step `[local]`, `[hybrid]`, or `[remote]` in the markdown.
5. While a Galaxy step runs, a `loom-invocation` YAML block in the notebook tracks the invocation. The polling tool reads those blocks, queries Galaxy, and updates them in place when jobs finish or fail.
6. Multiple plans coexist in the notebook. After interpreting one analysis, ask for another — the new plan section appends below the previous one.
7. Come back the next day, open the same directory, the notebook is the project. Sessions resume automatically.

## Architecture

Engineer-facing architecture reference: [docs/architecture.md](docs/architecture.md)
Repo conventions and developer workflow: [CLAUDE.md](CLAUDE.md)

```
Brain (Loom)                                  Shells
────────────                                  ──────
extensions/loom/                              bin/loom.js              terminal CLI
  index.ts      extension entry               app/                     Orbit Electron shell
  state.ts      session state (no plan)         src/main/              Node.js main process
  tools.ts      LLM-callable tools              src/preload/           window.orbit bridge
  context.ts    system prompt + skills router   src/renderer/          chat + artifact panes
  ui-bridge.ts  notebook → widget                 chat/                streaming messages
  notebook-                                       artifacts/           notebook + activity tabs
    writer.ts   notebook I/O + invocation YAML    files/               file tree + viewer
  profiles.ts   Galaxy server profiles
  teams/        team_dispatch (experimental)
~/.loom/config.json    shared brain config
~/.loom/cache/skills/  per-repo skills cache (24h TTL)
~/.orbit/              Orbit-specific state (window geometry, etc.)
```

The notebook is the durable state. Plans, decisions, results, and interpretation all live as markdown sections inside `notebook.md` — the agent maintains them via the standard `Edit`/`Write` tools. The only structured side-records are `loom-invocation` YAML blocks for in-flight Galaxy work.

## Current state

Implemented and locally tested.

- TypeScript typecheck passes (root + Orbit).
- Local automated suite: 117 tests passing (notebook I/O, invocation YAML round-trip, profile / credential handling, team-dispatch, session-index, Galaxy config).
- Notebook is the source of truth -- there is no parallel plan struct to drift from it.
- Galaxy invocation polling is exercised against the deterministic state-transition rules (`all-ok → completed`, `any-error → failed`).
- Skills system fetches on demand from `galaxyproject/galaxy-skills` (shipped as default). Additional skill repos are restricted to `github.com/galaxyproject/*` for the alpha (skill content is treated as authoritative agent instructions, so an arbitrary third-party repo would be a prompt-injection vector).
- Galaxy API keys are encrypted at rest in Orbit via Electron `safeStorage`; the brain receives the decrypted key as an env var at spawn time. CLI users without `safeStorage` fall back to plaintext on disk.
- End-to-end validation against a live Galaxy server is in progress.

### What Orbit ships today

- **Three-pane layout**: file tree on the left, chat in the center, tabbed artifact pane on the right (Notebook, Activity, File).
- **Notebook tab**: live `notebook.md` rendered as markdown with auto-refresh on file changes. Project log accumulates over time.
- **Activity tab**: split horizontally — agent shell stream on top (live tool calls, status, stdout from `run_command`), proc-monitor on the bottom (live CPU / memory / runtime for every subprocess the agent spawns).
- **File tab**: appears when you open a file from the left tree, dismissable via `×`. Previews text (Markdown, code, JSON/YAML, FASTA / FASTQ / VCF / BED / GFF / GTF / SAM / Newick / etc.), images, and PDFs.
- **Chat**: streaming responses with thinking indicator; markdown-rendered with proper tables; `team_dispatch` rich card; queue-while-streaming; numbered prompt turns (`/summarize 3 5` works against those numbers).
- **Slash-command popup** appears as you type `/`. Tab to autocomplete; Enter still submits past it; Esc dismisses.
- **Prompt history**: ↑ / ↓ in the input recalls previously-submitted prompts (per-cwd, persistent).
- **Galaxy connection indicator** in the footer (RED dot if no API key, GREEN dot if connected). Click to open Preferences.
- **Cost / token header**: live in-flight cost (computed from Pi-reported `usage.cost`) and token totals.
- **Preferences dialog** (`Cmd/Ctrl+,`): provider / model / API key, Galaxy credentials, default working directory, package manager, and a configurable list of **skill repositories** (galaxy-skills shipped as default).
- **First-run welcome screen**: one-page setup. Skippable — you can configure later from Preferences.
- **Responsive layout**: at narrow widths the file tree (<900 px) and artifact pane (<700 px) auto-collapse so the chat stays usable. Toolbar buttons re-expand them.
- **Keyboard accessibility**: `Cmd/Ctrl+\` toggles the artifact pane; `Cmd/Ctrl+B` toggles the file tree; `Cmd/Ctrl+,` opens Preferences; `Cmd/Ctrl+O` switches working directory; `Esc` dismisses modals; gold focus-ring on every Tab-reachable control.
- **Galaxy brand dark theme** with Inter (body) + JetBrains Mono (code) bundled locally.
- **Session continuity**: `--continue` on restart preserves chat history; `/new` starts a clean slate; first launch in a directory with an existing Pi session auto-resumes.

### What the Loom CLI ships today

Everything brain-side works through the CLI. The display is a terminal UI instead of a tabbed artifact pane; structured widget events collapse down to text summaries. Slash commands behave the same. You can use `loom` without ever launching Orbit.

## Project model

A "project" is a working directory. `notebook.md` in that directory is the chronological project log: ad-hoc exploration notes, plan sections, executed steps, interpretations, new plans, and so on. Multiple plans coexist over a project's lifetime.

Plans are markdown sections like:

```markdown
## Plan A: chrM Variant Calling [hybrid]

Goal: identify variants in chrM across 4 paired-end samples, compare allele
frequencies across tissues.

### Steps

- [ ] 1. **QC FASTQ** {#plan-a-step-1} — fastp adapter trim + per-base QC
  - Routing: local
  - Tool: fastp
- [x] 2. **Reference index** {#plan-a-step-2} — bwa index of chrM
  - Routing: local
  - Tool: bwa index, samtools faidx
- [ ] 3. **Read alignment** {#plan-a-step-3} — BWA-MEM, paired collection
  - Routing: Galaxy
  - Tool: bwa-mem2/2.2.1
- ...

### Parameters

| Step | Tool  | Parameter | Default | Value | Description          |
| ---- | ----- | --------- | ------- | ----- | -------------------- |
| 1    | fastp | min_qual  | 20      | 20    | minimum base quality |
```

Conventions:

- Routing tag in the section header: `[local]`, `[hybrid]`, or `[remote]`. Literal so future tooling can grep.
- Step status by the checkbox: `- [ ]` pending, `- [x]` completed, `- [!]` failed.
- Anchors `{#plan-X-step-N}` so Galaxy invocation YAML can reference individual steps.
- Multiple plans coexist; new plan sections append at the bottom. Old plans aren't deleted.

### Four-stage approval before notebook write

Plans don't land in the notebook on first draft. The agent is instructed to follow this order:

1. **Draft in chat** as a markdown plan section. Not in the notebook yet.
2. **Wait for plan approval** ("yes", "go", "looks good", etc.). If you ask for changes, the agent revises the draft in chat and asks again.
3. **Show the parameter table in chat**, accepting inline edits ("set min_qual to 30, leave others"). Default behavior is to show **all** parameters per tool, not a curated subset — you decide what's worth changing.
4. **Wait for parameter approval**.

Only after both gates pass should the agent write the plan section into `notebook.md` and start executing. This is prompt-level discipline, not a hard runtime lock; manual override: tell the agent "save this plan to the notebook even though I haven't approved it" if you really want to.

### Per-plan Galaxy routing

When Galaxy is connected, the agent surveys Galaxy resources before drafting:

- A full IWC workflow match → propose the plan as a single Galaxy invocation (mode: **remote**).
- Otherwise step-by-step: heavy compute (alignment, large variant calling, big assemblies) → Galaxy if the tool is available; light/exploratory (parsing, awk/sed/jq, small scripts) → local.

The three operating modes (**local** / **hybrid** / **remote**) are an _outcome_ of the plan, not a configuration setting.

### Galaxy invocation tracking

When an agent invokes a Galaxy workflow it embeds a fenced YAML block in the notebook:

```loom-invocation
invocation_id: abc123
galaxy_server_url: https://usegalaxy.org
notebook_anchor: plan-a-step-3
label: BWA alignment
submitted_at: 2026-04-25T15:30:00Z
status: in_progress
summary: ""
```

The polling tool `galaxy_invocation_check_all` scans the notebook for in-flight blocks, polls Galaxy for each, and applies deterministic state transitions (all-jobs-ok → `completed`, any-error → `failed`) by rewriting the YAML in place. No external state store; the notebook is authoritative.

### Git-tracked notebooks

When Loom starts in a directory that isn't already a git repo, it runs `git init`, drops a bioinformatics-friendly `.gitignore`, and marks the repo with `git config loom.managed true`. From then on every notebook write triggers an auto-commit, giving you:

- **Full undo history.** `git log` shows what changed and when.
- **Reproducibility evidence.** Timestamped, immutable record of every decision.
- **Branch-based exploration.** Try an alternative on a branch; compare with `git diff`.
- **Collaboration.** Push the repo to GitHub; collaborators pull, review, and continue.

If you start Loom in an **existing** git repo, auto-commit stays off by default -- Loom won't write commits into a project it didn't create. Opt in with:

```bash
git config loom.managed true
```

The auto-created `.gitignore` excludes large bioinformatics files (FASTQ, BAM, VCF, etc.) plus the per-session `activity.jsonl` and `session.jsonl` sidecars, so only the notebook markdown and small artifacts get tracked.

## Skills system

Loom can fetch operational know-how from curated GitHub repos following the Claude-Code skills convention (top-level `AGENTS.md` router + nested `SKILL.md` files). The agent calls `skills_fetch({ repo, path })` on demand.

**`galaxyproject/galaxy-skills` is shipped as the default** — when no skills are configured, Loom seeds it on first read. It covers:

- **Collection manipulation** (paired collections from PE FASTQ, mapping a tool over a collection, Apply Rules DSL, Galaxy Tools API patterns)
- **Galaxy MCP usage and gotchas**
- **Workflow report templates**
- **Nextflow → Galaxy conversion**
- **Galaxy tool development**
- **Updating ToolShed tool revisions**

Add your own repos in **Preferences → Skills**. Each entry is `{ name, url, branch?, enabled? }`. For the alpha, the URL allowlist is `https://github.com/galaxyproject/*` (the agent treats fetched SKILL.md content as authoritative instructions, so arbitrary repos are a prompt-injection vector). Example:

```json
{
  "skills": {
    "repos": [
      {
        "name": "galaxy-skills",
        "url": "https://github.com/galaxyproject/galaxy-skills",
        "enabled": true
      },
      {
        "name": "galaxy-genome-skills",
        "url": "https://github.com/galaxyproject/galaxy-genome-skills",
        "branch": "main",
        "enabled": true
      }
    ]
  }
}
```

Loosening the allowlist means editing `ALLOWED_SKILLS_PREFIX` in `shared/loom-config.js`. Plan: a per-repo signing / pinning model before opening this up.

Fetched files cache to `~/.loom/cache/skills/<repo-name>/<path>` with a 24-hour TTL -- covers offline use and reduces network round-trips on repeated reads.

## Install

Three paths, depending on what you want.

### Desktop app (Orbit)

Orbit ships as a native installer (signed DMG on macOS, AppImage/deb on Linux, installer on Windows) and bundles its own Node runtime, `uv`, and Loom -- so there are no separate prerequisites. Once a build is signed and published, install it from the [Releases page](https://github.com/galaxyproject/loom/releases). Until then, use the developer install below.

### Loom CLI from npm

Run the brain on the command line without Orbit. Requires Node 20+ and (for Galaxy MCP) [uv](https://docs.astral.sh/uv/).

```bash
npm install -g @galaxyproject/loom
loom
```

Or run without installing:

```bash
npx @galaxyproject/loom
```

Install `uv` if you don't already have it:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### Developer install (build from source)

Clone the repo and install both workspaces:

```bash
git clone https://github.com/galaxyproject/loom.git
cd loom
npm install
cd app && npm install
```

Launch Orbit:

```bash
npm start                              # from app/
```

Or use the CLI:

```bash
node bin/loom.js                       # from repo root
```

The developer install needs Node 20+ and `uv` on `PATH`. Per-OS bootstrap below.

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

Then the developer install steps above.

#### macOS

```bash
# Homebrew, if not already installed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

brew install node git uv
```

Then the developer install steps above.

#### Windows (WSL2)

Orbit runs on Windows inside WSL2. From an elevated PowerShell:

```powershell
wsl --install --web-download -d Ubuntu
```

Reboot, set up your Ubuntu user, then inside the Ubuntu terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/galaxyproject/loom/main/scripts/setup-wsl.sh | bash
source ~/.bashrc

cd ~/loom/app && npm start
```

Keep your analysis data inside `~/` (the Linux filesystem) — `/mnt/c/` paths are significantly slower across the filesystem boundary.

### After installation

In Orbit, on first launch, the welcome screen asks for an LLM provider + key and (optionally) a Galaxy server. You can also click **Skip — set up later** and configure things from Preferences when you're ready. You need at least one of: [Anthropic](https://console.anthropic.com/), [OpenAI](https://platform.openai.com/), or [Google AI](https://aistudio.google.com/). Local providers like [Ollama](https://ollama.com/) and LiteLLM work too.

In `loom`, the equivalent is editing `~/.loom/config.json` (see [Configuration](#configuration)) or running `loom --provider anthropic` and following the OAuth prompts.

## Usage

### CLI (`loom`)

```bash
loom
```

```
You: I have RNA-seq data from a drug treatment experiment — 6 samples,
     3 treated and 3 control HeLa cells. The data is at GEO accession GSE164073.

Pi:  I'll help you set up a structured analysis. Let me check what's
     available.

     [searches Galaxy IWC, finds RNA-seq DE workflow]
     [searches Galaxy tool catalog for fastp, hisat2, featureCounts, DESeq2]

     Drafting plan in chat — review before I write to notebook.md:

     ## Plan A: HeLa Drug Treatment RNA-seq DE [hybrid]

     ### Steps
     - [ ] 1. **Quality + trimming** — fastp paired collection
       - Routing: Galaxy (fastp/0.23.4)
     - [ ] 2. **Alignment** — HISAT2 to hg38 paired collection
       - Routing: Galaxy (hisat2/2.2.1)
     - [ ] 3. **featureCounts**
       - Routing: Galaxy (featurecounts/2.0.3)
     - [ ] 4. **DESeq2 differential expression**
       - Routing: Galaxy (deseq2/1.40.2)

     Approve and I'll show you the parameter table next.

You: looks good

Pi:  [shows parameter table per tool]
     [...iterates with you on min-quality, threshold...]
     [on approval: writes plan to notebook.md, begins execution]
```

Come back the next day to the same directory and everything resumes:

```
$ loom

Pi:  Loaded notebook: HeLa Drug Treatment RNA-seq DE
     Plan A is in progress (1 of 4 steps complete).

     The fastp invocation finished successfully. HISAT2 alignment is queued.
     Should I check_all to advance, or do you want to review the QC report first?
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

The artifact pane reveals on the first agent turn. Switch tabs with the buttons at the top of the pane:

- **Notebook** — live `notebook.md`.
- **Activity** — agent shell stream + proc-monitor.
- **File** — appears when you open a file from the left tree.

Keyboard shortcuts:

- `Cmd/Ctrl+\` — collapse / expand the artifact pane
- `Cmd/Ctrl+B` — collapse / expand the file tree
- `Cmd/Ctrl+,` — open Preferences
- `Cmd/Ctrl+O` — switch working directory and restart into a fresh agent session for that directory
- `↑` / `↓` in the chat input — recall previous prompts
- `/` — open the slash-command autocomplete
- `Esc` — dismiss modal prompts; close slash popup; cancel mid-response

## Configuration

Loom uses a single brain-level config at `~/.loom/config.json`. Every consumer (the `loom` CLI, Orbit, any future shell) reads and writes it:

```json
{
  "llm": {
    "provider": "anthropic",
    "apiKey": "sk-ant-...",
    "model": "claude-sonnet-4-6"
  },
  "galaxy": {
    "active": "default",
    "profiles": {
      "default": {
        "url": "https://usegalaxy.org",
        "apiKey": "abc123"
      }
    }
  },
  "skills": {
    "repos": [
      {
        "name": "galaxy-skills",
        "url": "https://github.com/galaxyproject/galaxy-skills",
        "branch": "main",
        "enabled": true
      }
    ]
  },
  "defaultCwd": "~/analyses",
  "condaBin": "auto"
}
```

All sections are optional. If `llm` is missing, consumers fall back to environment variables or OAuth login. If `galaxy` is missing, use `/connect` to add a server interactively -- credentials save to the config automatically. Galaxy MCP registers whenever credentials are present; the agent decides per-plan whether to use Galaxy. If `skills` is missing or empty, `galaxy-skills` is lazy-seeded.

#### Galaxy credential storage

Galaxy profiles are stored in `~/.loom/config.json` under `galaxy.profiles.<name>`. The exact field depends on which shell wrote them:

- **Orbit** -- writes `apiKeyEncrypted` (base64 ciphertext from Electron `safeStorage`). The decrypted key is injected into the brain process as `GALAXY_API_KEY` at spawn time. If a brain-side `/connect` writes a plaintext `apiKey`, Orbit's config watcher re-encrypts it within milliseconds.
- **CLI** (no `safeStorage` available) -- writes `apiKey` in plaintext. The file mode is tightened to `0600`, but the key sits at rest. Acceptable for a workstation; not appropriate for shared hosts.

The brain itself never decrypts. If only `apiKeyEncrypted` is present and `GALAXY_API_KEY` isn't in the environment, the brain logs a clear warning at startup and refuses to send Galaxy requests rather than firing the wrong key.

Orbit-specific state (window geometry, pane preferences, prompt history) lives in `~/.orbit/` so multiple shells can coexist without stepping on each other.

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

You'll also need `~/.pi/agent/models.json` for model capability metadata (context window, token limits) — see Pi's documentation. The Loom config handles provider selection and API keys; `models.json` handles model metadata Pi needs for request sizing.

Or pass flags directly: `loom --provider litellm --model your-model-name`.

## Cost tracking

Orbit's footer shows live in-flight cost for the active session (computed from `usage.cost` returned per stream event by pi-ai). For accurate **historical / per-project / per-model** reporting across all your sessions, run [CodeBurn](https://github.com/getagentseal/codeburn) in a separate terminal:

```bash
npx codeburn          # interactive TUI dashboard
npx codeburn today    # today's spend
npx codeburn month    # this month
npx codeburn status   # one-liner: today + month totals
```

CodeBurn auto-detects Loom/Pi sessions under `~/.pi/agent/sessions/` (Pi is a first-class supported provider — no configuration needed) and pulls model pricing from LiteLLM's catalog, so newly-released models work without a Loom update. Each Loom project (= cwd) shows up as a separate row, so you can see what each analysis cost. CSV / JSON export is built in.

## Commands

### Slash commands

Type `/` in the chat to open the autocomplete popup. Tab to accept; Enter still submits past it.

| Command                   | What it does                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `/model <name>`           | Switch the LLM model (e.g. `/model sonnet`, `/model claude-opus-4-6`)              |
| `/new`                    | Start a fresh session (Orbit only). Confirms before deleting the existing notebook |
| `/resume`                 | Restart the agent and replay the prior session's chat                              |
| `/chat`                   | Restore the chat pane from the session transcript without restarting the agent     |
| `/notebook`               | Show the notebook content in the Notebook tab                                      |
| `/status`                 | Galaxy connection + notebook path summary                                          |
| `/summarize [N [M]]`      | Append a summary of prompts N..M into the notebook                                 |
| `/cost`                   | Append the session token/cost breakdown to the notebook                            |
| `/connect [name]`         | Open Galaxy connection settings (or switch to an existing profile)                 |
| `/profiles`               | List saved Galaxy server profiles                                                  |
| `/execute` (alias `/run`) | Tell the agent to advance the next pending step in the latest plan section         |
| `/help`                   | Show this list                                                                     |

## Tool reference

Loom registers a small set of extension tools. Plans, decisions, results, and interpretation all live as markdown sections in `notebook.md` — the agent maintains them via the standard `Edit`/`Write` tools.

| Category                       | Tools                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| **GTN tutorials**              | `gtn_search`, `gtn_fetch`                                                                |
| **Galaxy invocations**         | `galaxy_invocation_record`, `galaxy_invocation_check_all`, `galaxy_invocation_check_one` |
| **Skills**                     | `skills_fetch` (fetch SKILL.md / reference docs from configured repos)                   |
| **Multi-agent (experimental)** | `team_dispatch` (gated by `LOOM_TEAM_DISPATCH=1`)                                        |

Galaxy MCP (registered separately when credentials are present) provides `galaxy_connect`, `galaxy_search_tools_by_name`, `galaxy_run_tool`, `galaxy_invoke_workflow`, `galaxy_search_iwc`, `get_iwc_workflows`, `import_workflow_from_iwc`, user-defined tool lifecycle (`galaxy_create_user_tool`, `galaxy_list_user_tools`, `galaxy_run_user_tool`, `galaxy_delete_user_tool`), history/dataset operations, and more.

## Tech stack

| Component  | Technology                                            |
| ---------- | ----------------------------------------------------- |
| Agent      | Pi.dev (`@mariozechner/pi-coding-agent`)              |
| MCP bridge | `pi-mcp-adapter`, `uvx galaxy-mcp`                    |
| Language   | TypeScript (strict)                                   |
| Tests      | Vitest                                                |
| Desktop    | Electron 35                                           |
| Build      | Vite + electron-forge                                 |
| Markdown   | `marked`                                              |
| Fonts      | Inter (body), JetBrains Mono (code)                   |
| Theme      | Galaxy brand dark (`#2c3143` + gold accent `#ffd700`) |

## Terminal-only validation

For non-Electron validation:

```bash
npm run typecheck
npm test
pi --no-extensions -e ./extensions/loom
```

Then validate the wrapper in a plain working directory:

```bash
mkdir -p /tmp/loom-cli-validation
cd /tmp/loom-cli-validation
node /path/to/loom/bin/loom.js --provider anthropic --model claude-sonnet-4-6
```

For a full terminal-only runbook, see [docs/terminal-validation.md](docs/terminal-validation.md).

## Related projects

- [Galaxy](https://galaxyproject.org) — open-source platform for data-intensive biomedical research
- [galaxy-mcp](https://github.com/galaxyproject/galaxy-mcp) — MCP server for the Galaxy API
- [galaxy-skills](https://github.com/galaxyproject/galaxy-skills) — curated operational skills the agent fetches on demand
- [Pi coding agent](https://github.com/badlogic/pi-mono) — the Pi.dev agent framework
- [CodeBurn](https://github.com/getagentseal/codeburn) — TUI dashboard for AI-coding cost observability (Pi is a first-class provider)

## License

MIT
