---
title: Galaxy MCP
description: Connect Claude Desktop, Orbit, or any MCP client to a Galaxy instance for real, reproducible compute.
group: Guides
order: 3
---

# Galaxy MCP

Galaxy MCP is a [Model Context Protocol](https://modelcontextprotocol.io) server
that connects any MCP-capable AI assistant — Claude Desktop, Orbit/Loom, and
others — to a Galaxy bioinformatics instance. Point it at any Galaxy server with a
URL and API key, and the agent can search and run tools, drive workflows, and
manage histories and datasets through Galaxy's API (via
[BioBlend](https://bioblend.readthedocs.io)).

It is the bridge that lets a conversational agent do real, reproducible compute on
Galaxy instead of just talking about it.

## Capabilities

- **Connect** to any Galaxy instance (URL + API key), with optional browser-based
  **OAuth** that mints short-lived keys per session.
- **Tools** — search the catalog, view tool details, execute tools.
- **Workflows** — access and import from the Interactive Workflow Composer (IWC).
- **Histories & datasets** — create, inspect, and manage.
- **File upload** from local storage into Galaxy.
- Ships **stdio** (local) and **streamable-HTTP** (remote / multi-user) transports.

## Quick start

Run the stdio server directly with [`uv`](https://docs.astral.sh/uv/):

```bash
uvx galaxy-mcp
```

It reads `GALAXY_URL` and `GALAXY_API_KEY` from the environment. You can also
install from PyPI (`pip install galaxy-mcp`) or run the
`galaxyproject/galaxy-mcp` Docker image.

## Connect Claude Desktop

Add Galaxy MCP to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "galaxy-mcp": {
      "command": "uvx",
      "args": ["galaxy-mcp"],
      "env": {
        "GALAXY_URL": "https://usegalaxy.org",
        "GALAXY_API_KEY": "your-api-key"
      }
    }
  }
}
```

Restart Claude Desktop and the Galaxy tools become available in the conversation.

## With Orbit and Loom

Orbit and the Loom CLI use Galaxy MCP under the hood — when you connect Galaxy in
Orbit, or set `GALAXY_URL` / `GALAXY_API_KEY` for the CLI, the agent routes work
through `uvx galaxy-mcp` automatically. See [Getting started](/loom/docs/getting-started).

The source lives at
[`galaxyproject/galaxy-mcp`](https://github.com/galaxyproject/galaxy-mcp).
