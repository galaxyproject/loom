# Tool Checking with Galaxy MCP and BioBlend

Generic guide for checking tool availability on Galaxy instances.

---

## Overview

Before creating or running workflows, verify that required tools exist on your target Galaxy instance. This guide covers two methods: interactive (Galaxy MCP) and automated (BioBlend script).

---

## Method 1: Interactive Tool Checking with Galaxy MCP

### When to Use

- Exploring a Galaxy instance for the first time
- Need to understand tool details interactively
- Working with 1-2 tools
- Want to see tool inputs/outputs/parameters

### Step 1: Connect to Galaxy

```python
# Check connection status
get_server_info()

# If not connected
connect(url="https://usegalaxy.org", api_key="YOUR_API_KEY")
```

### Step 2: Search for Tools

```python
# Search by name
results = search_tools_by_name(query="samtools")

# Returns list of matching tools with IDs and versions
```

**Example output**:
```
Found 15 tools matching "samtools":
1. SAMtools view (1.18+galaxy2)
   ID: toolshed.g2.bx.psu.edu/repos/iuc/samtools_view/samtools_view/1.18+galaxy2
2. SAMtools sort (1.18+galaxy2)
   ID: toolshed.g2.bx.psu.edu/repos/iuc/samtools_sort/samtools_sort/1.18+galaxy2
...
```

### Step 3: Get Tool Details

```python
# Get detailed information about a specific tool
details = get_tool_details(
    tool_id="toolshed.g2.bx.psu.edu/repos/iuc/samtools_view/samtools_view/1.18+galaxy2",
    io_details=True
)

# Returns:
# - Tool version
# - Input parameters and types
# - Output formats
# - Requirements (conda packages)
```

### Step 4: Verify Tool Functionality

```python
# Check if tool can be invoked
tool_info = get_tool_details(
    tool_id="toolshed.g2.bx.psu.edu/repos/iuc/samtools_view/samtools_view/1.18+galaxy2"
)

# Verify:
# - Tool is installed
# - Version matches requirements
# - Inputs/outputs match expectations
```

---

## Method 2: Automated Tool Checking with BioBlend Script

### When to Use

- Checking 5+ tools at once
- Batch validation
- Automated CI/CD workflows
- Need structured output for processing
- Want to minimize interaction

### Step 1: Prepare Tool List

**Option A: Text file**

```bash
# Create tools.txt
cat > tools.txt << EOF
samtools
bwa
bcftools
fastqc
EOF
```

**Option B: From workflow file**

```bash
# Extract tools from workflow
python ../scripts/galaxy_tool_checker.py \
    --workflow my_workflow.ga \
    --list-tools > tools.txt
```

### Step 2: Run Batch Check

```bash
python ../scripts/galaxy_tool_checker.py \
    --url https://usegalaxy.org \
    --api-key $GALAXY_API_KEY \
    --tool-list tools.txt \
    --output report.json \
    --verbose
```

**Configuration**: See `../scripts/README.md` for `.env` file setup

### Step 3: Review Results

**Console output**:
```
============================================================
Tool Availability Report
Galaxy: https://usegalaxy.org
============================================================

✅ samtools: Found 15 match(es)
   - SAMtools view (1.18+galaxy2)
     ID: toolshed.g2.bx.psu.edu/repos/iuc/samtools_view/samtools_view/1.18+galaxy2
   - SAMtools sort (1.18+galaxy2)
     ID: toolshed.g2.bx.psu.edu/repos/iuc/samtools_sort/samtools_sort/1.18+galaxy2

✅ bwa: Found 3 match(es)
   - BWA-MEM (0.7.17+galaxy1)
     ID: toolshed.g2.bx.psu.edu/repos/iuc/bwa_mem/bwa_mem/0.7.17+galaxy1

❌ custom_tool: Not found

============================================================
Summary: 3/4 tools found (75.0%)
============================================================
```

### Step 4: Parse JSON Output

```python
import json

with open('report.json', 'r') as f:
    report = json.load(f)

# Extract tool IDs
tool_mapping = {}
for tool_name, result in report['tools'].items():
    if result['found'] and result['matches']:
        tool_mapping[tool_name] = result['matches'][0]['id']

# Use in workflow creation
print(json.dumps(tool_mapping, indent=2))
```

**JSON structure**:
```json
{
  "galaxy_url": "https://usegalaxy.org",
  "tools": {
    "samtools": {
      "found": true,
      "matches": [
        {
          "id": "toolshed.g2.bx.psu.edu/repos/iuc/samtools_view/samtools_view/1.18+galaxy2",
          "name": "SAMtools view",
          "version": "1.18+galaxy2"
        }
      ]
    }
  }
}
```

---

## Decision Matrix: MCP vs BioBlend Script

| Aspect | Galaxy MCP | BioBlend Script |
|--------|-----------|-----------------|
| **Setup** | MCP server running | Python + BioBlend installed |
| **Interaction** | Conversational | Command-line |
| **Speed** | Interactive | Fast batch |
| **Output** | Conversational | JSON/structured |
| **Best for** | Exploration, 1-2 tools | Automation, 5+ tools |
| **Token usage** | Higher | Lower |
| **CI/CD** | Possible but complex | Native support |
| **Learning curve** | Low | Medium |

---

