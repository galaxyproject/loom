# Galaxy Tools API Research

## Context

This document describes the Galaxy Tools API and demonstrates how to invoke collection operation tools programmatically. Per project goals, **Claude should recommend using Galaxy's native collection operation tools through the API** rather than implementing custom collection manipulation logic, ensuring reproducibility and workflow compatibility.

## API Endpoint

**Primary tool execution endpoint:** `POST /api/tools`

## Tool Invocation Structure

### Basic Payload Format

```python
{
    "tool_id": "tool_identifier",
    "inputs": {
        # JSON-encoded tool inputs
    },
    "history_id": "history_id_string"
}
```

### Complete Payload Options

```python
{
    "tool_id": "tool_identifier",          # Required (unless tool_uuid provided)
    "tool_uuid": "uuid",                    # Alternative to tool_id
    "tool_version": "1.0.0",                # Optional: specify tool version
    "inputs": {                             # Required: tool-specific parameters
        # ... input parameters ...
    },
    "history_id": "history_id_string",      # Required: target history
    "input_format": "legacy",               # Optional: "legacy" (default) or "21.01"
    "use_cached_job": false,                # Optional: reuse existing job results
    "__tags": ["#tag1", "#tag2"]            # Optional: tags to apply to outputs
}
```

**Key Point:** The `inputs` field is JSON-encoded when sent via API (as a string), but the structure is a nested dictionary.

## Collection Input Formats

### Dataset Collection Input Structure

Collections are referenced using a source/ID structure:

```python
{
    "src": "hdca",  # History Dataset Collection Association
    "id": "collection_id_string"
}
```

### Single Dataset Input

```python
{
    "src": "hda",   # History Dataset Association
    "id": "dataset_id_string"
}
```

### Example: Simple Collection Input

```python
inputs = {
    "input": {
        "src": "hdca",
        "id": "f2db41e1fa331b3e"
    }
}
```

## Collection Operation Tool Examples

### 1. Unzip Collection (`__UNZIP_COLLECTION__`)

**Purpose:** Split paired collection into forward/reverse lists

```python
payload = {
    "tool_id": "__UNZIP_COLLECTION__",
    "history_id": "abc123",
    "inputs": {
        "input": {
            "src": "hdca",
            "id": "paired_collection_id"
        }
    }
}

response = requests.post(f"{galaxy_url}/api/tools", json=payload, headers=headers)
```

**Response Structure:**
```python
{
    "outputs": [
        {
            "id": "forward_collection_id",
            "name": "forward",
            # ... dataset details
        },
        {
            "id": "reverse_collection_id",
            "name": "reverse",
            # ... dataset details
        }
    ],
    "jobs": [
        {
            "id": "job_id",
            # ... job details
        }
    ]
}
```

---

### 2. Zip Collections (`__ZIP_COLLECTION__`)

**Purpose:** Combine two datasets/collections into paired collection

```python
payload = {
    "tool_id": "__ZIP_COLLECTION__",
    "history_id": "abc123",
    "inputs": {
        "input_forward": {
            "src": "hda",  # or "hdca" for collection
            "id": "forward_dataset_id"
        },
        "input_reverse": {
            "src": "hda",  # or "hdca" for collection
            "id": "reverse_dataset_id"
        }
    }
}
```

**Response Structure:**
```python
{
    "output_collections": [
        {
            "id": "paired_collection_id",
            "hid": 5,
            "collection_type": "paired",
            # ... collection details
        }
    ],
    "jobs": [ ... ]
}
```

---

### 3. Filter Collection (`__FILTER_FROM_FILE__`)

**Purpose:** Filter collection elements using identifier file

```python
payload = {
    "tool_id": "__FILTER_FROM_FILE__",
    "history_id": "abc123",
    "inputs": {
        "input": {
            "src": "hdca",
            "id": "collection_id"
        },
        "how": {
            "how_filter": "remove_if_absent",  # or "remove_if_present"
            "filter_source": {
                "src": "hda",
                "id": "identifier_file_id"
            }
        }
    }
}
```

