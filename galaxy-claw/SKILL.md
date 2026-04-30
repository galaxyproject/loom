---
name: galaxy-claw
description: "Deep Galaxy bioinformatics integration via galaxy-mcp -- connect to any Galaxy server, search/run 8,000+ tools, manage histories and workflows, with guided domain pipelines for RNA-seq, variant calling, and metagenomics"
version: 0.3.0
author: Galaxy Project
license: MIT
tags: [galaxy, bioinformatics, genomics, workflows, reproducibility, nemoclaw, mcp]
metadata:
  openclaw:
    requires:
      bins:
        - python3
      env:
        - GALAXY_URL
        - GALAXY_API_KEY
    primaryEnv: GALAXY_API_KEY
    emoji: "🌌"
    homepage: https://github.com/galaxyproject/galaxy-claw
    os: [darwin, linux]
    install:
      - kind: pip
        package: galaxy-mcp
        bins: []
    trigger_keywords:
      - galaxy
      - bioinformatics
      - genomics
      - rna-seq
      - variant calling
      - metagenomics
      - usegalaxy
---

# GalaxyClaw -- Galaxy for NemoClaw

**Deep integration with Galaxy bioinformatics servers via galaxy-mcp.** Full history management, workflow execution, dataset lineage, and guided analysis pipelines -- all running inside NemoClaw's secure OpenShell sandbox.

## Architecture

```
  NemoClaw (OpenShell sandbox)
       │
       │  SKILL.md loaded at session start
       │
       ▼
  Agent (reads domain knowledge from skills)
       │
       │  MCP tool calls
       │
       ▼
  galaxy-mcp (MCP server)
       │
       │  Galaxy API (HTTPS)
       │
       ▼
  Galaxy Server (usegalaxy.org, etc.)
       │
       ▼
  8,000+ tools, histories, workflows, provenance
```

## Sub-Skills

| Skill                 | Purpose                                  |
| --------------------- | ---------------------------------------- |
| `galaxy-connect`      | Configure galaxy-mcp and authenticate    |
| `galaxy-tools`        | Search, inspect, and run any Galaxy tool |
| `galaxy-history`      | Manage histories and datasets            |
| `galaxy-workflow`     | Import and run Galaxy workflows          |
| `galaxy-rnaseq`       | Guided RNA-seq DE pipeline               |
| `galaxy-variant`      | Guided variant calling pipeline          |
| `galaxy-metagenomics` | Guided metagenomics profiling            |

## Install

```bash
# Via ClawHub (recommended)
clawhub install galaxyproject/galaxy-claw

# Or manually
git clone https://github.com/galaxyproject/galaxy-claw.git
cp -r galaxy-claw/skills/* ~/.openclaw/skills/
```

## NemoClaw Setup

### 1. Install galaxy-mcp

```bash
pip install galaxy-mcp
```

### 2. Set Galaxy credentials

```bash
export GALAXY_URL=https://usegalaxy.org
export GALAXY_API_KEY=your-api-key-here
```

### 3. Configure OpenShell network policy

Galaxy-mcp needs HTTPS access to your Galaxy server. Add to your `openclaw-sandbox.yaml`:

```yaml
network:
  allow:
    - "usegalaxy.org:443"
    - "usegalaxy.eu:443"
    # Add your institutional Galaxy server here
    # - "galaxy.myuniversity.edu:443"
```

### 4. Configure MCP server

Add galaxy-mcp to your agent config:

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

### 5. Go

```
> Connect to Galaxy and help me run FastQC on my sequencing reads
```

## Why Galaxy + NemoClaw?

- **8,000+ tools** maintained by a global community
- **Full provenance** -- every parameter and input tracked automatically
- **Server-side compute** -- tools run on Galaxy, not your machine
- **Sandbox security** -- OpenShell restricts agent to Galaxy network access only
- **Privacy** -- genomic data goes to your Galaxy server, never to LLM providers
- **No static catalogs** -- galaxy-mcp searches the live tool panel dynamically
