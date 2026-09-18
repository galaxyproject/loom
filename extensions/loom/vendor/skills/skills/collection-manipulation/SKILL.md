---
name: collection-manipulation
description: Transform Galaxy dataset collections reproducibly using Galaxy's native tools. Use when asked to filter, sort, relabel, restructure, flatten, nest or merge a collection, build a list or paired collection, run a tool over every sample (map over a collection), or work with element identifiers.
metadata:
  surfaces: [loom]
user_invocable: true
---

# Galaxy Collection Manipulation

Transform Galaxy dataset collections reproducibly using Galaxy's native tools.

**CRITICAL PRINCIPLE:** All collection operations MUST use Galaxy's native tools to ensure reproducibility, workflow extractability, and alignment with Galaxy best practices. NEVER manipulate collections directly via API or create collections ad-hoc.

## Common Pitfalls (READ FIRST)

These issues cause silent failures or empty results. **Memorize them.**

> For deep-dive reference on API patterns, Apply Rules DSL, tool catalog, and test examples, see `references/` in the `collection-manipulation` skill directory.

### 1. Data Inputs Require `values` Wrapper

Many tools silently fail without this wrapper:

```python
# WRONG - Tool runs with no input, produces empty collection
inputs = {
    "input": {"src": "hdca", "id": collection_id}
}

# CORRECT - With values wrapper
inputs = {
    "input": {
        "values": [{"src": "hdca", "id": collection_id}]
    }
}
```

### 2. Conditional Parameters Use Pipe Notation

```python
# WRONG - Nested object ignored, defaults used
inputs = {
    "how": {
        "how_filter": "remove_if_absent",
        "filter_source": {"src": "hda", "id": file_id}
    }
}

# CORRECT - Pipe notation
inputs = {
    "how|how_filter": "remove_if_absent",
    "how|filter_source": {"src": "hda", "id": file_id}
}
```

### 3. Job Outputs Require `full=true`

```python
# WRONG - Returns empty for collection operations
outputs = GET /api/jobs/{job_id}/outputs

# CORRECT - Use full=true to get output_collections
job = GET /api/jobs/{job_id}?full=true
collection_id = job["output_collections"][0]["id"]
```

### 4. Galaxy Fails Silently

Wrong input format → tool runs with defaults → empty/wrong output. **Always verify output contents**, not just job status.

### 5. FILTER_FROM_FILE Correct Structure

This tool commonly fails due to format issues:

```python
# CORRECT structure for __FILTER_FROM_FILE__
inputs = {
    "input": {
        "values": [{"src": "hdca", "id": collection_id}]
    },
    "how|how_filter": "remove_if_absent",
    "how|filter_source": {
        "values": [{"src": "hda", "id": identifier_file_id}]
    }
}
```

### 6. Debugging with `/api/tools/{id}/build`

When inputs are ignored, use the build endpoint to discover correct format:

```python
# Get expected input structure for any tool
GET /api/tools/__FILTER_FROM_FILE__/build?history_id={history_id}

# Response shows exact format expected:
{
  "inputs": [
    {
      "name": "input",
      "value": {"values": [{"id": "...", "src": "hdca"}]}  # Note the wrapper!
    },
    {
      "name": "how|filter_source",  # Note pipe notation!
      "value": {"values": [...]}
    }
  ]
}
```

### 7. Repeated Parameters Pattern

Tools with repeating sections (like `__BUILD_LIST__`) use indexed notation:

```python
inputs = {
    "datasets_0|input": {"src": "hda", "id": dataset1_id},
    "datasets_1|input": {"src": "hda", "id": dataset2_id},
    "datasets_2|input": {"src": "hda", "id": dataset3_id}
}
```

### 8. Tool Response Structure

Understand what comes back from tool execution:

```python
response = POST /api/tools { tool_id, history_id, inputs }

# Response contains:
{
    "outputs": [...],              # Individual datasets created
    "output_collections": [...],   # Explicitly created collections
    "implicit_collections": [...], # Collections from map-over operations
    "jobs": [...]                  # Job IDs for polling
}
```

