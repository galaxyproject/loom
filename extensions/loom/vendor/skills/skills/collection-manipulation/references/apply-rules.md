# Galaxy Apply Rules DSL Research

## Context

The Apply Rules tool (`__APPLY_RULES__`) is Galaxy's most powerful collection manipulation tool. It processes collection metadata as tabular data and applies transformation rules to filter, reorganize, nest, flatten, and modify collections. This document provides comprehensive documentation of the rules DSL (Domain-Specific Language).

**Key principle:** Rules transform collection metadata (identifiers, indices, tags) as tabular data, then map columns back to create new collection structures.

## Rules DSL Architecture

### Core Concepts

**Data Model:**
```
data: [[cell values]]      # 2D array of strings (tabular data)
sources: [source objects]   # Metadata for each row (identifiers, indices, tags)
```

**Execution Flow:**
1. Collection metadata extracted to tabular format
2. Rules applied sequentially to transform data
3. Mapping operations convert transformed data to new collection

**Example:**
```
Input collection: list [i1, i2]

Initial state:
  data: [["value1"], ["value2"]]
  sources: [
    {"identifiers": ["i1"], "indices": [0]},
    {"identifiers": ["i2"], "indices": [1]}
  ]

After rules:
  data: [["value1", "i1"], ["value2", "i2"]]  # Added identifier column

After mapping:
  Output collection: list [i1, i2]
```

---

## Rule Operations

Rules are applied **sequentially** in the order specified. Each rule transforms the data table.

### 1. Column Addition Rules

#### add_column_basename

**Purpose:** Extract basename from file paths

**Parameters:**
- `target_column` (int): Column containing paths

**Example:**
```yaml
rules:
  - type: add_column_basename
    target_column: 0
```

**Transformation:**
```
Input:  [["/path/to/moo.txt"], ["moo.txt"]]
Output: [["/path/to/moo.txt", "moo.txt"], ["moo.txt", "moo.txt"]]
```

**Use cases:**
- Extract filenames from full paths
- Create identifiers from uploaded file paths
- Normalize identifiers across different upload methods

---

#### add_column_regex

**Purpose:** Capture regex groups or perform replacements

**Parameters:**
- `target_column` (int): Column to process
- `expression` (string): Regular expression pattern
- `replacement` (string, optional): Replacement template with `\1`, `\2` for groups
- `group_count` (int, optional): Number of groups to capture as separate columns
- `allow_unmatched` (bool, default: false): If false, errors on unmatched rows

**Mode 1: Simple capture (default)**
```yaml
rules:
  - type: add_column_regex
    target_column: 0
    expression: '(o)+'
```
```
Input:  [["foo"], ["cow"]]
Output: [["foo", "oo"], ["cow", "o"]]
```

**Mode 2: Replacement**
```yaml
rules:
  - type: add_column_regex
    target_column: 0
    expression: '(o+)'
    replacement: 'the os \1'
```
```
Input:  [["foo"], ["cow"]]
Output: [["foo", "the os oo"], ["cow", "the os o"]]
```

**Mode 3: Multiple groups**
```yaml
rules:
  - type: add_column_regex
    target_column: 0
    expression: '.*(o)(o)'
    group_count: 2
```
```
Input:  [["foo"], ["boo"]]
Output: [["foo", "o", "o"], ["boo", "o", "o"]]
```

**Mode 4: Allow unmatched**
```yaml
rules:
  - type: add_column_regex
    target_column: 0
    expression: '(o)+'
    allow_unmatched: true
```
```
Input:  [["foo"], ["cow"], ["cat"]]
Output: [["foo", "oo"], ["cow", "o"], ["cat", ""]]
```

**Use cases:**
- Extract sample names from filenames (e.g., `sample_(\w+)_R1.fastq`)
- Parse structured identifiers (e.g., `TCGA-(\w+)-(\d+)`)
- Clean up identifiers (remove prefixes/suffixes)
- Extract metadata embedded in filenames

**Common patterns:**
```yaml
# Extract sample ID from "sample_123_R1.fastq"
expression: 'sample_(\w+)_R\d'

# Extract prefix before underscore
expression: '([^_]+)_.*'

# Extract everything before last dot
expression: '(.+)\.[^.]+$'
```

---

#### add_column_substr

**Purpose:** Extract or remove fixed-length substrings

