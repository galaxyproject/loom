---
title: Getting started
description: Install Orbit or the Loom CLI, connect Galaxy, and run your first agentic analysis.
group: Guides
order: 1
---

# Getting started

Orbit and Loom turn a working directory into a co-scientist project. You chat with
an agent; it plans, runs work on Galaxy or locally, and records everything in a
durable `notebook.md`. This page gets you from zero to your first analysis.

## 1. Install

Pick whichever shell you prefer — they run the same brain.

### Orbit (desktop app)

Download a signed, notarized installer from the
[Releases page](https://github.com/galaxyproject/loom/releases). Each installer
bundles its own Node, `uv`, and Loom, so there is nothing else to set up.

- **macOS** — open the `.dmg` and drag Orbit to Applications.
- **Linux** — install the `.deb` (`sudo dpkg -i orbit_*_amd64.deb && sudo apt-get install -f`) or `.rpm`, then run `orbit`.
- **Windows** — run the `Setup.exe` (remote-only build).

### Loom (CLI)

The CLI needs Node 22.19+ and, for Galaxy MCP, [`uv`](https://docs.astral.sh/uv/).

```bash
npm install -g @galaxyproject/loom
loom
```

Or run it once without installing:

```bash
npx @galaxyproject/loom
```

## 2. Connect Galaxy

With Galaxy connected, the agent can survey the workflow registry and tool
catalog while drafting plans, and route individual steps to Galaxy. Provide a
Galaxy server URL and an API key (Orbit stores credentials in your OS keychain;
the CLI reads `GALAXY_URL` / `GALAXY_API_KEY`).

Galaxy access flows through [Galaxy MCP](/loom/docs/galaxy-mcp) — the bridge that
lets any agent search and run tools, drive workflows, and manage histories.

> Galaxy work is optional. Loom is useful for local exploration and planning even
> before you connect a server.

## 3. Run your first analysis

1. **Open a directory.** Start Orbit (or run `loom`) in an analysis folder. A
   `notebook.md` is created on first launch and committed to git.
2. **Chat.** Ask questions, drop file paths, request data lookups. None of this
   requires a "plan" — the conversation is just a conversation.
3. **Ask for a plan.** The agent drafts it *in chat* as a markdown section and
   waits for your approval. Then it shows you the parameters and waits again.
4. **Watch it run.** Once approved, the plan is written into `notebook.md` and
   executed. Galaxy steps are tracked with live `loom-invocation` blocks; the
   Activity tab streams tool calls and job status.
5. **Come back tomorrow.** Open the same directory and the notebook is the
   project. Sessions resume automatically.

## Where the record lives

Everything the agent decides and does is written to `notebook.md` as plain
markdown, and auto-committed to git. There is no parallel hidden state store — the
notebook is the durable working record, and Galaxy histories remain the
computational truth. See [Concepts](/loom/docs/concepts) for the full model.