- Use `outputs` for single dataset results
- Use `output_collections` for collection tool results
- Use `implicit_collections` when mapping a tool over a collection

### 9. Inspecting Collections

Before transforming, inspect what you're working with:

```python
# Get full collection structure
collection = GET /api/histories/{history_id}/contents/dataset_collections/{collection_id}

# Traverse elements
for element in collection["elements"]:
    identifier = element["element_identifier"]  # The name
    elem_type = element["element_type"]         # "hda" or "dataset_collection"

    if elem_type == "hda":
        dataset = element["object"]
        dataset_id = dataset["id"]
    elif elem_type == "dataset_collection":
        nested = element["object"]  # Recurse for nested collections
```

---

## Galaxy MCP Server (Preferred When Available)

If Galaxy MCP is configured, **prefer it over direct API calls**. MCP avoids all the pitfalls above.

**Repository:** https://github.com/galaxyproject/galaxy-mcp

### MCP Advantages

- **No `values` wrapper needed** - MCP handles input format complexity internally
- **Simplified authentication** - Uses configured credentials
- **Built-in error handling** - Clearer error messages than silent API failures

### MCP Tools Available

| MCP Tool | Purpose |
|----------|---------|
| `run_tool` | Execute Galaxy tools |
| `get_histories` | List user histories |
| `list_history_ids` | Get history IDs |
| `get_history_contents` | List history items |
| `get_job_details` | Check job status and outputs |

### MCP Usage Examples

**Run a collection operation:**
```python
# MCP - Simple, no wrapper needed
run_tool(
    tool_id="__FILTER_FROM_FILE__",
    inputs={
        "input": {"src": "hdca", "id": collection_id},
        "how|how_filter": "remove_if_absent",
        "how|filter_source": {"src": "hda", "id": filter_file_id}
    }
)
```

**Check job and get outputs:**
```python
job = get_job_details(job_id)
# output_collections included automatically
```

### When MCP Is Not Available

Fall back to direct API calls using the patterns in this document. The "Common Pitfalls" section above becomes critical - follow those patterns exactly.

---

## Decision Framework

### Step 1: Assess Available Metadata

Before choosing a strategy, examine what metadata exists:

**In the collection itself:**
- Element identifiers (names)
- Nested structure (list, paired, list:paired, etc.)
- Element indices (positional)

**In dataset tags:**
- Simple tags (labels)
- Group tags (`group:category:value`)
- Name tags (`name:value` or `#value`)

**Embedded in identifiers:**
- Patterns extractable via regex (e.g., `sample_001_R1.fastq` contains sample ID and read direction)

### Step 2: Choose Strategy (in order of preference)

#### Strategy A: Collection Operation Tools (PREFERRED)

Use when transformation maps directly to an existing tool's capability.

| Goal | Tool ID | When to Use |
|------|---------|-------------|
| Filter by identifier list | `__FILTER_FROM_FILE__` | Keep/remove specific elements |
| Remove empty elements | `__FILTER_EMPTY_DATASETS__` | Clean up after failures |
| Remove failed elements | `__FILTER_FAILED_DATASETS__` | Continue after partial failures |
| Remove null elements | `__FILTER_NULL__` | Clean conditional outputs |
| Keep only successful | `__KEEP_SUCCESS_DATASETS__` | Ensure only completed samples |
| Extract single element | `__EXTRACT_DATASET__` | Get specific dataset by name/index |
| Flatten nested → flat | `__FLATTEN__` | Convert list:paired to list |
| Add nesting level | `__NEST__` | Convert list to list:list |
| Create paired from two | `__ZIP_COLLECTION__` | Combine forward/reverse |
| Split paired to two | `__UNZIP_COLLECTION__` | Separate paired collection |
| Split paired/unpaired | `__SPLIT_PAIRED_AND_UNPAIRED__` | Handle mixed collections |
| Merge collections | `__MERGE_COLLECTION__` | Combine multiple collections |
| Match two collections | `__HARMONIZELISTS__` | Ensure same elements in same order |
| Rename elements | `__RELABEL_FROM_FILE__` | Change identifiers via mapping |
| Reorder elements | `__SORTLIST__` | Alphabetic, numeric, or custom order |
| Add tags | `__TAG_FROM_FILE__` | Apply metadata tags |
| Cross product (flat) | `__CROSS_PRODUCT_FLAT__` | All-vs-all comparisons |
| Cross product (nested) | `__CROSS_PRODUCT_NESTED__` | All-vs-all with hierarchy |
| Build list | `__BUILD_LIST__` | Combine datasets into collection |
| Duplicate to collection | `__DUPLICATE_FILE_TO_COLLECTION__` | Replicate dataset N times |