**Parameters:**
- `target_column` (int): Column to process
- `substr_type` (enum): Operation type
  - `keep_prefix`: Keep first N characters
  - `keep_suffix`: Keep last N characters
  - `drop_prefix`: Remove first N characters
  - `drop_suffix`: Remove last N characters
- `length` (int): Number of characters

**Examples:**
```yaml
# Keep first 2 characters
rules:
  - type: add_column_substr
    target_column: 0
    substr_type: keep_prefix
    length: 2
```
```
Input:  [["foo"], ["cow"], ["ba"], ["d"]]
Output: [["foo", "fo"], ["cow", "co"], ["ba", "ba"], ["d", "d"]]
```

```yaml
# Drop last 2 characters
rules:
  - type: add_column_substr
    target_column: 0
    substr_type: drop_suffix
    length: 2
```
```
Input:  [["foo"], ["cow"], ["ba"], ["d"]]
Output: [["foo", "f"], ["cow", "c"], ["ba", ""], ["d", ""]]
```

**Use cases:**
- Remove common prefixes/suffixes
- Extract barcodes from fixed positions
- Truncate long identifiers

---

#### add_column_rownum

**Purpose:** Add sequential row numbers

**Parameters:**
- `start` (int): Starting number (0 or 1)

**Example:**
```yaml
rules:
  - type: add_column_rownum
    start: 1
```
```
Input:  [["foo"], ["cow"], ["ba"], ["d"]]
Output: [["foo", "1"], ["cow", "2"], ["ba", "3"], ["d", "4"]]
```

**Use cases:**
- Create numerical identifiers
- Track original row order after sorting
- Generate replicate numbers

---

#### add_column_value

**Purpose:** Add constant value to all rows

**Parameters:**
- `value` (string): Constant value

**Example:**
```yaml
rules:
  - type: add_column_value
    value: "control"
```
```
Input:  [["foo"], ["cow"]]
Output: [["foo", "control"], ["cow", "control"]]
```

**Use cases:**
- Add condition labels (treatment/control)
- Add constant metadata
- Create separator columns for concatenation

---

#### add_column_concatenate

**Purpose:** Combine two columns into one

**Parameters:**
- `target_column_0` (int): First column
- `target_column_1` (int): Second column

**Example:**
```yaml
rules:
  - type: add_column_concatenate
    target_column_0: 0
    target_column_1: 1
```
```
Input:  [["sample", "001"], ["sample", "002"]]
Output: [["sample", "001", "sample001"], ["sample", "002", "sample002"]]
```

**Use cases:**
- Combine sample ID + replicate number
- Build hierarchical identifiers
- Create unique identifiers from multiple parts

**Common pattern - add separator:**
```yaml
rules:
  - type: add_column_value
    value: "_"
  - type: add_column_concatenate
    target_column_0: 0
    target_column_1: 2  # The "_" column
  - type: add_column_concatenate
    target_column_0: 3
    target_column_1: 1  # Result + second original column
```

---

#### add_column_metadata

**Purpose:** Extract metadata from source objects

**Parameters:**
- `value` (enum): Metadata type
  - `identifier0`, `identifier1`, `identifier2`, ...
  - `index0`, `index1`, `index2`, ...
  - `tags`

**Identifier extraction:**
```yaml
rules:
  - type: add_column_metadata
    value: identifier0  # Outermost identifier
```
```
Input:  [["moo"], ["meow"], ["bark"]]
Sources: [{"identifiers": ["cow"]}, {"identifiers": ["cat"]}, {"identifiers": ["dog"]}]
Output:  [["moo", "cow"], ["meow", "cat"], ["bark", "dog"]]
```

**Multiple levels:**
```yaml
rules:
  - type: add_column_metadata
    value: identifier0  # Outer identifier
  - type: add_column_metadata
    value: identifier1  # Inner identifier
```
```
Sources: [
  {"identifiers": ["sample1", "forward"]},
  {"identifiers": ["sample1", "reverse"]}
]
Output:  [["data", "sample1", "forward"], ["data", "sample1", "reverse"]]
```

**Index extraction:**
```yaml
rules:
  - type: add_column_metadata
    value: index0
  - type: add_column_metadata
    value: index1
```
```
Sources: [
  {"indices": [0, 0]},  # First sample, forward
  {"indices": [0, 1]},  # First sample, reverse
  {"indices": [1, 0]},  # Second sample, forward
  {"indices": [1, 1]}   # Second sample, reverse
]
Output:  [
  ["samp1for", "0", "0"],
  ["samp1rev", "0", "1"],
  ["samp2for", "1", "0"],
  ["samp2rev", "1", "1"]
]
```

