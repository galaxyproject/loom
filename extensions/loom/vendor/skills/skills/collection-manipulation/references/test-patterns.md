# Galaxy Collection Operation Tests Research

## Context

This document analyzes real test examples from Galaxy's test suite to demonstrate collection operation patterns, best practices, and real-world usage. These tests show how Galaxy's native tools should be used for reproducible, workflow-compatible collection operations.

**Source:** `lib/galaxy_test/api/test_tools.py`, `lib/galaxy_test/api/test_workflows.py`, `lib/galaxy_test/base/rules_test_data.py`

## Test-Based Usage Patterns

### 1. Building Collections for Testing

#### Creating Paired Collections

```python
def _build_pair(history_id, contents):
    """Create a paired collection from content list"""
    create_response = dataset_collection_populator.create_pair_in_history(
        history_id,
        contents=contents,        # e.g., ["123", "456"]
        direct_upload=True,
        wait=True
    )
    hdca_id = create_response.json()["outputs"][0]["id"]
    return hdca_id

# Usage
hdca_id = _build_pair(history_id, ["123\n", "456\n"])
```

**Result:** Creates paired collection with `forward` and `reverse` elements.

---

#### Creating List Collections

```python
create_response = dataset_collection_populator.create_list_in_history(
    history_id,
    contents=["a\nb\nc\nd", "e\nf\ng\nh"],
    wait=True
)
hdca_id = create_response.json()["outputs"][0]["id"]
```

---

#### Creating Nested List (list:paired)

```python
hdca_list_id = dataset_collection_populator.example_list_of_pairs(history_id)
```

**Structure:**
```
list:paired
├── element1 (paired)
│   ├── forward
│   └── reverse
└── element2 (paired)
    ├── forward
    └── reverse
```

---

### 2. Collection Operation Tool Tests

#### Test: Unzip Collection

**Purpose:** Split paired collection into two separate lists

```python
def test_unzip_collection():
    # Create paired collection
    hdca_id = _build_pair(history_id, ["123", "456"])

    # Unzip it
    inputs = {
        "input": {"src": "hdca", "id": hdca_id}
    }
    response = _run("__UNZIP_COLLECTION__", history_id, inputs, assert_ok=True)

    # Verify outputs
    outputs = response["outputs"]
    assert len(outputs) == 2
    output_forward = outputs[0]
    output_reverse = outputs[1]

    # Check content
    forward_content = get_history_dataset_content(history_id, dataset=output_forward)
    reverse_content = get_history_dataset_content(history_id, dataset=output_reverse)
    assert forward_content.strip() == "123"
    assert reverse_content.strip() == "456"
```

**Key Insights:**
- Unzip produces 2 dataset outputs (not collections)
- Each output is a separate list collection
- Content preserved from original paired elements

---

#### Test: Zip Collections

**Purpose:** Combine two datasets/collections into paired structure

```python
def test_zip_inputs():
    # Create two datasets
    hda1 = dataset_to_param(new_dataset(history_id, content="1\t2\t3"))
    hda2 = dataset_to_param(new_dataset(history_id, content="4\t5\t6"))

    # Zip them
    inputs = {
        "input_forward": hda1,
        "input_reverse": hda2
    }
    response = _run("__ZIP_COLLECTION__", history_id, inputs, assert_ok=True)

    # Verify output
    output_collections = response["output_collections"]
    assert len(output_collections) == 1

    zipped_hdca = get_history_collection_details(
        history_id,
        hid=output_collections[0]["hid"]
    )
    assert zipped_hdca["collection_type"] == "paired"
```

**Key Insights:**
- Zip creates a single paired collection output
- Can zip datasets or collections
- Result has `collection_type == "paired"`

---

#### Test: Filter Collection from File

**Purpose:** Filter collection elements using identifier list

