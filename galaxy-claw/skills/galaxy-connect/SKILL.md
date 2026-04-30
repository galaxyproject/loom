---
name: galaxy-connect
description: "Connect to a Galaxy bioinformatics server via galaxy-mcp -- authenticate and configure for NemoClaw"
version: 0.3.0
author: Galaxy Project
license: MIT
tags: [galaxy, authentication, bioinformatics, mcp, nemoclaw]
metadata:
  openclaw:
    requires:
      bins:
        - uvx
      env:
        - GALAXY_URL
        - GALAXY_API_KEY
    primaryEnv: GALAXY_API_KEY
    emoji: "🔗"
    trigger_keywords:
      - connect to galaxy
      - galaxy login
      - galaxy server
      - galaxy api key
      - usegalaxy
---

# Galaxy Connect

Connect and authenticate with any Galaxy bioinformatics server using **galaxy-mcp**.

## Prerequisites

1. **galaxy-mcp installed**: `pip install galaxy-mcp` or `uvx galaxy-mcp`
2. **Galaxy account with API key**: Galaxy > User > Preferences > Manage API Key
3. **NemoClaw network policy**: Galaxy server must be in the OpenShell allow list (see `openclaw-sandbox.yaml` in the galaxy-claw root)

## Configuration

Set environment variables:

```bash
export GALAXY_URL=https://usegalaxy.org
export GALAXY_API_KEY=your-api-key-here
```

The galaxy-mcp MCP server must be registered in your agent config:

```json
{
  "mcpServers": {
    "galaxy": {
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

## Verify Connection

Call the galaxy-mcp `get_server_info` tool. This returns the Galaxy version, brand, and authenticated user info. If this fails:

- **"Invalid API key"** -- regenerate at Galaxy > User > Preferences > Manage API Key
- **Connection timeout** -- check the OpenShell network policy allows your Galaxy server's hostname on port 443
- **"galaxy-mcp not found"** -- install with `pip install galaxy-mcp`

## Common Servers

| Server               | URL                        | Notes                                    |
| -------------------- | -------------------------- | ---------------------------------------- |
| **usegalaxy.org**    | `https://usegalaxy.org`    | Main US server, largest tool collection  |
| **usegalaxy.eu**     | `https://usegalaxy.eu`     | European server, strong training support |
| **usegalaxy.org.au** | `https://usegalaxy.org.au` | Australian server, supports OAuth        |

## After Connecting

The agent has access to Galaxy's full API via MCP tools. Use the other galaxy-claw skills for specific tasks:

- `galaxy-tools` -- search and run tools
- `galaxy-history` -- manage histories and datasets
- `galaxy-workflow` -- run workflows
- `galaxy-rnaseq`, `galaxy-variant`, `galaxy-metagenomics` -- guided pipelines