**Tags extraction:**
```yaml
rules:
  - type: add_column_metadata
    value: tags
```
```
Sources: [
  {"identifiers": ["cow"], "tags": ["farm"]},
  {"identifiers": ["dog"], "tags": ["house", "firestation"]}
]
Output:  [["moo", "farm"], ["bark", "firestation,house"]]  # Sorted, comma-joined
```

**Use cases:**
- Access collection structure metadata
- Build identifiers from nested collections
- Use positional indices for numerical IDs
- Extract tags for grouping/filtering

---

#### add_column_group_tag_value

**Purpose:** Extract specific group tag value

**Parameters:**
- `value` (string): Group tag name (e.g., "condition", "type")
- `default_value` (string): Value if tag not present

**Example:**
```yaml
rules:
  - type: add_column_group_tag_value
    value: condition
    default_value: 'control'
```
```
Sources: [
  {"tags": ["group:condition:treated"]},
  {"tags": ["group:condition:control"]},
  {"tags": []}  # No condition tag
]
Output:  [["data", "treated"], ["data", "control"], ["data", "control"]]
```

**Multiple tags - first alphabetically wins:**
```yaml
rules:
  - type: add_column_group_tag_value
    value: where
    default_value: 'barn'
```
```
Sources: [
  {"tags": ["group:where:house", "group:where:firestation"]}
]
Output:  [["data", "firestation"]]  # "firestation" < "house" alphabetically
```

**Use cases:**
- Group samples by experimental condition
- Extract sample type (single-end/paired-end)
- Use tags for nested collection organization

---

#### add_column_from_sample_sheet_index

**Purpose:** Retrieve values from sample sheet columns

**Parameters:**
- `value` (int): Sample sheet column index

**Example:**
```yaml
rules:
  - type: add_column_from_sample_sheet_index
    value: 0
  - type: add_column_from_sample_sheet_index
    value: 1
```
```
Sources: [
  {"columns": [0, 1]},
  {"columns": [2, 3]}
]
Output:  [["moo", 0, 1], ["cow", 2, 3]]
```

**Use cases:**
- Extract metadata from uploaded sample sheets
- Access additional columns beyond identifiers
- Incorporate external metadata

---

### 2. Filter Rules

Filters **remove rows** from the data table based on conditions.

#### add_filter_regex

**Purpose:** Keep/remove rows matching pattern

**Parameters:**
- `target_column` (int): Column to test
- `expression` (string): Regular expression
- `invert` (bool, default: false): If true, keep non-matching rows

**Keep matching:**
```yaml
rules:
  - type: add_filter_regex
    target_column: 0
    expression: '(a+)'
    invert: false
```
```
Input:  [["a", "b", "c"], ["e", "f", "g"]]
Output: [["a", "b", "c"]]
```

**Remove matching:**
```yaml
rules:
  - type: add_filter_regex
    target_column: 2
    expression: '(c+)'
    invert: true
```
```
Input:  [["a", "b", "c"], ["e", "f", "g"]]
Output: [["e", "f", "g"]]
```

**Use cases:**
- Filter by sample name pattern
- Remove control samples
- Select specific file types

---

#### add_filter_count

**Purpose:** Keep/remove first or last N rows

**Parameters:**
- `count` (int): Number of rows
- `which` (enum): `first` or `last`
- `invert` (bool, default: false): If true, reverse filter

**Remove first row:**
```yaml
rules:
  - type: add_filter_count
    count: 1
    which: first
    invert: false  # Remove first, keep rest
```
```
Input:  [["a", "b", "c"], ["e", "f", "g"], ["h", "i", "j"]]
Output: [["e", "f", "g"], ["h", "i", "j"]]
```

**Keep only last row:**
```yaml
rules:
  - type: add_filter_count
    count: 1
    which: last
    invert: true  # Remove all but last
```
```
Input:  [["a", "b", "c"], ["e", "f", "g"], ["h", "i", "j"]]
Output: [["h", "i", "j"]]
```

**Use cases:**
- Remove header rows
- Skip first N samples
- Select specific replicates

---

#### add_filter_empty

**Purpose:** Remove rows with empty cells

**Parameters:**
- `target_column` (int): Column to check
- `invert` (bool, default: false): If true, keep only empty

