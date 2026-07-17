---
title: Architecture
description: One agent brain, many shells — how Loom, Orbit, the web shell, and Galaxy fit together.
group: Reference
order: 4
---

# Architecture

Loom is an AI research harness for [Galaxy](https://galaxyproject.org)
bioinformatics, built on [Pi.dev](https://pi.dev). It is deliberately split into a
single **brain** and several thin **shells** that talk to it over RPC.

## Brain and shells

```
Brain (Loom)                        Shells
────────────                        ──────
extensions/loom/                    bin/loom.js      terminal CLI
  index.ts    extension entry       app/             Orbit (Electron desktop)
  state.ts    session state           src/main/        Node.js main process
  tools.ts    LLM-callable tools       src/renderer/    chat + artifact panes
  context.ts  system prompt          web/             browser shell (LAN, dev)
  notebook-writer.ts  notebook I/O
```

**Loom** is the agent brain — the Pi.dev runtime, the system-prompt context,
Galaxy invocation tracking, the skills system, and the RPC contract.

**Orbit** is the Electron desktop shell with a chat + tabbed-artifact layout.
The **CLI** runs the same brain from a terminal. A **web shell** serves the Orbit
renderer over RPC from another device on your LAN. Future shells — a
Galaxy-embedded web UI, a hosted server mode — talk to the same brain over the
same contract.

## The notebook is the state

The durable state is `notebook.md`. Plans, decisions, results, and interpretation
all live as markdown sections inside it; the agent maintains them via standard
`Edit` / `Write` tools. The only structured side-records are `loom-invocation`
YAML blocks for in-flight Galaxy work. See [Concepts](/loom/docs/concepts).

This keeps Loom aligned with the broader Galaxy ecosystem: **Galaxy is the
substrate, Page is the shareable artifact, and Loom is one live authoring shell.**

## Galaxy integration

Galaxy work runs through [Galaxy MCP](/loom/docs/galaxy-mcp) (`uvx galaxy-mcp`)
when credentials are available. During planning the agent surveys the workflow
registry and tool catalog, then routes each step to Galaxy or local execution as
appropriate.

## Tech stack

Built in strict **TypeScript** on the **Pi.dev** agent runtime
(`@earendil-works/pi-coding-agent`), bridged to Galaxy through `uvx galaxy-mcp`.
The Orbit desktop shell is **Electron** (Vite + electron-forge), rendered with
`marked`, in a Galaxy-brand dark theme. Tested with Vitest.

> For the engineer-facing deep dive, see
> [`docs/architecture.md`](https://github.com/galaxyproject/loom/blob/main/docs/architecture.md)
> in the loom repository.