```python
def test_filter_from_file():
    # Setup: Collection [A, B, X] and filter file [A, B, Z]
    collection_id = create_list_collection(["A", "B", "X"])
    filter_file_id = upload_text_file("A\nB\nZ")

    inputs = {
        "input": {"src": "hdca", "id": collection_id},
        "how": {
            "how_filter": "remove_if_absent",
            "filter_source": {"src": "hda", "id": filter_file_id}
        }
    }
    response = _run("__FILTER_FROM_FILE__", history_id, inputs)

    # Result: TWO output collections
    output_collections = response["output_collections"]
    filtered = output_collections[0]    # Contains A, B
    discarded = output_collections[1]   # Contains X
```

**Key Insights:**
- Filter produces TWO collections (filtered + discarded)
- Identifiers in file not matching collection are ignored (Z)
- `remove_if_absent`: keep only items IN file
- `remove_if_present`: keep only items NOT IN file

---

### 3. Map-Over Patterns (Batch Processing)

#### Test: Simple Map-Over

**Purpose:** Run tool on each collection element

```python
def test_collection_parameter():
    hdca_id = _build_pair(history_id, ["123\n", "456\n"])

    inputs = {
        "input1": {
            "batch": True,
            "values": [{"src": "hdca", "id": hdca_id}]
        }
    }
    output = _run("some_tool", history_id, inputs, assert_ok=True)

    # Results
    assert len(output["jobs"]) == 2  # One job per element
    assert len(output["implicit_collections"]) == 1  # Output collection created
```

**Key Insights:**
- `"batch": True` enables map-over
- Creates one job per collection element
- Automatically creates output collection
- `implicit_collections` contains results

---

#### Test: Map-Over Two Collections (Linked)

**Purpose:** Process two collections element-by-element in parallel

```python
def test_map_over_two_collections():
    hdca1_id = _build_pair(history_id, ["123\n", "456\n"])
    hdca2_id = _build_pair(history_id, ["789\n", "0ab\n"])

    inputs = {
        "input1": {
            "batch": True,
            "values": [{"src": "hdca", "id": hdca1_id}]
        },
        "queries_0|input2": {
            "batch": True,
            "values": [{"src": "hdca", "id": hdca2_id}]
        }
    }
    response = _run("cat1", history_id, inputs)

    outputs = response["outputs"]
    assert len(outputs) == 2
    # Output1: forward1 + forward2 (123\n789)
    # Output2: reverse1 + reverse2 (456\n0ab)
```

**Key Insights:**
- Both inputs have `"batch": True`
- Default is **linked** mapping
- Matching identifiers processed together
- forward[0] with forward[0], reverse[0] with reverse[0]

---

#### Test: Map-Over Two Collections (Unlinked)

**Purpose:** Process all combinations (Cartesian product)

```python
def test_map_over_two_collections_unlinked():
    hdca1_id = _build_pair(history_id, ["123\n", "456\n"])
    hdca2_id = _build_pair(history_id, ["789\n", "0ab\n"])

    inputs = {
        "input1": {
            "batch": True,
            "linked": False,  # KEY DIFFERENCE
            "values": [{"src": "hdca", "id": hdca1_id}]
        },
        "queries_0|input2": {
            "batch": True,
            "linked": False,  # KEY DIFFERENCE
            "values": [{"src": "hdca", "id": hdca2_id}]
        }
    }
    response = _run("cat1", history_id, inputs)

    outputs = response["outputs"]
    assert len(outputs) == 4  # 2 x 2 = 4 combinations

    implicit_collection = response["implicit_collections"][0]
    assert implicit_collection["collection_type"] == "paired:paired"
```

**Key Insights:**
- `"linked": False` creates Cartesian product
- 2-element collections = 4 jobs (2x2)
- Output structure: `paired:paired`
- All combinations processed

**Alternative:** Use `__CROSS_PRODUCT_FLAT__` tool explicitly.

---

#### Test: Map-Over Nested Collections

**Purpose:** Process specific nesting level