**Remove empty:**
```yaml
rules:
  - type: add_filter_empty
    target_column: 0
    invert: false
```
```
Input:  [["", "b", "c"], ["a", "b", "c"]]
Output: [["a", "b", "c"]]
```

**Use cases:**
- Remove rows with missing identifiers
- Clean up sparse data
- Filter failed extractions

---

#### add_filter_matches

**Purpose:** Exact value matching (case-sensitive)

**Parameters:**
- `value` (string): Exact value to match
- `target_column` (int): Column to check
- `invert` (bool, default: false): If true, keep non-matching

**Example:**
```yaml
rules:
  - type: add_filter_matches
    value: "a"
    target_column: 0
    invert: false
```
```
Input:  [["a", "b", "c"], ["e", "f", "g"], ["h", "i", "j"]]
Output: [["a", "b", "c"]]
```

**Important:** Exact match only, no partial matches:
```yaml
rules:
  - type: add_filter_matches
    value: "a"
    target_column: 1
```
```
Input:  [["a ", "b", "c"]]  # Note space after "a"
Output: []  # No match - "a " != "a"
```

**Use cases:**
- Filter by specific sample ID
- Select exact condition matches
- Boolean filtering (match "true"/"false")

---

#### add_filter_compare

**Purpose:** Numeric comparisons

**Parameters:**
- `target_column` (int): Column with numeric values
- `value` (number): Comparison value
- `compare_type` (enum):
  - `less_than`
  - `less_than_equal`
  - `greater_than`
  - `greater_than_equal`

**Example:**
```yaml
rules:
  - type: add_filter_compare
    target_column: 0
    value: 13
    compare_type: less_than
```
```
Input:  [["1", "moo"], ["10", "cow"], ["13", "rat"], ["20", "dog"]]
Output: [["1", "moo"], ["10", "cow"]]
```

**Use cases:**
- Filter by quality scores
- Select samples by replicate number
- Threshold-based filtering

---

### 3. Structural Rules

#### remove_columns

**Purpose:** Delete specified columns

**Parameters:**
- `target_columns` (list[int]): Column indices to remove

**Example:**
```yaml
rules:
  - type: remove_columns
    target_columns: [0, 1]
```
```
Input:  [["a", "b", "c"], ["e", "f", "g"]]
Output: [["c"], ["g"]]
```

**Use cases:**
- Clean up intermediate columns
- Remove temporary concatenation columns
- Keep only final identifier columns

---

#### sort

**Purpose:** Sort rows by column value

**Parameters:**
- `target_column` (int): Column to sort by
- `numeric` (bool): If true, numeric sort; if false, alphabetic

**Alphabetic sort:**
```yaml
rules:
  - type: sort
    numeric: false
    target_column: 0
```
```
Input:  [["moo", "cow"], ["meow", "cat"], ["bark", "dog"]]
Output: [["bark", "dog"], ["meow", "cat"], ["moo", "cow"]]
```

**Note:** Case-sensitive, uppercase sorts before lowercase
```
Input:  [["Dog"], ["cat"], ["cow"]]
Output: [["Dog"], ["cat"], ["cow"]]  # "Dog" < "cat" < "cow"
```

**Use cases:**
- Alphabetize samples
- Order by numerical IDs
- Group similar identifiers together

---

#### swap_columns

**Purpose:** Exchange two column positions

**Parameters:**
- `target_column_0` (int): First column
- `target_column_1` (int): Second column

**Example:**
```yaml
rules:
  - type: swap_columns
    target_column_0: 0
    target_column_1: 1
```
```
Input:  [["moo", "cow"], ["meow", "cat"]]
Output: [["cow", "moo"], ["cat", "meow"]]
```

**Use cases:**
- Reorder identifier columns for mapping
- Fix column order mistakes
- Prepare for specific mapping requirements

---

#### split_columns

**Purpose:** Create Cartesian product of column groups (split rows)

**Parameters:**
- `target_columns_0` (list[int]): First column group
- `target_columns_1` (list[int]): Second column group

**Example:**
```yaml
rules:
  - type: split_columns
    target_columns_0: [0]
    target_columns_1: [1]
```
```
Input:  [["moo", "cow", "A"], ["meow", "cat", "B"]]
Output: [
  ["moo", "A"],
  ["cow", "A"],
  ["meow", "B"],
  ["cat", "B"]
]
```