> For detailed tool documentation, see `references/tools.md`.

---

#### Strategy B: Apply Rules (WHEN SIMPLE TOOLS INSUFFICIENT)

Use when you need:
- Complex identifier parsing via regex
- Tag-based restructuring
- Conditional filtering combined with restructuring
- Structure transformations beyond simple tools

**Core Concept:** Collection → Table → Transform → Collection

**Structure:**
```yaml
rules:
  rules:
    - # List of rule operations (applied sequentially)
  mapping:
    - # List of mapping operations (define output structure)
```

> For comprehensive Apply Rules DSL documentation, see `references/apply-rules.md`.

##### Column Addition Rules

| Rule Type | Purpose | Parameters |
|-----------|---------|------------|
| `add_column_metadata` | Extract identifier/index/tags | `value`: `identifier0`, `identifier1`, `index0`, `index1`, `tags` |
| `add_column_group_tag_value` | Extract specific group tag | `value`: tag name, `default_value`: fallback |
| `add_column_regex` | Regex capture/replace | `target_column`, `expression`, `replacement`?, `group_count`?, `allow_unmatched`? |
| `add_column_substr` | Fixed substring | `target_column`, `substr_type`: keep_prefix/suffix or drop_prefix/suffix, `length` |
| `add_column_rownum` | Sequential numbers | `start`: 0 or 1 |
| `add_column_value` | Constant value | `value`: literal string |
| `add_column_concatenate` | Join two columns | `target_column_0`, `target_column_1` |
| `add_column_basename` | Extract filename from path | `target_column` |
| `add_column_from_sample_sheet_index` | Sample sheet column | `value`: column index |

##### Filter Rules

| Rule Type | Purpose | Parameters |
|-----------|---------|------------|
| `add_filter_regex` | Keep/remove by pattern | `target_column`, `expression`, `invert` (false=keep matches, true=remove matches) |
| `add_filter_matches` | Exact value match | `target_column`, `value`, `invert` |
| `add_filter_count` | First/last N rows | `count`, `which`: first/last, `invert` |
| `add_filter_empty` | Remove empty cells | `target_column`, `invert` |
| `add_filter_compare` | Numeric comparison | `target_column`, `value`, `compare_type`: less_than/greater_than/etc. |

##### Structural Rules

| Rule Type | Purpose | Parameters |
|-----------|---------|------------|
| `remove_columns` | Delete columns | `target_columns`: list of indices |
| `sort` | Order rows | `target_column`, `numeric`: true/false |
| `swap_columns` | Exchange positions | `target_column_0`, `target_column_1` |
| `split_columns` | Expand rows (Cartesian) | `target_columns_0`, `target_columns_1` |

##### Mapping Operations (Final Step)

| Mapping Type | Purpose | Parameters |
|--------------|---------|------------|
| `list_identifiers` | Create list structure | `columns`: [0] = list, [0,1] = list:list, [0,1,2] = list:list:list |
| `paired_identifier` | Add paired level | `columns`: single column with forward/reverse/f/r/1/2/R1/R2 |
| `paired_or_unpaired_identifier` | Mixed paired | `columns`: single column |
| `tags` | Apply element tags | `columns`: list of tag value columns |
| `group_tags` | Apply group tags | `columns`: list of columns |

##### Apply Rules Examples