```python
def test_unzip_nested():
    # Create list:paired collection
    response = upload_collection(
        history_id,
        "list:paired",
        elements=[{
            "name": "test0",
            "elements": [
                {"src": "pasted", "paste_content": "123\n",
                 "name": "forward", "ext": "txt"},
                {"src": "pasted", "paste_content": "456\n",
                 "name": "reverse", "ext": "txt"}
            ]
        }]
    )
    hdca_id = response.json()["outputs"][0]["id"]

    inputs = {
        "input": {
            "batch": True,
            "values": [{
                "src": "hdca",
                "map_over_type": "paired",  # SPECIFY LEVEL
                "id": hdca_id
            }]
        }
    }
    response = _run("__UNZIP_COLLECTION__", history_id, inputs)

    implicit_collections = response["implicit_collections"]
    assert len(implicit_collections) == 2  # Forward and reverse collections
```

**Key Insights:**
- `"map_over_type": "paired"` specifies which level to map over
- For `list:paired`, maps over the `paired` level
- Creates appropriate nested output structure

---

#### Test: Subcollection Mapping

**Purpose:** Map over inner collection level

```python
def test_subcollection_mapping():
    hdca_list_id = __build_nested_list(history_id)  # list:paired

    inputs = {
        "f1": {
            "batch": True,
            "values": [{
                "src": "hdca",
                "map_over_type": "paired",
                "id": hdca_list_id
            }]
        }
    }
    outputs = _run_and_get_outputs("collection_paired_test", history_id, inputs)

    # Tool processes each paired sub-collection
    assert len(outputs) == 2  # One output per list element
```

**Key Insights:**
- Subcollection mapping processes inner collections as units
- `map_over_type` determines processing level
- Useful for hierarchical data structures

---

### 4. Apply Rules Examples

#### Example 1: Simple List Preservation

**Purpose:** Maintain list structure (identity operation)

```python
rules = {
    "rules": [
        {
            "type": "add_column_metadata",
            "value": "identifier0"  # Add identifier column
        }
    ],
    "mapping": [
        {
            "type": "list_identifiers",
            "columns": [0]  # Use column 0 for identifiers
        }
    ]
}

inputs = {
    "input": {"src": "hdca", "id": collection_id},
    "rules": rules
}
```

**Input:** `list [i1, i2]`
**Output:** `list [i1, i2]` (same structure)

**Rule Explanation:**
- `add_column_metadata` with `identifier0`: Add column containing element identifiers
- `list_identifiers` with `columns: [0]`: Create list using values from column 0

---

#### Example 2: Nest List -> List:List

**Purpose:** Add nesting level to collection

```python
rules = {
    "rules": [
        {
            "type": "add_column_metadata",
            "value": "identifier0"
        },
        {
            "type": "add_column_metadata",
            "value": "identifier0"  # Duplicate for nesting
        }
    ],
    "mapping": [
        {
            "type": "list_identifiers",
            "columns": [0, 1]  # TWO columns = nested structure
        }
    ]
}
```

**Input:** `list [i1, i2]`
**Output:** `list:list [[i1], [i2]]`

**Rule Explanation:**
- Two `add_column_metadata` calls create two identifier columns
- `list_identifiers` with `columns: [0, 1]` creates two-level nesting
- Column 0 = outer identifier, Column 1 = inner identifier

---

#### Example 3: Flatten List:Paired -> List

**Purpose:** Flatten nested collection with custom identifiers

```python
rules = {
    "rules": [
        {
            "type": "add_column_metadata",
            "value": "identifier0"  # Outer identifier (test0)
        },
        {
            "type": "add_column_metadata",
            "value": "identifier1"  # Inner identifier (forward/reverse)
        },
        {
            "type": "add_column_concatenate",
            "target_column_0": 0,
            "target_column_1": 1  # Concatenate: "test0" + "forward"
        }
    ],
    "mapping": [
        {
            "type": "list_identifiers",
            "columns": [2]  # Use concatenated column
        }
    ]
}
```

**Input:** `list:paired [test0 -> {forward, reverse}]`
**Output:** `list [test0forward, test0reverse]`