**How it works:**
- For each row, creates N×M new rows where:
  - N = number of columns in group 0
  - M = number of columns in group 1
- Each new row contains one value from group 0 + one value from group 1 + all other columns

**Use cases:**
- Split paired-end data into forward/reverse
- Expand multiple samples per row
- Create all combinations for comparisons

---

## Mapping Operations

Mapping operations define how transformed data columns become collection structure. These are the **final step** that converts tabular data back to collections.

### Available Mapping Types

#### list_identifiers

**Purpose:** Create list structure with specified nesting levels

**Parameters:**
- `columns` (list[int]): Column indices for identifiers

**Single column = simple list:**
```yaml
mapping:
  - type: list_identifiers
    columns: [0]
```
```
Data: [["sample1"], ["sample2"]]
Result: list [sample1, sample2]
```

**Two columns = nested list:list:**
```yaml
mapping:
  - type: list_identifiers
    columns: [0, 1]
```
```
Data: [["group1", "s1"], ["group1", "s2"], ["group2", "s3"]]
Result: list:list [
  group1 → [s1, s2],
  group2 → [s3]
]
```

**Three columns = list:list:list:**
```yaml
mapping:
  - type: list_identifiers
    columns: [0, 1, 2]
```

**Nesting logic:**
- Column 0 = outermost identifier
- Column 1 = next level identifier
- Column 2 = innermost identifier
- Groups rows by matching outer identifiers

---

#### paired_identifier

**Purpose:** Add paired collection level

**Parameters:**
- `columns` (list[int]): Single column with paired identifier

**Simple paired:**
```yaml
mapping:
  - type: paired_identifier
    columns: [0]
```
```
Data: [["forward"], ["reverse"]]
Result: paired {forward, reverse}
```

**Combined with list:**
```yaml
mapping:
  - type: list_identifiers
    columns: [0]
  - type: paired_identifier
    columns: [1]
```
```
Data: [
  ["sample1", "forward"],
  ["sample1", "reverse"],
  ["sample2", "forward"],
  ["sample2", "reverse"]
]
Result: list:paired [
  sample1 → {forward, reverse},
  sample2 → {forward, reverse}
]
```

---

#### tags

**Purpose:** Apply tags to collection elements

**Parameters:**
- `columns` (list[int]): Columns containing tag values

**Example:**
```yaml
mapping:
  - type: list_identifiers
    columns: [0]
  - type: tags
    columns: [1]
```
```
Data: [["sample1", "replicate1"], ["sample2", "replicate2"]]
Result: list with tags [
  sample1 (tags: ["replicate1"]),
  sample2 (tags: ["replicate2"])
]
```

---

#### group_tags

**Purpose:** Apply group tags (format: `group:name:value`)

**Parameters:**
- `columns` (list[int]): Columns containing group tag values

**Example:**
```yaml
mapping:
  - type: list_identifiers
    columns: [1, 0]  # Group by column 1, element ID column 0
  - type: group_tags
    columns: [1]     # Apply as group tag
```
```
Data: [["s1", "treated"], ["s2", "control"]]
Result: list:list with group tags [
  treated → [s1 (tags: ["group:treated"])],
  control → [s2 (tags: ["group:control"])]
]
```

---

## Complete Example: list:record to list:paired

This example demonstrates complex transformation combining multiple rule types:

**Goal:** Convert `list:record` collection where records have "mother" and "child" elements into `list:paired` with "forward" and "reverse".

```yaml
rules:
  - type: add_column_metadata
    value: identifier0  # Sample identifier
  - type: add_column_metadata
    value: identifier1  # Record type (mother/father/child)
  - type: add_column_regex
    target_column: 2
    expression: 'mother'
    replacement: 'forward'
    allow_unmatched: true  # Leaves others as ""
  - type: add_column_regex
    target_column: 2
    expression: 'child'
    replacement: 'reverse'
    allow_unmatched: true
  - type: add_column_concatenate
    target_column_0: 3  # Result of first regex
    target_column_1: 4  # Result of second regex
  - type: add_filter_empty
    target_column: 5  # Remove rows that didn't match (father)
    invert: false
  - type: remove_columns
    target_columns: [2, 3, 4]  # Clean up intermediate columns

mapping:
  - type: list_identifiers
    columns: [1, 2]  # Sample ID, then forward/reverse
```

**Transformation steps:**