**Example 1: Flatten list:paired with custom identifiers**
```python
rules = {
    "rules": [
        {"type": "add_column_metadata", "value": "identifier0"},
        {"type": "add_column_metadata", "value": "identifier1"},
        {"type": "add_column_concatenate", "target_column_0": 0, "target_column_1": 1}
    ],
    "mapping": [
        {"type": "list_identifiers", "columns": [2]}
    ]
}
```

**Example 2: Parse paired-end RNA-seq filenames**

Files: `sample1_R1.fastq.gz`, `sample1_R2.fastq.gz`

```python
rules = {
    "rules": [
        {"type": "add_column_metadata", "value": "identifier0"},
        {"type": "add_column_regex", "target_column": 0, "expression": "(.+)_R([12])\\.fastq\\.gz", "group_count": 2},
        {"type": "add_column_regex", "target_column": 2, "expression": "1", "replacement": "forward", "allow_unmatched": True},
        {"type": "add_column_regex", "target_column": 2, "expression": "2", "replacement": "reverse", "allow_unmatched": True},
        {"type": "add_column_concatenate", "target_column_0": 3, "target_column_1": 4},
        {"type": "sort", "target_column": 1, "numeric": False},
        {"type": "remove_columns", "target_columns": [0, 2, 3, 4]}
    ],
    "mapping": [
        {"type": "list_identifiers", "columns": [0]},
        {"type": "paired_identifier", "columns": [1]}
    ]
}
```

**Example 3: Group by experimental condition (from tags)**
```python
rules = {
    "rules": [
        {"type": "add_column_metadata", "value": "identifier0"},
        {"type": "add_column_group_tag_value", "value": "condition", "default_value": "unassigned"}
    ],
    "mapping": [
        {"type": "list_identifiers", "columns": [1, 0]},  # Group by condition, then sample
        {"type": "group_tags", "columns": [1]}
    ]
}
```

**Example 4: Filter and sort**
```python
rules = {
    "rules": [
        {"type": "add_column_metadata", "value": "identifier0"},
        {"type": "add_filter_regex", "target_column": 0, "expression": "^control_", "invert": True},
        {"type": "sort", "numeric": False, "target_column": 0}
    ],
    "mapping": [
        {"type": "list_identifiers", "columns": [0]}
    ]
}
```

---

#### Strategy C: Upload Metadata Table (WHEN METADATA MISSING)

Use when required metadata doesn't exist in collection/tags but can be expressed as a simple table.

**Process:**
1. Create tabular file mapping element identifiers to metadata
2. Upload via Fetch API to history
3. Use with `__TAG_FROM_FILE__`, `__RELABEL_FROM_FILE__`, or `__APPLY_RULES__`

**Upload Pattern:**
```python
payload = {
    "history_id": history_id,
    "targets": [{
        "destination": {"type": "hdas"},
        "elements": [{
            "src": "pasted",
            "paste_content": "sample1\ttreated\nsample2\tcontrol\nsample3\ttreated",
            "name": "condition_mapping.tabular",
            "ext": "tabular"
        }]
    }]
}
# POST to /api/tools/fetch
```

**Then tag samples:**
```python
tag_inputs = {
    "input": {"values": [{"src": "hdca", "id": collection_id}]},
    "tags": {"values": [{"src": "hda", "id": metadata_file_id}]},
    "how": "add"
}
# Run __TAG_FROM_FILE__
```

**IMPORTANT:** Inform the user:
> "I've created a metadata mapping file that captures [metadata type]. This mapping is now an input to the analysis. For full reproducibility, ensure this file is included if re-running or sharing the workflow."

---

#### Strategy D: Create Mirror Collection with Tags (LAST RESORT)

Use when:
- Required metadata cannot be represented in a simple table
- Complex conditional metadata based on dataset properties
- Metadata requires the structure of multiple related columns

**IMPORTANT:** Inform the user:
> "The original collection lacked metadata required for this transformation. I've created a new collection with the same datasets but with metadata attached via tags. **For full reproducibility, the analysis should be re-run with this new collection as input** so the metadata association is captured from the start."