**Rule Explanation:**
- Get outer and inner identifiers
- Concatenate them (column 2 = column 0 + column 1)
- Create flat list using concatenated identifiers

---

#### Example 4: Nest with Group Tags

**Purpose:** Group elements by tag metadata

```python
rules = {
    "rules": [
        {
            "type": "add_column_metadata",
            "value": "identifier0"
        },
        {
            "type": "add_column_group_tag_value",
            "value": "type",           # Extract "type" from "group:type:X"
            "default_value": "unused"
        }
    ],
    "mapping": [
        {
            "type": "list_identifiers",
            "columns": [1, 0]  # Group by tag value, then identifier
        }
    ]
}
```

**Input:**
```
list [
    i1 (tags: ["group:type:single"]),
    i2 (tags: ["group:type:paired"]),
    i3 (tags: ["group:type:paired"])
]
```

**Output:**
```
list:list [
    single -> [i1],
    paired -> [i2, i3]
]
```

**Rule Explanation:**
- Extract group tag value from metadata
- Use tag value as outer identifier
- Original identifiers become inner identifiers
- Groups elements by tag

---

#### Example 5: Extract and Apply Tags

**Purpose:** Extract tags from metadata and apply to reorganized collection

```python
rules = {
    "rules": [
        {
            "type": "add_column_metadata",
            "value": "identifier0"
        },
        {
            "type": "add_column_group_tag_value",
            "value": "type",
            "default_value": "unused"
        }
    ],
    "mapping": [
        {
            "type": "list_identifiers",
            "columns": [1, 0]
        },
        {
            "type": "group_tags",
            "columns": [1]  # Apply group tags from column 1
        },
        {
            "type": "tags",
            "columns": [0]  # Apply regular tags from column 0
        }
    ]
}
```

**Input:** Same as Example 4
**Output:** Same structure, but with tags applied to elements

**Rule Explanation:**
- Reorganize by tags (like Example 4)
- `group_tags` mapping: Apply group tags to elements
- `tags` mapping: Apply element-level tags
- Tags preserved through reorganization

---

#### Example 6: Preserve Existing Tags

**Purpose:** Maintain tags while restructuring

```python
rules = {
    "rules": [
        {
            "type": "add_column_metadata",
            "value": "identifier0"
        },
        {
            "type": "add_column_metadata",
            "value": "tags"  # Get all tags
        }
    ],
    "mapping": [
        {
            "type": "list_identifiers",
            "columns": [0]
        },
        {
            "type": "tags",
            "columns": [1]  # Reapply tags
        }
    ]
}
```

**Input:** List with tagged elements
**Output:** Same list with all tags preserved

**Rule Explanation:**
- Extract tags to column
- Recreate same structure
- Reapply tags from column
- Ensures tags not lost during operations

---

#### Example 7: Flatten Using Indices

**Purpose:** Create identifiers from positional indices

```python
rules = {
    "rules": [
        {
            "type": "add_column_metadata",
            "value": "index0"  # Outer index (0)
        },
        {
            "type": "add_column_value",
            "value": "_"  # Separator
        },
        {
            "type": "add_column_metadata",
            "value": "index1"  # Inner index (0, 1)
        },
        {
            "type": "add_column_concatenate",
            "target_column_0": 0,
            "target_column_1": 1  # "0" + "_"
        },
        {
            "type": "add_column_concatenate",
            "target_column_0": 3,
            "target_column_1": 2  # "0_" + "0" = "0_0"
        }
    ],
    "mapping": [
        {
            "type": "list_identifiers",
            "columns": [4]
        }
    ]
}
```

**Input:** `list:paired [test0 -> {forward, reverse}]`
**Output:** `list [0_0, 0_1]`

**Rule Explanation:**
- Use positional indices instead of names
- Concatenate with custom separator
- Useful for purely numerical identifiers

---

### 5. Common Rule Operations

#### Rule Types Reference