```
Initial:
  data: [["el1"], ["el2"], ["el3"]]
  sources: [
    {"identifiers": ["samp1", "mother"]},
    {"identifiers": ["samp1", "father"]},
    {"identifiers": ["samp1", "child"]}
  ]

After add_column_metadata (identifier0, identifier1):
  [["el1", "samp1", "mother"],
   ["el2", "samp1", "father"],
   ["el3", "samp1", "child"]]

After first regex (mother → forward):
  [["el1", "samp1", "mother", "forward"],
   ["el2", "samp1", "father", ""],
   ["el3", "samp1", "child", ""]]

After second regex (child → reverse):
  [["el1", "samp1", "mother", "forward", ""],
   ["el2", "samp1", "father", "", ""],
   ["el3", "samp1", "child", "", "reverse"]]

After concatenate (cols 3+4):
  [["el1", "samp1", "mother", "forward", "", "forward"],
   ["el2", "samp1", "father", "", "", ""],
   ["el3", "samp1", "child", "", "reverse", "reverse"]]

After filter empty (col 5):
  [["el1", "samp1", "mother", "forward", "", "forward"],
   ["el3", "samp1", "child", "", "reverse", "reverse"]]

After remove_columns [2, 3, 4]:
  [["el1", "samp1", "forward"],
   ["el3", "samp1", "reverse"]]

Final mapping with list_identifiers [1, 2]:
  Result: list:paired [
    samp1 → {forward, reverse}
  ]
```

---

## Rule Composition Patterns

### Pattern 1: Extract and Flatten

**Goal:** Flatten `list:paired` → `list` with combined identifiers

```yaml
rules:
  - type: add_column_metadata
    value: identifier0  # Outer ID
  - type: add_column_metadata
    value: identifier1  # Pair ID (forward/reverse)
  - type: add_column_concatenate
    target_column_0: 1
    target_column_1: 2  # Combine them

mapping:
  - type: list_identifiers
    columns: [3]  # Use concatenated column
```

---

### Pattern 2: Group by Tag

**Goal:** Reorganize by tag value into nested structure

```yaml
rules:
  - type: add_column_metadata
    value: identifier0
  - type: add_column_group_tag_value
    value: condition  # Extract "condition" tag
    default_value: "unassigned"

mapping:
  - type: list_identifiers
    columns: [1, 0]  # Group by condition, then sample ID
  - type: group_tags
    columns: [1]     # Apply as group tags
```

---

### Pattern 3: Filter and Sort

**Goal:** Select subset and alphabetize

```yaml
rules:
  - type: add_column_metadata
    value: identifier0
  - type: add_filter_regex
    target_column: 0
    expression: '^control_'  # Only controls
    invert: false
  - type: sort
    numeric: false
    target_column: 0

mapping:
  - type: list_identifiers
    columns: [0]
```

---

### Pattern 4: Parse Filename Structure

**Goal:** Extract sample info from "sample_123_R1.fastq.gz" format

```yaml
rules:
  - type: add_column_metadata
    value: identifier0  # Original filename
  - type: add_column_regex
    target_column: 0
    expression: 'sample_(\w+)_R(\d)'
    group_count: 2  # Sample ID and read number
  - type: add_column_value
    value: "_R"
  - type: add_column_concatenate
    target_column_0: 3
    target_column_1: 2  # "_R" + "1" = "_R1"
  - type: add_column_concatenate
    target_column_0: 1
    target_column_1: 4  # "123" + "_R1" = "123_R1"
  - type: remove_columns
    target_columns: [0, 2, 3, 4]  # Keep only final identifier

mapping:
  - type: list_identifiers
    columns: [0]
```

---

### Pattern 5: Create Paired from Separate Lists

**Goal:** Combine separate forward/reverse lists into paired

**Assumption:** Files named like `sample1_R1.fastq`, `sample1_R2.fastq`

```yaml
rules:
  - type: add_column_metadata
    value: identifier0
  - type: add_column_regex
    target_column: 0
    expression: '(.+)_R([12])'
    group_count: 2  # Sample name and read number
  - type: add_column_regex
    target_column: 2
    expression: '1'
    replacement: 'forward'
    allow_unmatched: true
  - type: add_column_regex
    target_column: 2
    expression: '2'
    replacement: 'reverse'
    allow_unmatched: true
  - type: add_column_concatenate
    target_column_0: 3
    target_column_1: 4
  - type: sort
    numeric: false
    target_column: 1  # Ensure pairs adjacent
  - type: remove_columns
    target_columns: [0, 2, 3, 4]

mapping:
  - type: list_identifiers
    columns: [0]     # Sample ID
  - type: paired_identifier
    columns: [1]     # forward/reverse
```