**Response Structure:**
```python
{
    "output_collections": [
        {
            "name": "output_filtered",
            # ... filtered collection
        },
        {
            "name": "output_discarded",
            # ... discarded elements
        }
    ],
    "jobs": [ ... ]
}
```

---

### 4. Flatten Collection (`__FLATTEN__`)

**Purpose:** Flatten nested collection to simple list

```python
payload = {
    "tool_id": "__FLATTEN__",
    "history_id": "abc123",
    "inputs": {
        "input": {
            "src": "hdca",
            "id": "nested_collection_id"
        },
        "join_identifier": "_"  # String to join identifier levels
    }
}
```

---

### 5. Relabel Identifiers (`__RELABEL_FROM_FILE__`)

**Purpose:** Rename collection elements using mapping file

```python
payload = {
    "tool_id": "__RELABEL_FROM_FILE__",
    "history_id": "abc123",
    "inputs": {
        "input": {
            "src": "hdca",
            "id": "collection_id"
        },
        "how": {
            "how_select": "tabular",  # or "txt" or "tabular_extended"
            "labels": {
                "src": "hda",
                "id": "mapping_file_id"
            },
            "strict": False  # Optional: enforce exact matching
        }
    }
}
```

---

### 6. Sort Collection (`__SORTLIST__`)

**Purpose:** Sort collection elements

```python
payload = {
    "tool_id": "__SORTLIST__",
    "history_id": "abc123",
    "inputs": {
        "input": {
            "src": "hdca",
            "id": "collection_id"
        },
        "sort_type": {
            "sort_type": "alpha"  # or "numeric" or "file"
            # If "file":
            # "sort_file": {"src": "hda", "id": "sort_order_file_id"}
        }
    }
}
```

---

### 7. Merge Collections (`__MERGE_COLLECTION__`)

**Purpose:** Merge multiple collections into one

```python
payload = {
    "tool_id": "__MERGE_COLLECTION__",
    "history_id": "abc123",
    "inputs": {
        "inputs_0|input": {
            "src": "hdca",
            "id": "collection1_id"
        },
        "inputs_1|input": {
            "src": "hdca",
            "id": "collection2_id"
        },
        "advanced": {
            "conflict": {
                "duplicate_options": "keep_first",  # or other options
                "suffix_pattern": "_#"  # for suffix modes
            }
        }
    }
}
```

---

### 8. Build List (`__BUILD_LIST__`)

**Purpose:** Build list collection from datasets

```python
payload = {
    "tool_id": "__BUILD_LIST__",
    "history_id": "abc123",
    "inputs": {
        "datasets_0|input": {
            "src": "hda",
            "id": "dataset1_id"
        },
        "datasets_1|input": {
            "src": "hda",
            "id": "dataset2_id"
        }
    }
}
```

---

### 9. Extract Dataset (`__EXTRACT_DATASET__`)

**Purpose:** Extract single dataset from collection

```python
payload = {
    "tool_id": "__EXTRACT_DATASET__",
    "history_id": "abc123",
    "inputs": {
        "input": {
            "src": "hdca",
            "id": "collection_id"
        },
        "which": {
            "which_dataset": "by_identifier",  # or "first" or "by_index"
            "identifier": "element_name"  # if by_identifier
            # "index": 0  # if by_index
        }
    }
}
```

---

### 10. Filter Empty/Failed Datasets

**Filter Empty:**
```python
payload = {
    "tool_id": "__FILTER_EMPTY_DATASETS__",
    "history_id": "abc123",
    "inputs": {
        "input": {
            "src": "hdca",
            "id": "collection_id"
        }
    }
}
```

**Filter Failed:**
```python
payload = {
    "tool_id": "__FILTER_FAILED_DATASETS__",
    "history_id": "abc123",
    "inputs": {
        "input": {
            "src": "hdca",
            "id": "collection_id"
        },
        "replacement": {  # Optional
            "src": "hda",
            "id": "replacement_dataset_id"
        }
    }
}
```

---

### 11. Apply Rules (`__APPLY_RULES__`)

