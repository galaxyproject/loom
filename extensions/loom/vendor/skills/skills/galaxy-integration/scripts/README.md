# Scripts for Galaxy Integration

Automation scripts to support tool discovery, workflow validation, and workflow testing on Galaxy instances.

---

## Overview: Which Script to Use?

| Task | Script | Requires Galaxy API? |
|------|--------|---------------------|
| **Check tool on Galaxy instance** | `galaxy_tool_checker.py` | ✅ Yes |
| **Validate .ga workflow** | `galaxy_tool_checker.py` | ✅ Yes |
| **Test workflow execution** | `galaxy_tool_checker.py` | ✅ Yes |

---

## galaxy_tool_checker.py

**Purpose**: Check tool availability, validate workflows, and test workflow execution on live Galaxy instances using BioBlend.

**Key Features**:
- Batch tool availability checking
- Workflow validation (.ga files)
- Workflow testing (import and run)
- JSON output for automation
- Low token usage compared to MCP

**Installation**:
```bash
pip install bioblend

# Optional: For .env file support
pip install python-dotenv
```

**Usage Examples**:

### Check Single Tool
```bash
python galaxy-integration/scripts/galaxy_tool_checker.py \
    --url https://usegalaxy.org \
    --api-key YOUR_API_KEY \
    --tool hyphy
```

### Check Multiple Tools
```bash
python galaxy-integration/scripts/galaxy_tool_checker.py \
    --url https://usegalaxy.org \
    --api-key YOUR_API_KEY \
    --tool hyphy iqtree seqkit mafft \
    --output report.json
```

### Check Tools from File
```bash
# Create tools.txt with one tool name per line
python galaxy-integration/scripts/galaxy_tool_checker.py \
    --url https://usegalaxy.org \
    --api-key YOUR_API_KEY \
    --tool-list tools.txt
```

### Validate Workflow
```bash
python galaxy-integration/scripts/galaxy_tool_checker.py \
    --url https://usegalaxy.org \
    --api-key YOUR_API_KEY \
    --workflow my_workflow.ga \
    --verbose
```

### Test Workflow (Import and Run)
```bash
python galaxy-integration/scripts/galaxy_tool_checker.py \
    --url https://usegalaxy.org \
    --api-key YOUR_API_KEY \
    --workflow my_workflow.ga \
    --test \
    --history "Test Run" \
    --wait
```

**Exit Codes**:
- `0`: Success (all tools found / workflow valid)
- `1`: Failure (tools missing / workflow invalid)

**See Also**:
- `../galaxy-integration.md` - Complete integration guide

---

## When to Use Which Script

| Scenario | Use | Why |
|----------|-----|-----|
| **Check if tool exists on YOUR Galaxy instance** | `galaxy_tool_checker.py` | Connects to actual Galaxy |
| **Check multiple tools at once** | `galaxy_tool_checker.py --tool-list` | Batch checking |
| **Validate .ga workflow structure** | `galaxy_tool_checker.py --workflow` | Checks all tools exist |
| **Test workflow execution on Galaxy** | `galaxy_tool_checker.py --workflow --test` | Actually runs it |
| **CI/CD automation** | `galaxy_tool_checker.py` | Scriptable with exit codes |

**Summary**: 
- `galaxy_tool_checker.py` = Check/validate/test on actual Galaxy instance (needs API key)

---

## Configuration: Environment Variables and .env Files

### Option 1: .env File (Recommended)

Create a `.env` file in your working directory (recommended: the **skills repository root**):

```bash
# Copy the example
# From the skills repository root:
cp .env.example .env

# Edit with your credentials
nano .env
```

`.env` file contents:
```bash
GALAXY_URL=https://usegalaxy.org/
GALAXY_API_KEY=your_api_key_here
```

**Security**: The `.env` file is gitignored by default. Never commit API keys to git!

**Note**: `galaxy_tool_checker.py` looks for a `.env` in the current directory **and parent directories**, so placing `.env` at the skills repo root lets you run the script from `nf-to-galaxy/scripts/` without copying credentials into subdirectories.

### Option 2: Environment Variables

```bash
export GALAXY_URL="https://usegalaxy.org"
export GALAXY_API_KEY="your_api_key_here"
```

### Option 3: Command Line Arguments

```bash
python galaxy_tool_checker.py \
    --url https://usegalaxy.org \
    --api-key YOUR_KEY \
    --tool hyphy
```

### Getting Your API Key

1. Go to your Galaxy instance (e.g., https://usegalaxy.org)
2. Log in
3. Navigate to: **User → Preferences → Manage API Key**
4. Click "Create a new key" if you don't have one
5. Copy the key to your `.env` file or environment variable

**Priority Order**: Command line args → Environment variables → .env file

---

## Related Documentation

- **`../README.md`** - Galaxy integration overview and setup
- **`../SKILL.md`** - Agent entrypoint for Galaxy integration
- **`../galaxy-integration.md`** - Galaxy MCP and BioBlend integration guide