**Metadata Operations:**
```python
# Extract identifier at level N
{"type": "add_column_metadata", "value": "identifier0"}  # Level 0 (outermost)
{"type": "add_column_metadata", "value": "identifier1"}  # Level 1
{"type": "add_column_metadata", "value": "identifier2"}  # Level 2

# Extract index at level N
{"type": "add_column_metadata", "value": "index0"}
{"type": "add_column_metadata", "value": "index1"}

# Extract tags
{"type": "add_column_metadata", "value": "tags"}

# Extract group tag value
{"type": "add_column_group_tag_value", "value": "tag_name", "default_value": "default"}
```

**Column Operations:**
```python
# Add literal value
{"type": "add_column_value", "value": "literal_string"}

# Concatenate columns
{"type": "add_column_concatenate", "target_column_0": 0, "target_column_1": 1}

# Split column with regex
{"type": "add_column_regex", "expression": "pattern", "target_column": 0}
```

**Mapping Types:**
```python
# Create list structure
{"type": "list_identifiers", "columns": [0]}           # Simple list
{"type": "list_identifiers", "columns": [0, 1]}        # Nested list:list
{"type": "list_identifiers", "columns": [0, 1, 2]}     # list:list:list

# Apply tags
{"type": "tags", "columns": [0]}
{"type": "group_tags", "columns": [0]}
```

---

### 6. Workflow Integration Tests

#### Test: Apply Rules in Workflow

```python
workflow = """
class: GalaxyWorkflow
inputs:
  input_c: collection
steps:
  apply:
    tool_id: __APPLY_RULES__
    state:
      input:
        $link: input_c
      rules:
        rules:
          - type: add_column_metadata
            value: identifier0
          - type: add_column_metadata
            value: identifier0
        mapping:
          - type: list_identifiers
            columns: [0, 1]
  random_lines:
    tool_id: random_lines1
    state:
      num_lines: 1
      input:
        $link: apply/output
"""

test_data = """
input_c:
  collection_type: list
  elements:
    - identifier: i1
      content: "0"
    - identifier: i2
      content: "1"
"""
```

**Key Insights:**
- Apply Rules seamlessly integrates into workflows
- Rules defined in workflow YAML
- Output used by downstream tools
- Fully reproducible pipeline

---

#### Test: Filter Failed in Workflow

```python
workflow = """
class: GalaxyWorkflow
inputs:
  input_c: collection

steps:
  mixed_collection:
    tool_id: exit_code_from_file
    state:
      input:
        $link: input_c

  filtered_collection:
    tool_id: "__FILTER_FAILED_DATASETS__"
    state:
      input:
        $link: mixed_collection/out_file1

  cat:
    tool_id: cat1
    state:
      input1:
        $link: filtered_collection
"""
```

**Key Insights:**
- Filter Failed removes error datasets
- Allows pipeline to continue despite failures
- Downstream tools receive only successful data
- Common pattern for robust pipelines

---

### 7. Edge Cases and Best Practices

#### Edge Case: Incompatible Collection Types

```python
def test_cannot_map_over_incompatible_collections():
    hdca1_id = _build_pair(history_id, ["123\n", "456\n"])  # Paired
    hdca2_id = create_list_in_history(history_id)            # List

    inputs = {
        "input1": {"batch": True, "values": [{"src": "hdca", "id": hdca1_id}]},
        "input2": {"batch": True, "values": [{"src": "hdca", "id": hdca2_id}]}
    }
    run_response = _run("cat1", history_id, inputs)
    assert run_response.status_code >= 400  # ERROR
```

**Lesson:** Cannot map over collections with different structures (paired vs list).

---

#### Best Practice: Wait for History

```python
# Always wait for history before operations
dataset_populator.wait_for_history(history_id, assert_ok=True)

# Then run tool
response = _run("tool_id", history_id, inputs)
```

**Lesson:** Ensure datasets are ready before processing.

---

#### Best Practice: Wait for Jobs