**Purpose:** Advanced collection restructuring

```python
payload = {
    "tool_id": "__APPLY_RULES__",
    "history_id": "abc123",
    "inputs": {
        "input": {
            "src": "hdca",
            "id": "collection_id"
        },
        "rules": {
            # Complex rules structure (JSON rule definition)
            # See references/apply-rules.md for rule builder syntax
        }
    }
}
```

**Note:** Apply Rules typically requires interactive rule building. Rules can be exported as JSON and reused programmatically.

---

## Advanced Collection Operations

### Map-Over Behavior (Batch Processing)

When tools process collections element-by-element, use the batch flag:

```python
inputs = {
    "input1": {
        "batch": True,
        "values": [
            {
                "src": "hdca",
                "id": "collection_id"
            }
        ]
    }
}
```

**Result:** Tool runs once per collection element, creating implicit output collection.

---

### Map-Over Multiple Collections (Linked)

Process two collections together, element-by-element:

```python
inputs = {
    "input1": {
        "batch": True,
        "values": [
            {"src": "hdca", "id": "collection1_id"}
        ]
    },
    "input2": {
        "batch": True,
        "values": [
            {"src": "hdca", "id": "collection2_id"}
        ]
    }
}
```

**Result:** Corresponding elements processed together (forward with forward, reverse with reverse).

---

### Map-Over Multiple Collections (Unlinked)

Process all combinations of elements from two collections:

```python
inputs = {
    "input1": {
        "batch": True,
        "linked": False,
        "values": [
            {"src": "hdca", "id": "collection1_id"}
        ]
    },
    "input2": {
        "batch": True,
        "linked": False,
        "values": [
            {"src": "hdca", "id": "collection2_id"}
        ]
    }
}
```

**Result:** Cartesian product - all pairs processed (collection1[0] with collection2[0], collection1[0] with collection2[1], etc.).

**Alternative:** Use `__CROSS_PRODUCT_FLAT__` tool for explicit all-vs-all comparisons.

---

### Map-Over Nested Collections

For nested collections (e.g., list:paired), specify which level to map over:

```python
inputs = {
    "input": {
        "batch": True,
        "values": [
            {
                "src": "hdca",
                "map_over_type": "paired",  # Map over paired level
                "id": "nested_collection_id"
            }
        ]
    }
}
```

---

## Response Structure

### Successful Tool Execution

```python
{
    "id": "invocation_id",
    "model_class": "WorkflowInvocation",
    "outputs": [
        {
            "id": "output_dataset_id",
            "hid": 10,
            "name": "Output name",
            "history_id": "abc123",
            # ... dataset details
        }
    ],
    "output_collections": [
        {
            "id": "output_collection_id",
            "hid": 11,
            "name": "Collection name",
            "collection_type": "list",
            "history_id": "abc123",
            # ... collection details
        }
    ],
    "jobs": [
        {
            "id": "job_id",
            "tool_id": "tool_id",
            "state": "new",
            # ... job details
        }
    ],
    "implicit_collections": [
        {
            "id": "implicit_collection_id",
            "hid": 12,
            "name": "Implicit collection name",
            # ... created by map-over operations
        }
    ]
}
```

### Key Response Fields

- **`outputs`**: Individual dataset outputs
- **`output_collections`**: Explicitly created collection outputs
- **`jobs`**: Job records for execution tracking
- **`implicit_collections`**: Collections created by map-over/batch operations

---

## Error Handling

### Common Error Responses

**Permission Denied:**
```python
{
    "err_msg": "User does not have permission to access dataset.",
    "err_code": 403003
}
```

**Invalid Parameters:**
```python
{
    "err_msg": "Tool parameter validation failed.",
    "err_code": 400001
}
```

**Tool Not Found:**
```python
{
    "err_msg": "Tool not found: tool_id",
    "err_code": 404001
}
```

---

## Input Format Versions

### Legacy Format (Default)

Inputs nested in conditionals/repeats use pipe notation:

```python
{
    "conditional_name|input_name": value,
    "repeat_0|input_name": value,
    "repeat_1|input_name": value
}
```