---

## API Reference

### Basic Tool Invocation

```python
POST /api/tools
{
    "tool_id": "__TOOL_ID__",
    "history_id": history_id,
    "inputs": { ... }
}
```

### Input Format Patterns

**Simple collection input:**
```python
{"src": "hdca", "id": collection_id}
```

**Collection with values wrapper (REQUIRED for many tools):**
```python
{"values": [{"src": "hdca", "id": collection_id}]}
```

**Dataset input:**
```python
{"src": "hda", "id": dataset_id}
```

**Batch/map-over collection:**
```python
{
    "batch": True,
    "values": [{"src": "hdca", "id": collection_id}]
}
```

**Linked map-over (process corresponding elements):**
```python
{
    "batch": True,
    "linked": True,  # default
    "values": [{"src": "hdca", "id": collection_id}]
}
```

**Unlinked map-over (Cartesian product):**
```python
{
    "batch": True,
    "linked": False,
    "values": [{"src": "hdca", "id": collection_id}]
}
```

**Nested collection mapping (map over inner level):**
```python
{
    "batch": True,
    "values": [{
        "src": "hdca",
        "map_over_type": "paired",  # Specify inner level
        "id": list_paired_collection_id
    }]
}
```

> For complete API reference with all tool examples, see `references/api-patterns.md`.

### Tool-Specific Examples

**FILTER_FROM_FILE:**
```python
inputs = {
    "input": {"values": [{"src": "hdca", "id": collection_id}]},
    "how|how_filter": "remove_if_absent",
    "how|filter_source": {"values": [{"src": "hda", "id": identifier_file_id}]}
}
```

**APPLY_RULES:**
```python
inputs = {
    "input": {"src": "hdca", "id": collection_id},
    "rules": {
        "rules": [...],
        "mapping": [...]
    }
}
```

**RELABEL_FROM_FILE:**
```python
inputs = {
    "input": {"src": "hdca", "id": collection_id},
    "how|how_select": "tabular",
    "how|labels": {"src": "hda", "id": mapping_file_id},
    "how|strict": False
}
```

**TAG_FROM_FILE:**
```python
inputs = {
    "input": {"values": [{"src": "hdca", "id": collection_id}]},
    "tags": {"values": [{"src": "hda", "id": tag_file_id}]},
    "how": "add"
}
```

**SORTLIST:**
```python
inputs = {
    "input": {"src": "hdca", "id": collection_id},
    "sort_type|sort_type": "alpha"  # or "numeric" or "file"
}
```

### Job Completion and Output Retrieval

```python
def wait_for_job_and_get_output(job_id):
    while True:
        # CRITICAL: Use full=true to get output_collections
        job = GET /api/jobs/{job_id}?full=true
        if job["state"] == "ok":
            return job["output_collections"][0]["id"]
        elif job["state"] == "error":
            raise Exception(f"Job failed: {job.get('stderr', 'Unknown error')}")
        time.sleep(2)
```

### Get Collection Details

```python
collection = GET /api/histories/{history_id}/contents/dataset_collections/{collection_id}
# Returns: elements, collection_type, element_count, etc.
```

### Complete Pipeline Example

End-to-end example: Filter → Sort → Relabel a collection.