---

## Best Practices

### 1. Plan Column Layout

Before writing rules, sketch the transformations:
```
Col 0: Original identifier
Col 1: Extracted sample ID (regex)
Col 2: Extracted replicate (regex)
Col 3: Separator "_"
Col 4: Concatenate 1+3+2
Col 5: Final identifier after cleanup
```

### 2. Test Incrementally

Add rules one at a time and verify output:
- Start with metadata extraction
- Add one transformation
- Check result
- Continue

### 3. Use allow_unmatched Carefully

Only use when genuinely optional:
```yaml
# BAD - silently fails to extract
- type: add_column_regex
  expression: 'wrong_pattern'
  allow_unmatched: true

# GOOD - errors if pattern doesn't match
- type: add_column_regex
  expression: 'expected_pattern'
  allow_unmatched: false
```

### 4. Remove Intermediate Columns

Clean up before mapping:
```yaml
rules:
  - type: add_column_metadata
    value: identifier0
  # ... many transformations ...
  - type: remove_columns
    target_columns: [0, 2, 3]  # Remove temp columns

mapping:
  - type: list_identifiers
    columns: [0]  # Only final column remains
```

### 5. Validate with Filters

Use filters to ensure data quality:
```yaml
rules:
  - type: add_column_regex
    expression: 'pattern'
    allow_unmatched: false  # Errors if doesn't match
  - type: add_filter_empty
    target_column: 1
    invert: false  # Remove any that became empty
```

### 6. Document Complex Rules

Add comments explaining logic:
```yaml
rules:
  # Extract sample ID from filename "sample_123_R1.fastq"
  - type: add_column_regex
    target_column: 0
    expression: 'sample_(\w+)_R\d'

  # Remove original filename column
  - type: remove_columns
    target_columns: [0]
```

---

## Common Pitfalls

### Pitfall 1: Column Indices Shift

**Problem:** After removing columns, indices change

```yaml
# WRONG
rules:
  - type: remove_columns
    target_columns: [0]
  - type: add_column_regex
    target_column: 1  # This is now wrong! Column 1 became 0
```

**Solution:** Remove columns last, or recalculate indices

### Pitfall 2: Forgetting Invert Logic

**Problem:** Confusion about filter invert

```yaml
# Keep matching rows (default behavior)
- type: add_filter_regex
  expression: 'sample_'
  invert: false  # FALSE means "keep matching"

# Remove matching rows (keep non-matching)
- type: add_filter_regex
  expression: 'control_'
  invert: true  # TRUE means "remove matching" = keep non-matching
```

**Clearer thinking:** `invert: false` = "keep matches", `invert: true` = "remove matches" (keep non-matching)

### Pitfall 3: Regex Escaping

**Problem:** Special regex characters not escaped

```yaml
# WRONG - . matches any character
expression: 'file.fastq'

# RIGHT
expression: 'file\.fastq'

# For literal parentheses
expression: '\(sample\)'
```

### Pitfall 4: Character Classes vs Alternation for Sequential IDs

**Problem:** Character classes match single characters, not multi-digit suffixes

```yaml
# WRONG - [90] matches a single char (9 or 0) at one position
# Matches SRR22376029 but NOT SRR22376030 (different digit boundary)
expression: 'SRR2237602[90]'

# RIGHT - alternation matches full strings
expression: 'SRR22376029|SRR22376030'
```

**Why it fails:** `SRR2237602[90]` looks for prefix `SRR2237602` followed by one character that is `9` or `0`. It matches `SRR22376029` (prefix `SRR2237602` + `9`), but `SRR22376030` splits as `SRR2237603` + `0` — the prefix doesn't end at the same boundary. Use explicit alternation for sequential accession IDs.

### Pitfall 5: Case Sensitivity

**Problem:** Filters are case-sensitive

```yaml
# Doesn't match "Sample1"
- type: add_filter_matches
  value: "sample1"
  target_column: 0
```

**Solution:** Use regex with case-insensitive flag or normalize case first

### Pitfall 6: Empty Sources After Filtering

**Problem:** All rows filtered out

```yaml
rules:
  - type: add_filter_regex
    expression: 'nonexistent'
    invert: false
# Result: Empty collection!
```

