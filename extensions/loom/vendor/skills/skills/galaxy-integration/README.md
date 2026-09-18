# Galaxy Integration

Using Galaxy MCP, JupyterLite notebooks, and BioBlend-based scripts to interact with Galaxy instances.

This is the canonical documentation for Galaxy instance integration across skills in this repository.

**Agent entrypoint**: See `SKILL.md`.

## Purpose

Galaxy integration provides programmatic access to Galaxy instances. Useful for:

- **Testing** - Validate converted tools on Galaxy instances
- **Automation** - Streamline development workflows
- **Validation** - Compare outputs (e.g., NF vs Galaxy)
- **Analysis** - Write JupyterLite notebooks that interact with Galaxy datasets

## Structure

```
galaxy-integration/
├── SKILL.md                    # Router to sub-skills
├── galaxy-integration.md       # Detailed MCP + BioBlend docs
│
├── jupyterlite/                # JupyterLite notebook skill
│   ├── SKILL.md               # gxy package reference
│   └── examples/              # Example notebooks
│
(mcp-reference now lives at ../galaxy-mcp-reference/)
│   ├── SKILL.md               # Full MCP tools reference
│   ├── history-access.md      # History/dataset access patterns
│   └── gotchas.md             # Common pitfalls (keychain, URL slugs)
│
├── scripts/                    # BioBlend automation
│   └── galaxy_tool_checker.py
│
└── examples/                   # Tool checking and workflow testing
```

## Key Files

- **`SKILL.md`** - Router to sub-skills
- **`jupyterlite/SKILL.md`** - gxy package for JupyterLite notebooks
- **`../galaxy-mcp-reference/SKILL.md`** - Complete MCP tools reference
- **`galaxy-integration.md`** - Detailed guide (MCP + BioBlend)
- **`scripts/`** - Automation scripts (galaxy_tool_checker.py)
- **`examples/`** - Tool checking and workflow testing examples

## Usage Context

MCP is primarily used in the **nf-to-galaxy** conversion workflow for:
- Testing converted tools on local Galaxy instances
- Uploading test data
- Running tools and validating outputs
- Comparing Nextflow vs Galaxy results

It may also be used by other skills that need to interact with a Galaxy instance (tool discovery, workflow testing, automation).

---

## Quick Reference

### Setup

```bash
# Install
pip install galaxy-mcp

# Configure for Claude Code
# Add to ~/.config/claude/claude_desktop_config.json:
{
  "mcpServers": {
    "galaxy-mcp": {
      "command": "uvx",
      "args": ["galaxy-mcp"],
      "env": {
        "GALAXY_URL": "http://localhost:8080",
        "GALAXY_API_KEY": "your-key"
      }
    }
  }
}
```

---

## When to Use Galaxy MCP

Use Galaxy MCP when:
- You want **interactive exploration** of a Galaxy instance (tool search, tool I/O inspection)
- You are iterating on a workflow/tool and want **fast feedback** (create history, invoke workflow, inspect failures)
- You are working in an agentic environment where MCP tools are available

Prefer a script (e.g. BioBlend) when:
- You need to check **many tools at once**
- You want **repeatable automation** (CI-style checks)
- You want **workflow validation** without interactive iteration

---

## Prerequisites

- Galaxy instance URL (e.g. `https://usegalaxy.org/`)
- Galaxy API key (User → Preferences → Manage API Key)

**Where to find these**:
- **Galaxy URL**: The base URL of the Galaxy server you use (for public servers this is the site URL, e.g. `https://usegalaxy.org/`, `https://usegalaxy.eu/`).
- **API key**: In Galaxy, go to **User → Preferences → Manage API Key**.

**Using the repo-wide `.env` (recommended for this repository)**:
- From the **skills repository root**:

```bash
cp .env.example .env
nano .env
```

- Add:

```bash
GALAXY_URL=https://usegalaxy.org/
GALAXY_API_KEY=your_actual_api_key_here
```

The root `.env` is gitignored; do not commit API keys.

Treat the API key like a password. Do not commit it to git.

---

## Common MCP Tools (Typical Development Loop)

- **Connect**: `connect()` (or equivalent connection step depending on the client)
- **Find tools**: `search_tools_by_name(query=...)`
- **Inspect tool I/O**: `get_tool_details(tool_id=..., io_details=True)`
- **Create a history**: `create_history(history_name=...)`
- **Upload data**: `upload_file(...)`
- **Run tools**: `run_tool(...)`
- **Run workflows**: `invoke_workflow(workflow_id=..., inputs=..., history_id=...)`
- **Inspect outputs**: `get_history_contents(history_id=...)`, `get_dataset_details(...)`

---

## Minimal Workflow Testing Pattern

1. Create a new history for a clean run
2. Upload (or reuse) small test inputs
3. Invoke your workflow
4. Poll history contents until jobs finish
5. If something fails:
    - identify the failing step/tool
    - fix tool IDs / parameter mapping
    - re-import workflow and retry

---

## Where This Is Used

- **Nextflow → Galaxy conversions**: see `../../dev-skills/nf-to-galaxy/` (the conversion skill points here when MCP is needed)

See the upstream project for the full API reference:
- https://github.com/galaxyproject/galaxy-mcp