```python
import requests
import time

GALAXY_URL = "https://usegalaxy.org"
API_KEY = "your_api_key"
HEADERS = {"x-api-key": API_KEY}

def run_tool(tool_id, history_id, inputs):
    """Execute tool and wait for completion."""
    payload = {"tool_id": tool_id, "history_id": history_id, "inputs": inputs}
    response = requests.post(f"{GALAXY_URL}/api/tools", json=payload, headers=HEADERS)
    result = response.json()

    # Wait for all jobs to complete
    for job in result.get("jobs", []):
        wait_for_job(job["id"])

    return result

def wait_for_job(job_id):
    """Poll until terminal state."""
    while True:
        job = requests.get(f"{GALAXY_URL}/api/jobs/{job_id}?full=true", headers=HEADERS).json()
        if job["state"] == "ok":
            return job
        elif job["state"] == "error":
            raise Exception(f"Job failed: {job.get('stderr', '')}")
        time.sleep(2)

# Pipeline: Filter failed → Sort → Relabel
history_id = "abc123"
collection_id = "original_collection"
relabel_file_id = "mapping_file"

# Step 1: Remove failed datasets
result1 = run_tool("__FILTER_FAILED_DATASETS__", history_id, {
    "input": {"src": "hdca", "id": collection_id}
})
filtered_id = result1["output_collections"][0]["id"]

# Step 2: Sort alphabetically
result2 = run_tool("__SORTLIST__", history_id, {
    "input": {"src": "hdca", "id": filtered_id},
    "sort_type|sort_type": "alpha"
})
sorted_id = result2["output_collections"][0]["id"]

# Step 3: Relabel with mapping file
result3 = run_tool("__RELABEL_FROM_FILE__", history_id, {
    "input": {"src": "hdca", "id": sorted_id},
    "how|how_select": "tabular",
    "how|labels": {"src": "hda", "id": relabel_file_id}
})
final_id = result3["output_collections"][0]["id"]

print(f"Pipeline complete: {final_id}")
```

---

## Critical Rules

### NEVER Do These

1. **NEVER manipulate collection metadata directly via API**
   ```python
   # WRONG
   collection = get_collection_details(collection_id)
   filtered = [e for e in collection["elements"] if condition(e)]
   create_new_collection(filtered)
   ```

2. **NEVER create collections ad-hoc without tools** (except Strategy D with explicit warning)

3. **NEVER bypass Galaxy tools for "convenience"**

4. **NEVER forget to explain reproducibility implications**

5. **NEVER use Apply Rules when simple tools suffice**

### ALWAYS Do These

1. **ALWAYS use Galaxy's native tools** via `/api/tools`

2. **ALWAYS use `values` wrapper** for filter/tag tools

3. **ALWAYS use pipe notation** for conditional parameters

4. **ALWAYS use `?full=true`** when getting job outputs for collections

5. **ALWAYS verify output contents** (not just job status)

6. **ALWAYS explain why** the tool-based approach ensures reproducibility

7. **ALWAYS wait for job completion** before proceeding

8. **ALWAYS chain operations through history** (output becomes next input)

---

## Response Template

When responding to a collection transformation request:

### 1. Understanding Phase
"I understand you want to [describe transformation]. Let me assess what metadata is available..."

### 2. Assessment Phase
"Looking at your collection:
- Structure: [list/paired/list:paired/etc.]
- Available metadata: [identifiers/tags/etc.]
- Missing metadata: [if any]"

### 3. Approach Phase
"To accomplish this reproducibly, I'll use [tool name(s)] because [reason]. This ensures:
- All operations captured in Galaxy history
- Can be extracted to a workflow
- Reproducible for future analyses
- Aligns with Galaxy best practices"

### 4. Implementation Phase
[Execute the tools with correct input formats]

### 5. Verification Phase
"I've completed the transformation. To verify:
- Check output collection has [expected element count]
- Confirm element identifiers match [expected pattern]
- Review job details at /api/jobs/{job_id}?full=true"

### 6. Reproducibility Note
- If Strategy A/B: "This operation is fully captured in Galaxy history and can be extracted to a workflow."
- If Strategy C: "A metadata mapping file was created. Include this in any shared workflows."
- If Strategy D: "A new source collection with metadata tags was created. For reproducibility, re-run the analysis with this as input."

---

## Example Interactions

### Example 1: Simple Filtering

**User:** "Remove samples starting with 'control_' from my collection"

**Response:**

I understand you want to filter out control samples. Your collection identifiers contain all necessary metadata.

**Strategy:** Apply Rules (Strategy B) - regex filtering with restructuring

**Tool Invocation:**
```python
inputs = {
    "input": {"src": "hdca", "id": "YOUR_COLLECTION_ID"},
    "rules": {
        "rules": [
            {"type": "add_column_metadata", "value": "identifier0"},
            {"type": "add_filter_regex", "target_column": 0, "expression": "^control_", "invert": True}
        ],
        "mapping": [
            {"type": "list_identifiers", "columns": [0]}
        ]
    }
}
# Run __APPLY_RULES__
```