### 21.01 Format

Inputs nested in conditionals/repeats are nested objects:

```python
{
    "conditional_name": {
        "input_name": value
    },
    "repeat": [
        {"input_name": value},
        {"input_name": value}
    ]
}
```

Specify format in payload:
```python
{
    "input_format": "21.01",
    # ...
}
```

---

## Best Practices for API-Based Collection Operations

### 1. Always Use Collection Operation Tools

**Don't do this:**
```python
# Fetch collection metadata via API
collection = get_collection_details(collection_id)

# Manipulate in Python
filtered_elements = [e for e in collection["elements"] if condition(e)]

# Create new collection via API
create_new_collection(filtered_elements)
```

**Do this:**
```python
# Use Filter from File tool
create_identifier_file(identifiers_to_keep)
payload = {
    "tool_id": "__FILTER_FROM_FILE__",
    "inputs": {
        "input": {"src": "hdca", "id": collection_id},
        "how": {
            "how_filter": "remove_if_absent",
            "filter_source": {"src": "hda", "id": identifier_file_id}
        }
    }
}
```

**Why:** Tool-based operations are:
- Reproducible (captured in history)
- Workflow-compatible (can be extracted)
- Tested and validated
- Properly handle edge cases

---

### 2. Chain Operations Through History

Operations naturally flow through history:

```python
# Step 1: Filter collection
filter_result = execute_tool("__FILTER_FROM_FILE__", ...)
filtered_collection_id = filter_result["output_collections"][0]["id"]

# Step 2: Sort filtered collection
sort_result = execute_tool("__SORTLIST__", {
    "input": {"src": "hdca", "id": filtered_collection_id},
    # ...
})
```

**Benefit:** Complete audit trail in Galaxy history.

---

### 3. Wait for Job Completion

Jobs execute asynchronously. Poll job status:

```python
def wait_for_job(job_id):
    while True:
        response = requests.get(f"{galaxy_url}/api/jobs/{job_id}")
        job = response.json()
        if job["state"] in ["ok", "error"]:
            return job
        time.sleep(2)

result = execute_tool(...)
for job in result["jobs"]:
    wait_for_job(job["id"])
```

---

### 4. Use Appropriate Tools for Operations

**Filtering:**
- Simple: `__FILTER_EMPTY_DATASETS__`, `__FILTER_FAILED_DATASETS__`
- By identifiers: `__FILTER_FROM_FILE__`
- Single element: `__EXTRACT_DATASET__`

**Restructuring:**
- Flatten: `__FLATTEN__`
- Nest: `__NEST__`
- Zip/Unzip: `__ZIP_COLLECTION__`, `__UNZIP_COLLECTION__`
- Complex: `__APPLY_RULES__`

**Organization:**
- Rename: `__RELABEL_FROM_FILE__`
- Sort: `__SORTLIST__`
- Merge: `__MERGE_COLLECTION__`

---

### 5. Leverage Map-Over for Batch Processing

Instead of iterating in code:

```python
# Process collection elements automatically
payload = {
    "tool_id": "analysis_tool",
    "inputs": {
        "input": {
            "batch": True,
            "values": [{"src": "hdca", "id": collection_id}]
        }
    }
}
```

Galaxy handles parallelization and creates output collection automatically.

---

## Complete Example: Multi-Step Collection Pipeline