**Solution:** Test filters carefully, use `allow_unmatched: true` when appropriate

---

## Use Case Examples

### Use Case 1: Standard Paired-End RNA-seq

**Files:** `sample1_R1.fastq.gz`, `sample1_R2.fastq.gz`, `sample2_R1.fastq.gz`, `sample2_R2.fastq.gz`

**Goal:** Create `list:paired` collection

```yaml
rules:
  - type: add_column_metadata
    value: identifier0
  - type: add_column_regex
    target_column: 0
    expression: '(.+)_R([12])\.fastq\.gz'
    group_count: 2
  - type: add_column_regex
    target_column: 2
    expression: '1'
    replacement: 'forward'
    allow_unmatched: true
  - type: add_column_regex
    target_column: 2
    expression: '2'
    replacement: 'reverse'
    allow_unmatched: true
  - type: add_column_concatenate
    target_column_0: 3
    target_column_1: 4
  - type: sort
    target_column: 1
    numeric: false
  - type: remove_columns
    target_columns: [0, 2, 3, 4]

mapping:
  - type: list_identifiers
    columns: [0]
  - type: paired_identifier
    columns: [1]
```

---

### Use Case 2: Remove Control Samples

**Goal:** Filter out samples starting with "control_"

```yaml
rules:
  - type: add_column_metadata
    value: identifier0
  - type: add_filter_regex
    target_column: 0
    expression: '^control_'
    invert: true  # Remove matches = keep non-controls

mapping:
  - type: list_identifiers
    columns: [0]
```

---

### Use Case 3: Group by Treatment Condition

**Goal:** Reorganize by "group:condition:*" tag into nested list

```yaml
rules:
  - type: add_column_metadata
    value: identifier0
  - type: add_column_group_tag_value
    value: condition
    default_value: 'unassigned'

mapping:
  - type: list_identifiers
    columns: [1, 0]  # Group by condition, then sample
  - type: group_tags
    columns: [1]
```

---

### Use Case 4: Select Top N by Quality Score

**Assumption:** Quality score in sample name like "sample_123_q95"

**Goal:** Keep only samples with quality >= 90

```yaml
rules:
  - type: add_column_metadata
    value: identifier0
  - type: add_column_regex
    target_column: 0
    expression: 'sample_\w+_q(\d+)'
  - type: add_filter_compare
    target_column: 1
    value: 90
    compare_type: greater_than_equal
  - type: remove_columns
    target_columns: [1]

mapping:
  - type: list_identifiers
    columns: [0]
```

---

### Use Case 5: Replicate Structure

**Files:** `treatment_rep1`, `treatment_rep2`, `control_rep1`, `control_rep2`

**Goal:** Create `list:list` [treatment → [rep1, rep2], control → [rep1, rep2]]

```yaml
rules:
  - type: add_column_metadata
    value: identifier0
  - type: add_column_regex
    target_column: 0
    expression: '(.+)_rep(\d+)'
    group_count: 2
  - type: sort
    target_column: 1
    numeric: false
  - type: remove_columns
    target_columns: [0]

mapping:
  - type: list_identifiers
    columns: [0, 1]  # Condition, then replicate
```

---

## Summary

The Apply Rules DSL is a powerful, composable system for collection transformation:

**Key Principles:**
1. **Tabular transformation** - Collections → table → transform → collection
2. **Sequential rules** - Applied in order, each builds on previous
3. **Column-based operations** - All transformations work on columns
4. **Flexible mapping** - Final step determines output structure

**When to Use:**
- Complex identifier parsing
- Conditional filtering
- Structure reorganization
- Tag-based grouping
- Operations beyond simple collection tools

**When Not to Use:**
- Simple operations (use dedicated tools instead)
- If pattern unclear (prototype with simpler tools first)
- One-off transformations (no reusability needed)

**Power:** Apply Rules can perform ANY collection transformation expressible as tabular operations, making it the most flexible tool in Galaxy's collection toolkit.

---

## Additional Resources

- **Tool Catalog:** `references/tools.md` for all collection tools
- **API Guide:** `references/api-patterns.md` for programmatic usage
- **Test Examples:** `references/test-patterns.md` for real test patterns
- **PR #5819:** https://github.com/galaxyproject/galaxy/pull/5819
- **DSL Spec:** `lib/galaxy/util/rules_dsl_spec.yml` in Galaxy source
