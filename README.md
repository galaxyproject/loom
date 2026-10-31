# Orbit

> [!TIP]
> **📖 See the docs & live demos → [galaxyproject.github.io/orbit](https://galaxyproject.github.io/orbit/)**
> — _Agentic Science with Galaxy_: an overview of Orbit and Galaxy MCP, an animated walkthrough of real analyses, and getting-started guides.

> [!TIP]
> **🛠️ Want to test or develop Orbit? → [CONTRIBUTING.md](CONTRIBUTING.md)**
> — setup, how to run each shell, the check loop, and how to validate a change for real.

An AI research harness for [Galaxy](https://galaxyproject.org) bioinformatics, built on [Pi.dev](https://pi.dev).

Orbit turns a working directory into a co-scientist project: ad-hoc exploration, plans, executed steps, interpretations, and follow-up plans all accumulate as markdown in a single, durable, git-tracked `notebook.md`. The agent reads and writes that notebook directly; there is no parallel structured-state store. When Galaxy is configured the agent surveys the workflow registry and tool catalog while drafting plans and routes individual steps to Galaxy or local execution as appropriate.

**The Orbit core** is the agent brain — the Pi.dev runtime in [`extensions/orbit/`](extensions/orbit/), the system-prompt context, Galaxy invocation tracking, the skills system, and the RPC contract. Run it directly from the terminal with `orbit` (`npm install -g @galaxyproject/orbit`) or through **Orbit desktop** (in [`app/`](app/)), the Electron shell with a chat + tabbed-artifact layout.

The name is a cosmology nod: the universe's large-scale structure is the _cosmic web_ -- galaxies strung along filaments of dark matter, woven into sheets and voids -- and Orbit is the electron shell you observe it from. Until 0.9 the agent core was called Loom, after the weaving, so older notebooks, notes and talks still carry that name.

Future shells — a Galaxy-embedded web UI, a hosted server mode, anything else — talk to the same brain over RPC.

That web shell already has a working seed today: a browser-served build of the Orbit renderer, running the same brain over RPC, reachable from another device on your LAN -- handy for chatting from a phone, and a natural home for Galaxy interactive tools later on. It's an unauthenticated single-user dev tool for now, so keep it on a trusted network; setup and the security caveats are in [`web/README.md`](web/README.md).

A second web shell lives in [`browser/`](browser/): Orbit's chat UI with the agent running in a browser worker, shipped as the Olit Galaxy visualization plugin. For now that worker carries its own copy of the agent; it is moving onto the same Orbit core, so new brain behavior belongs in `extensions/orbit/`, not in `browser/` (see [`docs/architecture.md`](docs/architecture.md#browser-shell-browser)).

## How it works

1. You open Orbit (or run `orbit`) in an analysis directory. A `notebook.md` is created on first launch and committed to git.
2. You chat with the agent: ask questions, drop file paths, request data lookups. None of this requires a "plan" — the conversation is just a conversation.
3. When you ask for a plan, the agent drafts it **in chat** as a markdown section, then waits for you to approve. Once you approve, it asks you to review parameters; once you approve those too, it writes the plan section into `notebook.md` and starts executing.
4. If Galaxy is connected, the agent considers per-step routing during drafting (does an IWC workflow match? does Galaxy have the heavy tool installed?) and tags each step `[galaxy]`, `[local]`, `[hybrid]`, or `[remote]` in the markdown.
5. While a Galaxy step runs, a `orbit-invocation` YAML block in the notebook tracks the invocation. The polling tool reads those blocks, queries Galaxy, and updates them in place when jobs finish or fail.
6. Multiple plans coexist in the notebook. After interpreting one analysis, ask for another — the new plan section appends below the previous one.
7. Come back the next day, open the same directory, the notebook is the project. Sessions resume automatically.

## Architecture

Engineer-facing architecture reference: [docs/architecture.md](docs/architecture.md)
Repo conventions and developer workflow: [CLAUDE.md](CLAUDE.md)

```
Core (Orbit)                                  Shells
────────────                                  ──────
extensions/orbit/                              bin/orbit.js              terminal CLI
  index.ts      extension entry               app/                     Orbit Electron shell
  state.ts      session state (no plan)         src/main/              Node.js main process
  tools.ts      LLM-callable tools              src/preload/           window.orbit bridge
  context.ts    system prompt + skills router   src/renderer/          chat + artifact panes
  ui-bridge.ts  notebook → widget                 chat/                streaming messages
  notebook-                                       artifacts/           notebook + activity tabs
    writer.ts   notebook I/O + invocation YAML    files/               file tree + viewer
  profiles.ts   Galaxy server profiles
  teams/        team_dispatch (experimental)
~/.orbit/config.json    shared brain config
~/.orbit/cache/skills/  fetched skill repos (24h TTL; bundled repos are not cached here)
~/.orbit/              Orbit-specific state (window geometry, etc.)
```

The notebook is the durable state. Plans, decisions, results, and interpretation all live as markdown sections inside `notebook.md` — the agent maintains them via the standard `Edit`/`Write` tools. The only structured side-records are `orbit-invocation` YAML blocks for in-flight Galaxy work.

## Current state

Implemented and locally tested.

- TypeScript typecheck passes (root + Orbit).
- Local automated suite: 261 tests passing (notebook I/O, invocation YAML round-trip, profile / credential handling, team-dispatch, session-index, Galaxy config).
- Notebook is the source of truth -- there is no parallel plan struct to drift from it.
- Galaxy invocation polling is exercised against the deterministic state-transition rules (`all-ok → completed`, `any-error → failed`).
- Skill content ships inside the package, vendored from `galaxyproject/agentic-plugins` at a pinned commit, so a fresh install has the full catalog with no network. A repo pointed at another branch or URL is fetched instead. Additional skill repos are restricted to `github.com/galaxyproject/*` (skill content is treated as authoritative agent instructions, so an arbitrary third-party repo would be a prompt-injection vector).
- Galaxy API keys are encrypted at rest in Orbit via Electron `safeStorage`; the brain receives the decrypted key as an env var at spawn time. CLI users without `safeStorage` fall back to plaintext on disk.
- End-to-end validation against a live Galaxy server is in progress.

### What Orbit ships today

- **Three-pane layout**: file tree on the left, chat in the center, tabbed artifact pane on the right (Notebook, Activity, File).
- **System file viewer**: right-click a file in the desktop file tree and choose **Open in system viewer** to use its default app (for example, Preview for PDFs on macOS), including files too large for Orbit's preview.
- **Notebook tab**: live `notebook.md` rendered as markdown with auto-refresh on file changes. Project log accumulates over time.
- **Activity tab**: split horizontally — agent shell stream on top (live tool calls, status, stdout from `run_command`), proc-monitor on the bottom (live CPU / memory / runtime for every subprocess the agent spawns).
- **File tab**: appears when you open a file from the left tree, dismissable via `×`. Previews text (Markdown, code, JSON/YAML, FASTA / FASTQ / VCF / BED / GFF / GTF / SAM / Newick / etc.), images, and PDFs.
- **Chat**: streaming responses with thinking indicator; markdown-rendered with proper tables; `team_dispatch` rich card; queue-while-streaming; numbered prompt turns (`/summarize 3 5` works against those numbers).
- **Slash-command popup** appears as you type `/`. Tab to autocomplete; Enter still submits past it; Esc dismisses.
- **Prompt history**: ↑ / ↓ in the input recalls previously-submitted prompts (per-cwd, persistent).
- **Batched SRA imports**: Orbit catches compatible per-accession `fastq_dump`/`fasterq_dump` calls before submission and directs the agent to one collection-producing run. Always-loaded guidance covers accession deduplication, history reuse, and output verification.
- **Galaxy connection indicator** in the footer (RED dot if no API key, GREEN dot if connected). Click to open Preferences.
- **Cost / token header**: live in-flight cost (computed from Pi-reported `usage.cost`) and token totals.
- **Preferences dialog** (`Cmd/Ctrl+,`): provider / model / API key, Galaxy credentials, default working directory, package manager, and a configurable list of **skill repositories** (galaxy-skills shipped as default).
- **First-run welcome screen**: one-page setup. Skippable — you can configure later from Preferences.
- **Responsive layout**: at narrow widths the file tree (<900 px) and artifact pane (<700 px) auto-collapse so the chat stays usable. Toolbar buttons re-expand them.
- **Keyboard accessibility**: `Cmd/Ctrl+\` toggles the artifact pane; `Cmd/Ctrl+B` toggles the file tree; `Cmd/Ctrl+,` opens Preferences; `Cmd/Ctrl+O` switches working directory; `Esc` dismisses modals; gold focus-ring on every Tab-reachable control.
- **Galaxy brand dark theme** with Inter (body) + JetBrains Mono (code) bundled locally.
- **Automatic Galaxy follow-up**: Orbit queues output verification for completed jobs and workflows, and investigates failures without waiting for another prompt. Changes from one poll are batched; a busy agent finishes its current turn first. Verification evidence goes in the notebook, then already-authorized work can continue. Follow-ups pause after 3 automatic turns in a row without user input (`experiments.autoResumeMaxTurns`) or when you stop a turn, until you next say something. Set `ORBIT_AUTO_RESUME=0` or `experiments.autoResume: false` in `~/.orbit/config.json` to disable automatic follow-up.
- **Session continuity**: `--continue` on restart preserves chat history; `/new` starts a clean slate; first launch in a directory with an existing Pi session auto-resumes.

### What the Orbit CLI ships today

Everything brain-side works through the CLI. The display is a terminal UI instead of a tabbed artifact pane; structured widget events collapse down to text summaries. Slash commands behave the same. You can use `orbit` without ever launching Orbit.

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
  - Verification: confirm fastp HTML/JSON report exists and includes per-base quality metrics
- [x] 2. **Reference index** {#plan-a-step-2} — bwa index of chrM
  - Routing: local
  - Tool: bwa index, samtools faidx
  - Verification: confirm BWA index sidecar files and `.fai` exist
- [ ] 3. **Read alignment** {#plan-a-step-3} — BWA-MEM, paired collection
  - Routing: Galaxy
  - Tool: bwa-mem2/2.2.1
  - Verification: poll Galaxy invocation to `ok` and inspect BAM outputs
- ...

### Parameters

| Step | Tool  | Parameter | Default | Value | Description          |
| ---- | ----- | --------- | ------- | ----- | -------------------- |
| 1    | fastp | min_qual  | 20      | 20    | minimum base quality |
```

Conventions:

- Routing tag in the section header: `[remote]` (compute on Galaxy), `[hybrid]`, or `[local]`. Literal so future tooling can grep; older notebooks' `[galaxy]` reads as `[remote]`.
- Step status by the checkbox: `- [ ]` pending, `- [x]` verified completed, `- [!]` failed.
- If verification is blocked or inconclusive but the step itself has not failed, leave the step pending and record the blocker.
- Anchors `{#plan-X-step-N}` so Galaxy invocation YAML can reference individual steps.
- Multiple plans coexist; new plan sections append at the bottom. Old plans aren't deleted.

See [docs/agent/notebook-schema.md](docs/agent/notebook-schema.md) for
verification evidence requirements.

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

```orbit-invocation
invocation_id: abc123
galaxy_server_url: https://usegalaxy.org
notebook_anchor: plan-a-step-3
label: BWA alignment
submitted_at: 2026-04-25T15:30:00Z
status: in_progress
summary: ""
```

The polling tool `galaxy_invocation_check_all` scans the notebook for in-flight blocks, polls Galaxy for each, and applies deterministic state transitions (all-jobs-ok → `completed`, any-error → `failed`) by rewriting the YAML in place. No external state store; the notebook is authoritative.

### The evidence gate

Most of what Orbit enforces mechanically is about safety -- don't shell out, don't leak the key, don't delete the history. The epistemic discipline the product actually exists for ("evidence comes before assertion") was prose in the system prompt, and nothing checked it.

The evidence gate is the first check on that. It watches `Edit`/`Write` calls against `notebook.md` (and Page pulls, which replace it), and judges a plan step arriving at `- [x]` against a record the model can't author. There are two such records.

For a step whose run the approval registry knows about ([`docs/registry.md`](docs/registry.md)), the verdict is the registry's `handoff_eligible`, which Orbit writes from Galaxy's own answers into a store signed by the session. The step is held until that run is eligible: completing it is refused whatever its block's `status:` says, and so is removing or renaming its checkbox, since steps are found by anchor anywhere in the file. Marking it `- [!]` is always fine.

For a run the registry doesn't know -- today, any raw submission -- it falls back to the block: a step going `- [ ]` → `- [x]` while the `orbit-invocation` block bound to its anchor still reads `status: in_progress` is a contradiction. That status comes from the poller, and the check reads the file as it stood _before_ the write, so rewriting `status:` in the same edit doesn't clear it.

It's deliberately narrow. Absence of evidence isn't decidable from a single write (the honest sequence Orbit teaches spans two edits), so absence is never gated -- only contradiction is. A flip with no bound run gets no opinion, a `failed` block is never gated because it's sticky and can't be re-polled, and a rerun that leaves a stale block beside a `completed` one for the same anchor reads as fine.

Modes are `off | warn | deny`, default **deny**: a contradicted write is refused, and the user can clear one step with `/override <step> <reason>`. In `warn` the write goes through. Either way the decision lands in `activity.jsonl` as an `evidence.decision` event. [`docs/evidence-gate-audit.md`](docs/evidence-gate-audit.md) has the audit the default rests on, and what it doesn't cover. Set it in `~/.orbit/config.json`:

```json
{ "evidenceGate": { "mode": "warn" } }
```

or per session with `ORBIT_EVIDENCE_GATE=warn`.

In `deny` the refusal stands for as long as the contradiction does. An earlier cut let the model's second attempt through, but that made the decision advisory, since a model that disagrees only has to ask twice. The exception is yours instead: `/override <step-anchor> <reason>`. On a step the registry holds, it records your exception in the registry for the runs it was held for, so a new run on the step is held again. On the block path it clears one named step for one write and the run in flight when you granted it, held in memory for the session. Either way the step, what held it and your reason go to `activity.jsonl` as an `evidence.override` event. Bare `/override` lists what the gate is currently holding; if a key you type could name two steps, the command asks you to quote the one you mean.

What's left is pinned by tests. On the block path, step identity and status are both notebook text, so a forgery split across two edits, or a renamed anchor or plan heading, still gets past -- those close for raw submissions when `loom_submit` puts them in the registry. On the desktop the exec-guard keeps the shell off `notebook.md`, `activity.jsonl` and the registry altogether, but a script the model writes and runs is out of a command classifier's reach.

### Git-tracked notebooks

When Orbit starts in a directory that isn't already a git repo, it runs `git init`, drops a bioinformatics-friendly `.gitignore`, and marks the repo with `git config loom.managed true`. From then on every notebook write triggers an auto-commit, giving you:

- **Full undo history.** `git log` shows what changed and when.
- **Reproducibility evidence.** Timestamped, immutable record of every decision.
- **Branch-based exploration.** Try an alternative on a branch; compare with `git diff`.
- **Collaboration.** Push the repo to GitHub; collaborators pull, review, and continue.

If you start Orbit in an **existing** git repo, auto-commit stays off by default -- Orbit won't write commits into a project it didn't create. Opt in with:

```bash
git config loom.managed true
```

The auto-created `.gitignore` excludes large bioinformatics files (FASTQ, BAM, VCF, etc.) plus the per-session `activity.jsonl` and `session.jsonl` sidecars, so only the notebook markdown and small artifacts get tracked.

## Skills system

Orbit loads operational know-how from repos of `SKILL.md` files, through `skills_fetch({ repo, path })`. Most of it ships inside the package: the content is vendored from [`galaxyproject/agentic-plugins`](https://github.com/galaxyproject/agentic-plugins) — the same source that distributes it to every other agent — at a commit pinned in `scripts/skills.manifest.json`, so a first run works offline and at a version that went through review. Preferences → Skills shows which repos are bundled and at which commit.

Point a repo at a different branch or URL and it goes back to being fetched from GitHub and cached for 24h, which is how a skill author evaluates a change before it is merged. Repos are restricted to `github.com/galaxyproject/*` either way.

**`galaxyproject/galaxy-skills` is the default** — when no skills are configured, Orbit seeds it on first read. It covers:

- **Collection manipulation** (paired collections from PE FASTQ, mapping a tool over a collection, Apply Rules DSL, Galaxy Tools API patterns)
- **Galaxy MCP usage and gotchas**
- **Workflow report templates**
- **Nextflow → Galaxy conversion**
- **Galaxy tool development**
- **Updating ToolShed tool revisions**

Orbit also carries a few **staging skills** under `skills_fetch({ repo: "orbit" })`, listed in the system prompt beside galaxy-skills. They are temporary: each is a skill Orbit needed before it had a proper home, lives in [`skills/`](skills/) while it is tried with Orbit's users, and names in its frontmatter where it should move (usually galaxy-skills, via agentic-plugins). If you maintain that home, these are open invitations. The first is **galaxy-data-libraries**: browsing a Galaxy data library and running tools on its datasets in place instead of copying them into a history.

Add your own repos in **Preferences → Skills**. Each entry is `{ name, url, branch?, enabled? }`. The URL allowlist is `https://github.com/galaxyproject/*` (the agent treats fetched SKILL.md content as authoritative instructions, so arbitrary repos are a prompt-injection vector). Example:

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

Loosening the allowlist means editing `ALLOWED_SKILLS_PREFIX` in `shared/orbit-config.js`. Plan: a per-repo signing / pinning model before opening this up.

Fetched files cache to `~/.orbit/cache/skills/<repo-name>/<path>` with a 24-hour TTL -- covers offline use and reduces network round-trips on repeated reads.

## Install

Three paths, depending on what you want.

### Desktop app (Orbit)

Orbit ships as a native build that bundles its own Node runtime, `uv`, and the Orbit core -- no separate prerequisites. The macOS builds are Developer ID signed + notarized for both Apple Silicon and Intel, so they open with a normal double-click; Linux ships `.deb`/`.rpm`/`.zip` for x64 and arm64; Windows ships a portable `Orbit-win32-x64-<version>.zip` (remote-only -- no local bash shell, and no installer yet). All builds are attached to each [release](https://github.com/galaxyproject/orbit/releases). See [INSTALL.md](INSTALL.md) for per-platform steps and [RELEASING.md](RELEASING.md) for how a release is cut. Targets we don't package can use the developer install below.

### Orbit CLI from npm

Run the brain on the command line without Orbit. Requires Node 22.19+. The Galaxy tools run in-process, so Galaxy needs nothing else; [uv](https://docs.astral.sh/uv/) is optional: only the vendored planemo skills' `uvx` route uses it.

```bash
npm install -g @galaxyproject/orbit
orbit
```

Or run without installing:

```bash
npx @galaxyproject/orbit
```

**Pop into Orbit any time.** Once Orbit is installed, type `/desktop` inside
the Orbit CLI to open the current analysis in the desktop app -- same analysis
directory, same notebook, just a richer view. Orbit opens on that directory;
close the CLI (Ctrl-D or `/exit`) once it's up so the two don't both write the
same notebook. If Orbit isn't installed, `/desktop` will point you at the release
page.

If you'll use the vendored planemo skills, they can run planemo through `uv`
(a pip-installed planemo works too); Galaxy itself needs nothing extra:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### Developer install (build from source)

Clone the repo and install both workspaces -- there is no build step, so this is
the whole setup:

```bash
git clone https://github.com/galaxyproject/orbit.git
cd orbit
npm install
cd app && npm install
```

Then `npm start` from `app/` for Orbit, or `node bin/orbit.js` from the repo root
for the CLI. Needs Node 22.19+ (matching [`.nvmrc`](.nvmrc)); `uv` on `PATH` only for the planemo skills' `uvx` route.

[**CONTRIBUTING.md**](CONTRIBUTING.md) has the rest: per-OS bootstrap, the
browser dev shell with hot reload, the test/typecheck loop, repo layout, and how
to validate a change beyond "the tests pass". Windows developers wanting local
execution should work inside WSL2 -- `curl -fsSL
https://raw.githubusercontent.com/galaxyproject/orbit/main/scripts/setup-wsl.sh | bash`.

### After installation

In Orbit, on first launch, the welcome screen asks for an LLM provider + key and (optionally) a Galaxy server. You can also click **Skip — set up later** and configure things from Preferences when you're ready. You need at least one of: [Anthropic](https://console.anthropic.com/), [OpenAI](https://platform.openai.com/), or [Google AI](https://aistudio.google.com/). Local providers like [Ollama](https://ollama.com/) and LiteLLM work too.

In `orbit`, the equivalent is editing `~/.orbit/config.json` (see [Configuration](#configuration)) or running `orbit --provider anthropic` and following the OAuth prompts.

## Usage

### CLI (`orbit`)

```bash
orbit
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
$ orbit

Pi:  Loaded notebook: HeLa Drug Treatment RNA-seq DE
     Plan A is in progress (1 of 4 steps complete).

     The fastp invocation finished successfully. HISAT2 alignment is queued.
     Should I check_all to advance, or do you want to review the QC report first?
```

You can also load just the extension into Pi directly:

```bash
pi --no-extensions -e ./extensions/orbit
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

- `Cmd/Ctrl+Shift+M` — start or finish local English dictation. You can also
  click the microphone beside the prompt. Speech fills the editable draft;
  review it and press Send. `Esc` cancels recording or transcription. Desktop
  packages include Whisper Base English and work offline for transcription.
- `Cmd/Ctrl+\` — collapse / expand the artifact pane
- `Cmd/Ctrl+B` — collapse / expand the file tree
- `Cmd/Ctrl+,` — open Preferences
- `Cmd/Ctrl+O` — switch working directory and restart into a fresh agent session for that directory
- `↑` / `↓` in the chat input — recall previous prompts
- `/` — open the slash-command autocomplete
- `Esc` — dismiss modal prompts; close slash popup; cancel mid-response

## Configuration

Orbit uses a single brain-level config at `~/.orbit/config.json`. Every consumer (the `orbit` CLI, the desktop app, any future shell) reads and writes it:

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

All sections are optional. If `llm` is missing, consumers fall back to environment variables or OAuth login. If `galaxy` is missing, use `/connect` to add a server interactively -- credentials save to the config automatically. The Galaxy tools are always registered and use those credentials; the agent decides per-plan whether to use Galaxy. If `skills` is missing or empty, `galaxy-skills` is lazy-seeded.

#### Galaxy credential storage

Galaxy profiles are stored in `~/.orbit/config.json` under `galaxy.profiles.<name>`. The exact field depends on which shell wrote them:

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

An exported `GALAXY_URL` + `GALAXY_API_KEY` pair wins over the saved profile in `~/.orbit/config.json`, so one env prefix points the CLI at any Galaxy; setting only one of the two is ignored with a warning. The desktop app prefers the profile picked in its UI.

#### Beta tester ID

If you have a tester ID, you can set it like this:

```
/tester-id orbit-007
```

Run `/tester-id` with no argument to see the current value. It writes only the `testerId` key to `~/.orbit/config.json` (the rest of the file is left untouched), and Orbit attaches it to any feedback you send so reports can be traced back to your session. It can also be supplied via the `ORBIT_TESTER_ID` environment variable.

#### Lessons

Lessons are short recorded notes on situations that go wrong -- a filter that
counts NA as zero, a reference index that was never registered -- shipped with
Orbit and added to locally. The whole loop is off until you turn it on. On, a
lesson is surfaced in chat when a tool result or plan step matches it, the
agent can search them, `/lesson` lets you record one from the session (it stays
on this machine until you say otherwise), and failure reports follow the
`/observations` mode below. Off, nothing recorded is surfaced or searchable,
`/lesson` is off, and no report is collected or sent.

```
/lessons          # on or off, and what that covers
/lessons on       # asks you to confirm once, then turns the loop on
/lessons off      # turns the whole loop off
```

`ORBIT_LESSONS=off` in the environment keeps it off for a managed install and
cannot be overridden from the app.

#### Sharing Galaxy failure patterns

When a Galaxy tool fails, or the same step fails three times in a row, Orbit
can report the _shape_ of it -- which tool, which stage, which datatypes, and,
in `ask` mode, a normalized one-line signature -- to the Galaxy team's private
intake queue. Those reports are how a problem one person hits becomes a lesson
Orbit surfaces for the next person who hits it (you included), and how the team
finds what to fix upstream. Nothing goes without your say-so: reporting is off
until lessons are on and you pick a mode, and `ask` shows you the exact payload
after a turn that hit a Galaxy error and sends only if you confirm.

```
/observations               # mode, counts, and where the local log lives
/observations mode ask      # show me the payload and ask, every time
/observations mode auto     # send without asking, structured fields only
/observations mode off      # collect nothing (default)
/observations sent          # everything this install has sent
/observations retract <id>  # delete a sent row, or cancel one still queued
/observe <note>             # report something yourself
```

In `ask` mode the signature and your optional description are shown to you in
full and sent only if you say yes. In `auto` mode no free text is sent at all:
no error text and no description, only the structured fields (tool, stage,
datatypes, server, client). `/observe` is the one exception -- it always asks
first and shows your note, whatever the mode. Every field is checked before it
leaves the machine: the Galaxy tool name, Galaxy's own tool ids and the datatypes
against lists generated from galaxy-ops and Galaxy releases (a toolshed tool's
owner and repository can only be shape-checked), and the error line in
stages: URLs and email addresses are replaced first, then the line is checked
for hosts, ports, network addresses, UUIDs and the like before paths, ids and
long numbers are rewritten (so a rewrite can't hide one), then the rewritten
line is checked again in full. Common errors come out scrubbed (`Dataset <id>
not found`, `No such file: <path>`). If the line still looks like it carries a
host, address, path or id, the error text is withheld and you are offered the
rest of the report, with a one-line reason. No pattern catches every name,
which is why only `ask`, where you read it first, sends text. The server is recorded as its
public name (`usegalaxy.org`, `usegalaxy.eu`, ...) or as the literal `private`
for anything else -- an institutional mirror is never named. Rows are tied to a
random per-install token, not to your account, and expire after 180 days.

Switching to `auto` shows you a real sample payload first, and `auto` only
takes effect once you have confirmed that sample: a config that says `auto`
without the recorded confirmation (hand-edited, say) runs as `ask`, and
`/observations status` says so. For a managed
deployment, `ORBIT_OBSERVATIONS=off` (or `ORBIT_OBSERVATIONS=off`) disables the
whole thing and cannot be overridden from the app. For local development,
`ORBIT_OBSERVATIONS_URL` points the client at another intake; it is honoured
only as `http://localhost[:port]`, `http://127.0.0.1[:port]` or an `https://`
URL, and ignored with a warning otherwise.

### Custom endpoints (local LLMs, gateways, proxies)

Orbit works with any OpenAI-compatible API -- a hosted service like [Jetstream](https://docs.jetstream-cloud.org/inference-service/overview/), or a local backend like [LiteLLM](https://litellm.ai/) or [Ollama](https://ollama.com/) -- and with Anthropic-compatible gateways that front the Messages API, such as an institutional proxy or LiteLLM in anthropic mode.

In **Orbit**, open Preferences, set the provider to **OpenAI-compatible endpoint**, pick the **API shape**, enter the base URL + API key (or click the **Jetstream** preset), and choose a model. The key is stored encrypted.

For the **CLI**, add a provider entry with a `baseUrl` to `~/.orbit/config.json`:

```json
{
  "llm": {
    "active": "openai-compatible",
    "providers": {
      "openai-compatible": {
        "baseUrl": "http://localhost:4000/v1",
        "model": "your-model-name",
        "apiKey": "your-key"
      }
    }
  }
}
```

The `baseUrl` marks the entry as a custom endpoint: Orbit registers it with Pi for you (writing the matching `~/.pi/agent/models.json` entry, with sensible metadata defaults) and passes the key to Pi at runtime, so the key never lands in `models.json`. The provider name is yours to choose -- `"openai-compatible"` is just a convention.

An optional `api` field picks the wire format. It defaults to `openai-completions`, so existing entries need no change; set it to `anthropic-messages` for a gateway that speaks the Anthropic Messages API:

```json
{
  "llm": {
    "active": "argo",
    "providers": {
      "argo": {
        "baseUrl": "https://gateway.example/argoapi",
        "api": "anthropic-messages",
        "model": "claudeopus5",
        "apiKey": "your-key"
      }
    }
  }
}
```

**The two shapes want different base URLs**, because their clients append different paths. An `openai-completions` URL includes the version segment (`https://host/v1`); an `anthropic-messages` URL stops at the host (`https://host`) because the client adds `/v1/messages` itself. A `/v1` in the wrong place is a 404 against a URL that looks correct.

### Standing instructions (`ORBIT.md`)

Preferences you'd otherwise repeat every session belong in a `ORBIT.md` file,
which Orbit loads into every conversation:

```
Always end an analysis with a visualization.
Prefer IWC workflows over hand-assembled tool chains.
Use HISAT2 for RNA-seq alignment, not bowtie.
```

Orbit reads two places:

- `~/.pi/agent/ORBIT.md` -- yours, applied to every session. Run
  `/instructions init` to create it.
- `ORBIT.md` in your project directory, or any directory above it -- applied to
  work in that directory. `/instructions init project` creates one.

Run `/instructions` to see exactly which files loaded, which is the fastest way
to answer "why isn't it doing what I told it."

The two are not equally trusted, on purpose. Your global file is your own voice
and goes into the system prompt. A project file travels with the folder -- a
cloned repo, a shared drive, something a collaborator sent you -- so it is
supplied as reference material instead: it can steer tool choice and output
conventions, but it cannot grant permissions, skip a confirmation prompt, or
override anything Orbit was told at startup.

Files are capped at 8KB or 200 lines and at eight files total; anything past
that is dropped, and `/instructions` tells you when it happened. Edits take
effect on your next message -- no restart.

## Local execution safety

Orbit drives a real coding agent: alongside the Galaxy tools, the model has `bash`, `write`, `edit`, and `read` on your machine. That's the point -- local analysis needs it -- but it means a misreading model, or one that's been prompt-injected by untrusted content (a Galaxy dataset, tool output, a fetched page), could run something destructive as you. This risk is higher with cheaper, less-capable models, which Orbit lets you pick to save money.

So Orbit gates the model's local actions by default (the "exec-guard"):

- **Workspace jail.** Reads, writes, and edits inside your analysis directory (plus the OS temp dir) are silent; anything that resolves outside -- including via `..`, a symlink, or `~`/`$HOME` -- prompts, or is denied for weak models. So the model reads and writes freely in your project but must ask to reach anything else on disk. Writes to control locations (`.git`, `.loom/`) always prompt, even inside the workspace -- a `.git/hooks` script would run on your next commit.
- **Risk-classified `bash`.** Read-only/analysis commands (`ls`, `cat`, `grep`, ...) run without friction when they stay in the workspace. Catastrophic patterns (`rm -rf /`, `sudo`, `curl | sh`, `dd of=/dev/...`, fork bombs, ...) are always blocked -- including path-prefixed (`/usr/bin/sudo`), long-flag (`rm --recursive --force /`), wrapper-hidden (`env rm -rf ~`), explicit-home (`rm -rf $HOME`), and multi-line variants, plus any attempt to edit the gate's own config. Anything else prompts -- and any compound, redirected, or multi-line command (`;`, `&&`, `|`, `$(...)`, `>`, a newline) drops to a prompt rather than being trusted.
- **Sensitive paths.** `~/.ssh`, `~/.aws`, `.env`, `*.pem`/`*.key`, `~/.orbit/config.json`, OS keychains, and similar always prompt (or are denied for weak models) even inside the workspace -- whether the model uses `read`, `grep`, `ls`, `find`, or a `cat` in `bash`.
- **Model-tier aware.** Every model is gated. Weaker models (Haiku / GPT-4o-mini / Flash class, or unknown / local / low-cost models) get stricter defaults: a sensitive path or anything resolving outside the workspace is denied outright rather than offered for approval, and they never earn the silent auto-allow a capable model gets in a trusted workspace. An ordinary unrecognized command, though -- running a script it just wrote, or a compound/redirected command -- still drops to the _same_ approval prompt a capable model would get, so scripting in explicit local mode works once you approve it. (Headless/scripted runs have no one to approve, so anything that would prompt is denied there for every tier.)
- **Fail-closed.** With no interactive session to approve (headless / scripted runs), anything that would prompt is denied. A one-time consent notice is shown on the first gated action, and every decision is recorded in `activity.jsonl`.

When a command needs approval you can allow it once, allow it for the session, or trust the workspace (which stops prompting for routine commands there).

### Bypassing the gate

If you fully control the environment and want the agent to run unattended (CI, a trusted pipeline, your own box), you can turn the gate off:

- **Config:** set `"guardian": { "dangerouslyBypassPermissions": true }` in `~/.orbit/config.json`.
- **CLI:** `orbit --dangerously-bypass-permissions` (one invocation; does not persist). `--safe` (or `ORBIT_SAFE=1`) forces the gate back on and wins over everything.
- **Orbit:** Preferences -> Safety -> "Dangerously bypass permissions" (a native confirm appears first; a red banner stays up while it's active).

Bypass is total -- it removes all prompts and the workspace jail. It can only be enabled by a human through one of those channels: the agent can't turn it on itself, because writing `~/.orbit/config.json` is blocked whether it uses the file tools or `bash`, and Orbit's toggle requires an OS-level confirmation the renderer can't forge. The default (`guardian.enabled: true`, not bypassed) is secure; relaxing it is always an explicit choice.

### What the write-jail actually confines -- and what it doesn't

To be precise about the boundary: the workspace jail (default-on, every platform) confines the AI's file writes via the `write` and `edit` tools. Those tools can create or modify files inside your analysis directory (where `notebook.md` lives), plus the OS temp dir and Orbit's own `.loom` state; writing anywhere else, or to a credential-shaped path (private keys like `id_rsa`/`id_ed25519`, `*.pem`, `*.key`, `.env`, and `ssh`/`aws`/`gcloud`/`kube`/`docker`/keychain dirs), prompts for approval.

Shell (`bash`) commands are **not** OS-sandboxed by default -- they're gated per action by the same approval flow (catastrophic patterns blocked outright, everything else prompts), but a bash command that writes a file or touches the network doesn't go through the write-jail path. To also confine bash writes and limit its network access inside a real OS sandbox, enable the opt-in bash sandbox (`--sandbox` / `ORBIT_SANDBOX=1` / `guardian.sandbox`), available on macOS and Linux/WSL2.

What this does **not** confine: reading files (the write-jail is not an exfiltration control), and data leaving via remote channels -- syncing the notebook to a Galaxy Page, Galaxy tool operations (uploads, running tools), `skills_fetch`'s cache writes under `~/.orbit`, or web fetches. Treat the working-dir confinement as "the AI's edits stay in your analysis directory," not "your data cannot leave the machine."

## Cost tracking

Orbit's footer shows live in-flight cost for the active session (computed from `usage.cost` returned per stream event by pi-ai). For accurate **historical / per-project / per-model** reporting across all your sessions, run [CodeBurn](https://github.com/getagentseal/codeburn) in a separate terminal:

```bash
npx codeburn          # interactive TUI dashboard
npx codeburn today    # today's spend
npx codeburn month    # this month
npx codeburn status   # one-liner: today + month totals
```

CodeBurn auto-detects Orbit/Pi sessions under `~/.pi/agent/sessions/` (Pi is a first-class supported provider — no configuration needed) and pulls model pricing from LiteLLM's catalog, so newly-released models work without an Orbit update. Each Orbit project (= cwd) shows up as a separate row, so you can see what each analysis cost. CSV / JSON export is built in.

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
| `/instructions`           | Show the `ORBIT.md` standing instructions loaded this session                      |
| `/summarize [N [M]]`      | Append a summary of prompts N..M into the notebook                                 |
| `/cost`                   | Append the session token/cost breakdown to the notebook                            |
| `/connect [name]`         | Open Galaxy connection settings (or switch to an existing profile)                 |
| `/profiles`               | List saved Galaxy server profiles                                                  |
| `/execute` (alias `/run`) | Tell the agent to advance the next pending step in the latest plan section         |
| `/override <step> <why>`  | Clear the evidence gate for one plan step, once, with a recorded reason            |
| `/pending`                | List Galaxy run proposals waiting for approval                                     |
| `/approve <proposal-id>`  | Approve a proposed run: freeze it against Galaxy's template and record it          |
| `/revoke <proposal-id>`   | Withdraw an approval                                                               |
| `/help`                   | Show this list                                                                     |

## Tool reference

Orbit registers a small set of extension tools. Plans, decisions, results, and interpretation all live as markdown sections in `notebook.md` — the agent maintains them via the standard `Edit`/`Write` tools.

| Category                       | Tools                                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GTN tutorials**              | `gtn_search`, `gtn_fetch`                                                                                                                           |
| **Galaxy invocations**         | `galaxy_invocation_record`, `galaxy_invocation_check_all`, `galaxy_invocation_check_one`                                                            |
| **Galaxy run proposals**       | `loom_propose` (you approve with `/approve`)                                                                                                        |
| **Skills**                     | `skills_fetch` (SKILL.md / reference docs; `repo: "orbit"` reads staging skills awaiting a permanent home, `repo: "foundry"` bundled Foundry casts) |
| **Multi-agent (experimental)** | `team_dispatch` (gated by `ORBIT_TEAM_DISPATCH=1`)                                                                                                  |

The Galaxy tools run in-process through [galaxy-ops](https://github.com/galaxyproject/galaxy-mcp) under the operations' own names: `search_tools_by_name`, `run_tool`, `invoke_workflow`, `search_iwc_workflows`, `recommend_iwc_workflows`, `import_workflow_from_iwc`, user-defined tool lifecycle (`create_user_tool`, `list_user_tools`, `run_user_tool`, `delete_user_tool`), history/dataset operations, and more. There is no connect step: `/connect` stores the credentials they use.

## Tech stack

| Component    | Technology                                            |
| ------------ | ----------------------------------------------------- |
| Agent        | Pi.dev (`@earendil-works/pi-coding-agent`)            |
| Galaxy tools | `@galaxyproject/galaxy-ops`, in-process               |
| MCP bridge   | pi built-in MCP (brc-analytics)                       |
| Language     | TypeScript (strict)                                   |
| Tests        | Vitest                                                |
| Desktop      | Electron 35                                           |
| Build        | Vite + electron-forge                                 |
| Markdown     | `marked`                                              |
| Fonts        | Inter (body), JetBrains Mono (code)                   |
| Theme        | Galaxy brand dark (`#2c3143` + gold accent `#ffd700`) |

## Terminal-only validation

For non-Electron validation:

```bash
npm run typecheck
npm test
pi --no-extensions -e ./extensions/orbit
```

Then validate the wrapper in a plain working directory:

```bash
mkdir -p /tmp/loom-cli-validation
cd /tmp/loom-cli-validation
node /path/to/orbit/bin/orbit.js --provider anthropic --model claude-sonnet-4-6
```

For a full terminal-only runbook, see [docs/terminal-validation.md](docs/terminal-validation.md).

## Related projects

- [Galaxy](https://galaxyproject.org) — open-source platform for data-intensive biomedical research
- [galaxy-mcp](https://github.com/galaxyproject/galaxy-mcp) — MCP server for the Galaxy API, and home of galaxy-ops, the operations Orbit runs in-process
- [galaxy-skills](https://github.com/galaxyproject/galaxy-skills) — curated operational skills, bundled with Orbit at a pinned commit
- [agentic-plugins](https://github.com/galaxyproject/agentic-plugins) — the pinned source Orbit vendors its skill content from
- [Pi coding agent](https://github.com/badlogic/pi-mono) — the Pi.dev agent framework
- [CodeBurn](https://github.com/getagentseal/codeburn) — TUI dashboard for AI-coding cost observability (Pi is a first-class provider)

## License

MIT