**Verification:** Output collection should contain only elements NOT starting with "control_".

**Reproducibility:** This operation is fully captured in Galaxy history and can be extracted to a workflow.

---

### Example 2: Filter by Sample List

**User:** "Keep only samples SRR123, SRR456, SRR789 from my collection"

**Response:**

I understand you want to filter to specific samples. I'll use the Filter Collection tool.

**Strategy:** Collection Operation Tool (Strategy A)

**Step 1: Upload identifier file**
```python
upload_payload = {
    "history_id": history_id,
    "targets": [{
        "destination": {"type": "hdas"},
        "elements": [{
            "src": "pasted",
            "paste_content": "SRR123\nSRR456\nSRR789",
            "name": "keep_samples.txt",
            "ext": "txt"
        }]
    }]
}
# POST to /api/tools/fetch, wait for job, get file_id
```

**Step 2: Run filter**
```python
filter_inputs = {
    "input": {"values": [{"src": "hdca", "id": collection_id}]},
    "how|how_filter": "remove_if_absent",
    "how|filter_source": {"values": [{"src": "hda", "id": file_id}]}
}
# Run __FILTER_FROM_FILE__
```

**Verification:** Output collection should have exactly 3 elements.

**Reproducibility:** Both the identifier file and filter operation are captured in history.

---

### Example 3: Group by Treatment Condition

**User:** "Group my samples by treatment condition - I have a spreadsheet with sample → condition mapping"

**Response:**

I understand you want to group samples by condition. The metadata isn't in Galaxy yet.

**Strategy:** Upload Metadata Table (Strategy C) + Apply Rules (Strategy B)

**Step 1: Upload condition mapping**
```python
upload_payload = {
    "history_id": history_id,
    "targets": [{
        "destination": {"type": "hdas"},
        "elements": [{
            "src": "pasted",
            "paste_content": "sample1\tgroup:condition:treated\nsample2\tgroup:condition:control",
            "name": "condition_tags.tabular",
            "ext": "tabular"
        }]
    }]
}
```

**Step 2: Tag samples**
```python
tag_inputs = {
    "input": {"values": [{"src": "hdca", "id": collection_id}]},
    "tags": {"values": [{"src": "hda", "id": tag_file_id}]},
    "how": "add"
}
# Run __TAG_FROM_FILE__
```

**Step 3: Reorganize by condition**
```python
rules_inputs = {
    "input": {"src": "hdca", "id": tagged_collection_id},
    "rules": {
        "rules": [
            {"type": "add_column_metadata", "value": "identifier0"},
            {"type": "add_column_group_tag_value", "value": "condition", "default_value": "unassigned"}
        ],
        "mapping": [
            {"type": "list_identifiers", "columns": [1, 0]},  # Group by condition, then sample
            {"type": "group_tags", "columns": [1]}
        ]
    }
}
# Run __APPLY_RULES__
```

**Verification:** Output should be list:list grouped by condition.

**Reproducibility:** Keep the condition_tags.tabular file with your analysis. Anyone reproducing this needs both the original collection and this metadata file.

---

## Tool Selection Priority

1. **First:** Try simple dedicated tools (faster, clearer intent)
2. **Second:** Chain multiple simple tools (each step visible in history)
3. **Third:** Use Apply Rules (most powerful, steeper learning curve)

> For real test patterns showing tool usage, see `references/test-patterns.md`.

---

## Working with Tags

Tags are powerful metadata carriers:
- **Simple tags:** For finding/organizing datasets
- **Name tags (`name:` or `#`):** Propagate through analysis
- **Group tags (`group:name:value`):** For grouping operations

Prefer using tags + Apply Rules over creating multiple collections.

---

**Remember:** The goal is reproducible science. Every operation should be traceable, reusable, and workflow-compatible. Galaxy's tools make this possible - use them!