## Common Workflows

### Workflow 1: Initial Exploration

```
1. Use MCP to explore Galaxy instance
   └─ search_tools_by_name("tool_family")
   
2. Identify relevant tools
   └─ get_tool_details(tool_id, io_details=True)
   
3. Note exact tool IDs and versions
```

### Workflow 2: Batch Validation

```
1. Create tool list (tools.txt)

2. Run BioBlend script
   └─ --tool-list tools.txt --output report.json
   
3. Parse results programmatically
   └─ Extract tool IDs for workflow creation
```

### Workflow 3: Hybrid Approach

```
1. Use BioBlend script for initial batch check
   └─ Quick overview of what's available
   
2. Use MCP to explore specific tools in detail
   └─ Understand inputs/outputs/parameters
   
3. Use BioBlend script for final validation
   └─ Verify all tools before workflow creation
```

---

## Handling Missing Tools

### Tool Not Found

**Options**:
1. **Search with different query** - Tool might have different name
2. **Check ToolShed** - Tool might exist but not installed
3. **Create custom tool** - See `../../../dev-skills/tool-dev/SKILL.md`

**Example**:
```python
# Try variations
search_tools_by_name("samtools")
search_tools_by_name("sam tools")
search_tools_by_name("sam")
```

### Multiple Matches

**Decision criteria**:
1. **Version** - Use latest stable version
2. **Repository** - Prefer IUC (tools-iuc)
3. **Maintenance** - Check last update date
4. **Usage** - Check if tool is commonly used

**Example**:
```
Found 3 matches for "bwa":
1. BWA-MEM (0.7.17+galaxy1) - IUC ✅
2. BWA (0.7.15+galaxy0) - devteam ⚠️
3. BWA custom (0.7.12) - unknown ❌

Choose: Option 1 (latest, IUC maintained)
```

---

## Integration with Workflows

### Before Workflow Creation

```python
# 1. Check all required tools
tools_needed = ["tool1", "tool2", "tool3"]

# 2. Verify availability
for tool in tools_needed:
    results = search_tools_by_name(query=tool)
    if not results:
        print(f"❌ {tool} not found - need to create")

# 3. Note exact tool IDs for workflow
```

### During Workflow Testing

```python
# 1. Import workflow
workflow = import_workflow(path="workflow.ga")

# 2. Check if all tools are available
# (workflow import will fail if tools missing)

# 3. Test workflow execution
# See: workflow-testing.md
```

---

## Tips and Best Practices

### Searching Effectively

- **Be specific**: "samtools view" better than "samtools"
- **Try variations**: "bwa mem", "bwa-mem", "bwamem"
- **Check family**: Search parent tool name for all variants

### Recording Results

```markdown
## Tool Availability Report

**Galaxy Instance**: https://usegalaxy.org
**Date**: 2026-01-05

| Tool | Status | Tool ID | Version |
|------|--------|---------|---------|
| SAMtools view | ✅ | toolshed.g2.bx.psu.edu/repos/iuc/samtools_view/samtools_view/1.18+galaxy2 | 1.18 |
| BWA-MEM | ✅ | toolshed.g2.bx.psu.edu/repos/iuc/bwa_mem/bwa_mem/0.7.17+galaxy1 | 0.7.17 |
| Custom tool | ❌ | - | - |

**Actions**:
- Use existing tools for SAMtools and BWA
- Create custom tool wrapper for custom_tool
```

### Automation

```bash
#!/bin/bash
# check_tools.sh - Automated tool checking

GALAXY_URL="https://usegalaxy.org"
TOOLS_FILE="required_tools.txt"
OUTPUT_FILE="tool_report_$(date +%Y%m%d).json"

python galaxy_tool_checker.py \
    --url $GALAXY_URL \
    --api-key $GALAXY_API_KEY \
    --tool-list $TOOLS_FILE \
    --output $OUTPUT_FILE \
    --verbose

# Check exit code
if [ $? -eq 0 ]; then
    echo "✅ All tools found"
else
    echo "❌ Some tools missing - see $OUTPUT_FILE"
    exit 1
fi
```

---

## Related Documentation

- **Main guide**: `../galaxy-integration.md` - Complete Galaxy integration guide
- **BioBlend script**: `../scripts/README.md` - galaxy_tool_checker.py usage
- **Workflow testing**: `workflow-testing.md` - Testing workflows on Galaxy
- **Tool creation**: `../../../dev-skills/tool-dev/SKILL.md` - Creating missing tools

---

## Troubleshooting

### Connection Issues

```python
# Test connection
try:
    info = get_server_info()
    print(f"✅ Connected to {info['url']}")
except:
    print("❌ Connection failed - check URL and API key")
```

### Tool Search Returns Nothing

1. **Check spelling** - Try variations
2. **Check Galaxy instance** - Tool might not be installed
3. **Check ToolShed** - Tool might exist but not on this instance
4. **Try broader search** - Use partial name

### Script Errors

```bash
# Enable debug mode
python galaxy_tool_checker.py \
    --url $GALAXY_URL \
    --api-key $GALAXY_API_KEY \
    --tool-list tools.txt \
    --verbose \
    --debug
```

Common issues:
- Invalid API key
- Network connectivity
- Tool list format (one tool per line)
- Galaxy instance unavailable
