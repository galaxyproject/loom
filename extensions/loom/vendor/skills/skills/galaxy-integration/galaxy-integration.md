# Galaxy Integration for Tool Checking and Workflow Testing

Complete guide for using Galaxy MCP or BioBlend to check tool availability, validate workflows, and test workflow execution during Nextflow-to-Galaxy conversions.

**Contents**:
- [Setup](#setup) - First-time configuration
- [Usage](#usage) - Tool checking and workflow testing
- [Agent Guide](#agent-guide) - For AI agents using this skill
- [Examples](#examples) - See `examples/` directory

---

## Setup

### Prerequisites

1. **Galaxy Account**: Account on a Galaxy instance (e.g., https://usegalaxy.org)
2. **Galaxy API Key**: Required for programmatic access
3. **Python 3.8+**: For BioBlend script

### Get Your Galaxy API Key

1. Go to your Galaxy instance (e.g., https://usegalaxy.org)
2. Log in → **User** → **Preferences** → **Manage API Key**
3. Click **Create a new key** (if needed)
4. Copy the key

**Important**: Treat API key like a password. Never commit to git.

### Configure Credentials

**Option 1: .env File (Recommended)**

```bash
cd /path/to/skills
cp .env.example .env
nano .env  # Add your credentials
```

`.env` contents:
```bash
GALAXY_URL=https://usegalaxy.org/
GALAXY_API_KEY=your_actual_api_key_here
```

**Option 2: Environment Variables**

```bash
export GALAXY_URL="https://usegalaxy.org/"
export GALAXY_API_KEY="your_api_key"
```

**Option 3: Command Line**

```bash
python galaxy-integration/scripts/galaxy_tool_checker.py --url https://usegalaxy.org --api-key YOUR_KEY --tool hyphy
```

### Install Dependencies

```bash
# Required
pip install bioblend

# Optional: For .env file support
pip install python-dotenv
```

### Test Setup

```bash
python galaxy-integration/scripts/galaxy_tool_checker.py --tool hyphy --verbose
```

Expected: Connection success and tool results.

**Troubleshooting**:
- "API key required" → Check `.env` file or environment variables
- "Failed to connect" → Verify URL format (must end with `/`)
- "401 Authentication failed" → Regenerate API key in Galaxy

---

## Usage

## Overview

When converting Nextflow workflows to Galaxy, you need to:
1. **Check if tools exist** on your target Galaxy instance
2. **Get tool versions** to ensure compatibility
3. **Validate .ga workflow files** (check all tools are available)
4. **Test workflow execution** iteratively without manual intervention

You have two options:
- **Galaxy MCP**: Best for interactive agent workflows (when available)
- **BioBlend Python Script** (`galaxy_tool_checker.py`): Best for reducing token usage, automation, and workflow validation

**Key Point**: The BioBlend script does MORE than just check tools - it can validate and test entire workflows.

---

## Option 1: Galaxy MCP (Agent-Friendly)

Galaxy MCP is useful for interactive tool discovery and workflow testing during conversions.

**Canonical documentation** for MCP setup and usage lives in:
- `galaxy-integration/README.md`

---

## Option 2: BioBlend Python Script (Low-Token)

### When to Use BioBlend Script

Use the BioBlend script when:
- You want to minimize token usage
- You need repeatable, automated checks
- You're doing batch conversions
- You want to avoid MCP overhead
- **You need to validate .ga workflow files**
- **You want to test workflow execution on Galaxy**

### What the Script Can Do

The script has **three main capabilities**:

1. **Tool Availability Checking** - Check if tools exist on Galaxy instance
2. **Workflow Validation** - Validate .ga files (check all tools are available)
3. **Workflow Testing** - Import and run workflows on Galaxy

### The Script

See `galaxy-integration/scripts/galaxy_tool_checker.py` for the complete implementation.

### Configuration

Before using the script, set up your Galaxy credentials:

**Option 1: .env file (Recommended)**
```bash
# Create .env file in the skills repository root
cat > .env << EOF
GALAXY_URL=https://usegalaxy.org/
GALAXY_API_KEY=your_api_key_here
EOF

# Then run without --url or --api-key
python galaxy-integration/scripts/galaxy_tool_checker.py --tool hyphy
```

**Option 2: Environment variables**
```bash
export GALAXY_URL="https://usegalaxy.org/"
export GALAXY_API_KEY="your_api_key"
```

**Option 3: Command line arguments**
```bash
python galaxy-integration/scripts/galaxy_tool_checker.py \
    --url https://usegalaxy.org \
    --api-key YOUR_API_KEY \
    --tool hyphy
```

**Get your API key**: Galaxy → User → Preferences → Manage API Key

### Usage Examples

#### Check Single Tool

```bash
# With .env file configured
python galaxy-integration/scripts/galaxy_tool_checker.py --tool hyphy

# Or with explicit credentials
python galaxy-integration/scripts/galaxy_tool_checker.py \
    --url https://usegalaxy.org \
    --api-key YOUR_API_KEY \
    --tool hyphy
```

Output:
```json
{
  "tool_name": "hyphy",
  "found": true,
  "matches": [
    {
      "id": "toolshed.g2.bx.psu.edu/repos/iuc/hyphy_fel/hyphy_fel/2.5.84+galaxy0",
      "name": "HyPhy-FEL",
      "version": "2.5.84+galaxy0"
    }
  ]
}
```

#### Check Multiple Tools

```bash
python galaxy-integration/scripts/galaxy_tool_checker.py \
    --url https://usegalaxy.org \
    --api-key YOUR_API_KEY \
    --tool hyphy iqtree seqkit \
    --output tools_report.json
```

#### Validate Workflow (.ga file)

```bash
# Check that all tools in workflow exist on Galaxy instance
python galaxy-integration/scripts/galaxy_tool_checker.py \
    --url https://usegalaxy.org \
    --api-key YOUR_API_KEY \
    --workflow my_workflow.ga \
    --verbose
```

Output shows which tools are available and which are missing.

#### Test Workflow Execution

```bash
# Import and run the workflow on Galaxy
python galaxy-integration/scripts/galaxy_tool_checker.py \
    --url https://usegalaxy.org \
    --api-key YOUR_API_KEY \
    --workflow my_workflow.ga \
    --test \
    --history "Test Run" \
    --wait
```

### Script Features

**Tool Checking**:
- Batch tool checking: Check multiple tools at once
- JSON output: Machine-readable results for automation
- Version comparison: Compare available vs. required versions

**Workflow Validation**:
- Validate .ga files: Check all tools in workflow exist
- Structured error reporting: Identify missing tools by step
- Fast validation: No execution needed

**Workflow Testing**:
- Import workflows: Test import process
- Execute workflows: Actually run on Galaxy
- Wait for completion: Monitor execution with `--wait` flag
- Exit codes: 0 for success, 1 for failure (CI/CD friendly)

**General**:
- Minimal output: Reduces context bloat in agent conversations
- Environment variable support: Use `GALAXY_URL` and `GALAXY_API_KEY`

---

## Workflow Testing, Validation, and Output Comparison

Workflow tests require a Galaxy instance because `.ga` workflows are executed by Galaxy.

### When a local Galaxy is worth it

Use a local Galaxy instance when:
- You created **custom tools** (not already installed anywhere)
- You are using tools from a repo not installed on your target Galaxy
- You need rapid iteration without affecting a shared server

If all tools exist on a target Galaxy instance already (e.g. usegalaxy.*, or your institution’s Galaxy), you can test directly there.

---

### Option A: Workflow Testing via Galaxy MCP (Agent-Friendly)

If `galaxy-mcp` is available and you can connect to a Galaxy instance:

#### Complete testing flow

```python
# 1. Connect to Galaxy
connect(url="https://usegalaxy.org", api_key="YOUR_API_KEY")

# 2. Create test history
history = create_history(history_name="Test: My Workflow")
history_id = history["id"]

# 3. Validate tools exist
search_tools_by_name(query="hyphy")
get_tool_details(tool_id="toolshed.g2.bx.psu.edu/repos/iuc/hyphy_fel/hyphy_fel/2.5.84+galaxy0", io_details=True)

# 4. Invoke workflow
invoke_workflow(
    workflow_id="WORKFLOW_ID",
    inputs={"0": {"id": "DATASET_ID", "src": "hda"}},
    history_id=history_id
)

# 5. Monitor execution
get_history_contents(
    history_id=history_id,
    order="create_time-dsc",
    limit=25
)
```

#### Iterative testing pattern

The agent can automatically:
1. **Run the workflow**
2. **Check for failures** in history contents
3. **Identify problematic tools** (wrong IDs, missing parameters)
4. **Fix the .ga file** by searching for correct tool IDs
5. **Re-import and test** without user intervention

**When to prefer MCP**:
- You are already working in an agentic environment
- You want interactive debugging and iteration
- You need to explore tool details during testing
- You want the same interface for "find tool → run tool → inspect outputs"

**See**: `galaxy-integration/README.md` for MCP setup and usage patterns.

---

### Option B: Workflow Testing via BioBlend (Low-Token / Script-Friendly)

For repeated testing (CI-like runs) and for minimizing LLM context/tokens, use the provided BioBlend script.

#### Why BioBlend can be better than MCP

- **Less conversational overhead** - Minimal token usage
- **Easy to run repeatedly** with the same parameters
- **Produces deterministic logs** and artifacts
- **Batch operations** - Check multiple tools/workflows at once
- **CI/CD friendly** - Scriptable and automatable

#### Validate workflow structure

```bash
# Check that all tools in workflow exist on target Galaxy
python galaxy-integration/scripts/galaxy_tool_checker.py \
    --url https://usegalaxy.org \
    --api-key $GALAXY_API_KEY \
    --workflow my_workflow.ga \
    --verbose
```

#### Test workflow execution

```bash
# Import and optionally run the workflow
python galaxy-integration/scripts/galaxy_tool_checker.py \
    --url https://usegalaxy.org \
    --api-key $GALAXY_API_KEY \
    --workflow my_workflow.ga \
    --test \
    --history "Test Run" \
    --wait
```

#### Batch tool checking

```bash
# Check multiple tools at once (efficient for large conversions)
python galaxy-integration/scripts/galaxy_tool_checker.py \
    --url https://usegalaxy.org \
    --api-key $GALAXY_API_KEY \
    --tool hyphy iqtree seqkit mafft \
    --output tool_report.json
```

**Notes**:
- Use `--output` to save JSON results for programmatic processing
- Exit code indicates success (0) or failure (non-zero)
- Useful for automated testing pipelines

---

### Output validation / comparison guidance

#### What “matching Nextflow” means

Choose the appropriate fidelity level:
- **Structural match**:
  - outputs exist, file types correct, counts plausible
- **Content match**:
  - identical output (only if deterministic)
- **Semantic match**:
  - key metrics / summary stats match within tolerance

#### Practical recommendations

- Prefer checking:
  - presence of expected output files
  - expected columns/headers
  - JSON schema keys
  - basic stats (counts, sizes)
- Use exact matching only when outputs are deterministic.

---

### Decision matrix: which testing method?

| Scenario | Recommended Method | Why |
|----------|-------------------|-----|
| **Creating new tool** | Planemo | Static validation, unit tests |
| **Testing 1-2 workflows interactively** | Galaxy MCP | Interactive debugging, iteration |
| **Testing 5+ workflows** | BioBlend script | Batch processing, low tokens |
| **Checking tool availability** | BioBlend script first, then MCP for details | Efficient batch check, then explore |
| **CI/CD pipeline** | BioBlend script | Automated, deterministic |
| **Iterating on failures** | Galaxy MCP | Agent can auto-fix and retry |
| **First-time Galaxy exploration** | Galaxy MCP | Interactive, educational |

---

## Integration with Conversion Skills

### For `nf-process-to-galaxy-tool`

When creating a new tool:

1. **Extract tool name** from Nextflow process container
2. **Check if tool exists** using MCP or script
3. **If found**: Note the tool ID for workflow creation
4. **If not found**: Proceed with tool creation

Example workflow:
```
Process: HYPHY_FEL
Container: biocontainers/hyphy:2.5.84

→ search_tools_by_name(query="hyphy")
→ Found: toolshed.g2.bx.psu.edu/repos/iuc/hyphy_fel/hyphy_fel/2.5.84+galaxy0
→ Action: Use existing tool (no need to create)
```

### For `nf-subworkflow-to-galaxy-workflow`

When creating a workflow:

1. **Check all required tools** exist on target instance
2. **Get exact tool IDs** with versions
3. **Create .ga file** with correct tool IDs
4. **Test workflow** using MCP or script
5. **Iterate on failures** automatically

### For `nf-pipeline-to-galaxy-workflow`

When converting a complete pipeline:

1. **Inventory all processes** and their tools
2. **Batch check tool availability** (use BioBlend script for efficiency)
3. **Generate tool availability report**
4. **Create workflows** with verified tool IDs
5. **Test each workflow** independently
6. **Chain workflows** and test integration

---

## Agent Guide

### Credential Prompt (copy/paste)

```
To check tool availability on your Galaxy instance, I need:
1. Galaxy instance URL (e.g., https://usegalaxy.org/)
2. Galaxy API key

You can provide these by:
- Creating a .env file (recommended)
- Setting environment variables: GALAXY_URL and GALAXY_API_KEY
- Passing as arguments: --url and --api-key

Would you like help setting this up?
```

### Method Selection

- **Tool checking (1-3 tools)**
  - Prefer Galaxy MCP (interactive) when available.
- **Tool checking (5+ tools)**
  - Prefer BioBlend script (batch, low tokens).
- **Workflow validation (.ga)**
  - Prefer BioBlend script (fast structural validation).
- **Workflow testing + iteration**
  - Prefer Galaxy MCP when available (agent can iterate on failures).

### Iteration Pattern for Workflow Failures

1. Run workflow
2. Identify failing step(s)
3. If tool ID mismatch
  - Search tools
  - Update `.ga` tool IDs and versions
4. If datatype mismatch
  - Inspect tool IO
  - Update connections or add conversion steps
5. Re-import and re-test

---

## Summary

### What This Integration Provides

- **Tool Availability Checking**
  - Galaxy MCP (interactive)
  - BioBlend script (batch)
- **Workflow Validation**
  - BioBlend script validates `.ga` files by checking required tools exist
- **Workflow Testing**
  - Galaxy MCP for interactive iteration
  - BioBlend script for repeatable test runs

### Key Files

- `scripts/galaxy_tool_checker.py`
- `.env.example`
- `scripts/README.md`
- `examples/` - Practical examples:
  - `examples/tool-checking.md` - Tool availability checking examples
  - `examples/workflow-testing.md` - Workflow testing and validation examples

---

## Best Practices

### Token Efficiency

**Use MCP when**:
- Doing interactive, exploratory work
- Need to iterate on a single workflow
- Want real-time feedback during development

**Use BioBlend script when**:
- Checking many tools at once (>5 tools)
- Doing batch conversions
- Running automated tests
- Want deterministic, repeatable results

### Error Handling

Both approaches should handle:
- **Tool not found**: Report clearly, suggest alternatives
- **Wrong version**: Note version mismatch, suggest update
- **Workflow failures**: Identify failing step, suggest fixes
- **Connection issues**: Retry with exponential backoff

### Reporting Format

When reporting tool availability, use this format:

```markdown
## Tool Availability Report

### Tools Found on Galaxy Instance

| Nextflow Process | Tool Name | Galaxy Tool ID | Version | Status |
|------------------|-----------|----------------|---------|--------|
| HYPHY_FEL | hyphy | toolshed.g2.bx.psu.edu/repos/iuc/hyphy_fel/hyphy_fel | 2.5.84+galaxy0 | ✅ Available |
| IQTREE | iqtree | toolshed.g2.bx.psu.edu/repos/iuc/iqtree/iqtree | 2.1.2+galaxy2 | ✅ Available |
| CUSTOM_TOOL | custom | - | - | ❌ Not found - needs creation |

### Summary
- **Available**: 2/3 tools (67%)
- **Missing**: 1 tool requires creation
- **Action**: Create CUSTOM_TOOL wrapper, then build workflow
```

---

## Troubleshooting

### MCP Connection Issues

```python
# Check connection
get_server_info()

# If fails, reconnect
connect(url="https://usegalaxy.org", api_key="YOUR_KEY")
```

### Tool ID Format Issues

Galaxy tool IDs can have multiple formats:
- Simple: `Cut1`, `cat1`
- ToolShed: `toolshed.g2.bx.psu.edu/repos/iuc/hyphy_fel/hyphy_fel/2.5.84+galaxy0`

Always use the full ToolShed format in workflows for reproducibility.

### Workflow Testing Failures

Common issues:
1. **Wrong tool ID**: Use `search_tools_by_name` to find correct ID
2. **Missing input mapping**: Check workflow input step indices
3. **Datatype mismatch**: Verify input/output datatypes match
4. **Tool not installed**: Check with `get_tool_panel`

---

## Examples

See `examples/` directory for:
- `tool-checking-example.md` - Complete tool checking workflow
- `workflow-testing-example.md` - End-to-end workflow testing
- `capheine-mapping.md` - Complete CAPHEINE pipeline conversion

---

## Related Documentation

- `check-tool-availability.md` - Manual checking methods
- `testing-and-validation.md` - Testing strategies
- `scripts/galaxy_tool_checker.py` - BioBlend automation script