```python
import requests
import time

galaxy_url = "https://usegalaxy.org"
api_key = "your_api_key"
headers = {"x-api-key": api_key}

def execute_tool(tool_id, history_id, inputs):
    """Execute tool and wait for completion"""
    payload = {
        "tool_id": tool_id,
        "history_id": history_id,
        "inputs": inputs
    }
    response = requests.post(
        f"{galaxy_url}/api/tools",
        json=payload,
        headers=headers
    )
    result = response.json()

    # Wait for jobs
    for job in result["jobs"]:
        wait_for_job(job["id"])

    return result

def wait_for_job(job_id):
    """Poll job until complete"""
    while True:
        response = requests.get(
            f"{galaxy_url}/api/jobs/{job_id}",
            headers=headers
        )
        job = response.json()
        if job["state"] == "ok":
            return True
        elif job["state"] == "error":
            raise Exception(f"Job {job_id} failed")
        time.sleep(2)

# Pipeline: Filter → Sort → Relabel
history_id = "abc123"
collection_id = "original_collection"

# Step 1: Filter failed datasets
result1 = execute_tool(
    "__FILTER_FAILED_DATASETS__",
    history_id,
    {"input": {"src": "hdca", "id": collection_id}}
)
filtered_id = result1["output_collections"][0]["id"]

# Step 2: Sort alphabetically
result2 = execute_tool(
    "__SORTLIST__",
    history_id,
    {
        "input": {"src": "hdca", "id": filtered_id},
        "sort_type": {"sort_type": "alpha"}
    }
)
sorted_id = result2["output_collections"][0]["id"]

# Step 3: Relabel with mapping file
mapping_file_id = "uploaded_mapping_file"
result3 = execute_tool(
    "__RELABEL_FROM_FILE__",
    history_id,
    {
        "input": {"src": "hdca", "id": sorted_id},
        "how": {
            "how_select": "tabular",
            "labels": {"src": "hda", "id": mapping_file_id}
        }
    }
)

final_collection_id = result3["output_collections"][0]["id"]
print(f"Pipeline complete. Final collection: {final_collection_id}")
```

---

## Why API Tool Invocation Over Direct Manipulation

### Reproducibility

**Direct API manipulation:**
- Operations lost after execution
- Cannot recreate analysis
- No audit trail

**Tool-based approach:**
- All operations in history
- Complete provenance tracking
- Re-executable

### Workflow Compatibility

**Direct API manipulation:**
- Cannot extract to workflow
- Not shareable

**Tool-based approach:**
- Workflow-extractable
- Shareable with community
- Published methods remain executable

### Reliability

**Direct API manipulation:**
- Custom logic may have bugs
- Edge cases not handled
- No validation

**Tool-based approach:**
- Tested and validated
- Handles edge cases
- Built-in validation

---

## Summary: The Galaxy API Way

When working with collections via API:

1. **Identify the operation needed** (filter, sort, merge, etc.)
2. **Select appropriate collection operation tool** (see `references/tools.md`)
3. **Construct tool payload** with collection references
4. **Execute via POST /api/tools**
5. **Use output collection ID** for next operation

**Result:** Reproducible, workflow-compatible, shareable collection operations that align with Galaxy best practices.

---

## Additional Resources

- **Tool Catalog:** See `references/tools.md` for complete list of collection operation tools
- **Apply Rules DSL:** See `references/apply-rules.md` for rule builder syntax
- **Galaxy API Documentation:** https://docs.galaxyproject.org/en/master/api_doc.html
- **BioBlend Library:** https://bioblend.readthedocs.io/ (Python wrapper for Galaxy API)

---

## Quick Reference: Common Tool IDs

| Operation | Tool ID |
|-----------|---------|
| Filter by file | `__FILTER_FROM_FILE__` |
| Filter empty | `__FILTER_EMPTY_DATASETS__` |
| Filter failed | `__FILTER_FAILED_DATASETS__` |
| Keep success | `__KEEP_SUCCESS_DATASETS__` |
| Extract dataset | `__EXTRACT_DATASET__` |
| Flatten | `__FLATTEN__` |
| Zip | `__ZIP_COLLECTION__` |
| Unzip | `__UNZIP_COLLECTION__` |
| Nest | `__NEST__` |
| Build list | `__BUILD_LIST__` |
| Merge | `__MERGE_COLLECTION__` |
| Relabel | `__RELABEL_FROM_FILE__` |
| Sort | `__SORTLIST__` |
| Tag | `__TAG_FROM_FILE__` |
| Apply rules | `__APPLY_RULES__` |
| Cross product | `__CROSS_PRODUCT_FLAT__` |
| Duplicate | `__DUPLICATE_FILE_TO_COLLECTION__` |