```python
result = _run("tool_id", history_id, inputs)

# Wait for all jobs to complete
for job in result["jobs"]:
    dataset_populator.wait_for_job(job["id"], assert_ok=True)

# Then access outputs
outputs = result["outputs"]
```

**Lesson:** Jobs execute asynchronously. Wait before accessing results.

---

#### Best Practice: Check Implicit Collections

```python
response = _run("tool_id", history_id, inputs)

implicit_collections = response["implicit_collections"]
assert implicit_collections  # Verify created

for implicit_collection in implicit_collections:
    assert implicit_collection["populated_state"] == "ok"
```

**Lesson:** Map-over creates implicit collections. Verify they populated correctly.

---

### 8. Testing Patterns Summary

#### Pattern 1: Simple Tool Test

```python
1. Create test collection
2. Prepare inputs with proper structure
3. Execute tool via _run()
4. Verify outputs/collections
5. Check content if needed
```

#### Pattern 2: Map-Over Test

```python
1. Create collection(s)
2. Set "batch": True in inputs
3. Execute tool
4. Verify job count (one per element)
5. Verify implicit_collections created
6. Check output structure and content
```

#### Pattern 3: Workflow Test

```python
1. Define workflow YAML with collection operations
2. Prepare test_data
3. Run workflow with test data
4. Verify outputs at specific HIDs
5. Check collection structure and content
```

#### Pattern 4: Apply Rules Test

```python
1. Define rules structure (rules + mapping)
2. Create test collection
3. Execute __APPLY_RULES__ with rules
4. Verify output collection type
5. Verify element structure
6. Check identifier values
7. Verify tags if applicable
```

---

## Key Takeaways from Tests

### 1. Collection References

Always use proper src/id structure:
```python
{"src": "hdca", "id": "collection_id"}  # Collections
{"src": "hda", "id": "dataset_id"}       # Datasets
```

### 2. Batch Processing

Enable with `"batch": True`:
```python
{"batch": True, "values": [{"src": "hdca", "id": "..."}]}
```

Control linking:
```python
{"batch": True, "linked": False, "values": [...]}  # Cartesian product
```

### 3. Nested Collections

Specify map-over level:
```python
{"batch": True, "values": [{"src": "hdca", "map_over_type": "paired", "id": "..."}]}
```

### 4. Apply Rules Structure

**Basic structure:**
```python
{
    "rules": {
        "rules": [
            # List of rule operations
        ],
        "mapping": [
            # List of mapping operations
        ]
    }
}
```

**Common pattern:**
1. Add columns (metadata, values, etc.)
2. Transform columns (concatenate, regex, etc.)
3. Map to collection structure

### 5. Output Types

- `outputs`: Individual datasets
- `output_collections`: Explicitly created collections
- `implicit_collections`: Created by map-over operations
- `jobs`: Job records for tracking

### 6. Asynchronous Operations

- Jobs execute asynchronously
- Always wait for completion before accessing outputs
- Check `populated_state` for implicit collections

### 7. Tool-Based Operations Win

Tests consistently demonstrate:
- Using Galaxy's native tools
- Proper input/output structures
- Reproducible operations
- Workflow compatibility

**No tests show direct API manipulation of collection metadata.**

---

## Summary: Testing Philosophy

Galaxy's tests demonstrate that "all collection operations should use native tools", even programmatically via API. This ensures:

1. **Reproducibility**: Operations captured in history
2. **Testability**: Consistent behavior across versions
3. **Workflow compatibility**: Operations extractable to workflows
4. **Proper error handling**: Tools handle edge cases
5. **Community alignment**: Standard patterns everyone uses

When writing collection manipulation code, **always follow the patterns shown in Galaxy's own tests**: use tools, not direct manipulation.

---

## Additional Resources

- **Tool Catalog:** See `references/tools.md` for complete tool list
- **API Guide:** See `references/api-patterns.md` for API usage patterns
- **Apply Rules DSL:** See `references/apply-rules.md` for rule builder syntax
- **Test Source:** `lib/galaxy_test/api/test_tools.py` for more examples
