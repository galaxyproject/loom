# GalaxyClaw

**Deep Galaxy bioinformatics integration for NemoClaw.**

GalaxyClaw gives AI agents access to Galaxy's 8,000+ bioinformatics tools via [galaxy-mcp](https://github.com/galaxyproject/galaxy-mcp). The agent searches and runs tools dynamically -- no static catalogs. Every analysis is automatically reproducible through Galaxy's built-in provenance tracking.

## Architecture

GalaxyClaw is **pure SKILL.md** -- domain expertise that teaches the agent how to use galaxy-mcp effectively. No wrapper scripts, no duplicated API logic.

```
  NemoClaw (OpenShell sandbox)
       │
       │  SKILL.md for domain knowledge
       │
       ▼
  galaxy-mcp (MCP server)
       │
       │  Galaxy API (HTTPS)
       │
       ▼
  Galaxy Server (8,000+ tools, histories, workflows)
```

The SKILL.md files carry:

- Which tools to use for which tasks
- Parameter selection rationale (why Q20, why DP>10)
- QC checkpoints and what to look for
- Decision points and common failure modes

## Install

```bash
# Via ClawHub
clawhub install galaxyproject/galaxy-claw

# Or manually
cp -r skills/* ~/.openclaw/skills/
```

## NemoClaw Setup

### 1. Dependencies

```bash
pip install galaxy-mcp
```

### 2. Galaxy credentials

Get an API key from Galaxy > User > Preferences > Manage API Key.

```bash
export GALAXY_URL=https://usegalaxy.org
export GALAXY_API_KEY=your-key
```

### 3. OpenShell network policy

galaxy-mcp needs HTTPS access to your Galaxy server. Merge the provided `openclaw-sandbox.yaml` into your sandbox config, or add your Galaxy server to the network allow list:

```yaml
network:
  allow:
    - "usegalaxy.org:443"
```

### 4. MCP server config

```json
{
  "mcpServers": {
    "galaxy": {
      "command": "uvx",
      "args": ["galaxy-mcp"],
      "env": {
        "GALAXY_URL": "https://usegalaxy.org",
        "GALAXY_API_KEY": "your-key"
      }
    }
  }
}
```

### 5. Go

```
> Help me set up an RNA-seq differential expression experiment
```

## Skills

| Skill                   | Type         | Description                                         |
| ----------------------- | ------------ | --------------------------------------------------- |
| **galaxy-connect**      | Setup        | Configure galaxy-mcp and authenticate               |
| **galaxy-tools**        | Reference    | Search, inspect, and run Galaxy tools               |
| **galaxy-history**      | Reference    | Manage histories and datasets                       |
| **galaxy-workflow**     | Reference    | Import and run Galaxy workflows                     |
| **galaxy-rnaseq**       | Domain guide | RNA-seq DE pipeline with QC checkpoints             |
| **galaxy-variant**      | Domain guide | Variant calling with filtering rationale            |
| **galaxy-metagenomics** | Domain guide | Metagenomics profiling (Kraken2, MetaPhlAn, HUMAnN) |

## Why Galaxy + NemoClaw?

- **8,000+ tools** maintained by a global community -- never outdated
- **Server-side compute** -- tools run on Galaxy infrastructure, not your machine
- **Automatic provenance** -- Galaxy histories track every parameter and input
- **Sandbox security** -- OpenShell restricts the agent to Galaxy network access only
- **Privacy** -- genomic data goes to your Galaxy server, never to LLM providers
- **No static catalogs** -- galaxy-mcp searches the live tool panel dynamically

## Requirements

- [galaxy-mcp](https://github.com/galaxyproject/galaxy-mcp) (`pip install galaxy-mcp`)
- A Galaxy account with an API key ([get one here](https://usegalaxy.org/user/api_key))
- NemoClaw or OpenClaw

## License

MIT
