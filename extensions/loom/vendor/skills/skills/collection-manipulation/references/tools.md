# Galaxy Collection Operation Tools Research

## Context

Galaxy provides comprehensive native tools for collection operations. Per project goals, Claude should recommend these tools over direct API manipulation to ensure reproducibility, workflow-extractability, and alignment with Galaxy best practices.

This document catalogs the collection operation tools available in Galaxy's core toolset (lib/galaxy/tools), documenting their capabilities, inputs, outputs, and use cases.

## Tool Categories

### 1. Advanced Restructuring Tools

#### Apply Rules Tool (`__APPLY_RULES__`)
**Location:** `lib/galaxy/tools/apply_rules.xml`

**Purpose:** Advanced collection restructuring tool that processes collection metadata as tabular data and applies transformation rules to generate new collections.

**Key Features:**
- Process collections with arbitrary nesting levels
- Filter, re-sort, nest, flatten, and combine operations
- Dynamic preview in interactive tool form
- Workflow-compatible (no preview in workflows)
- Most flexible collection operation tool

**Inputs:**
- `input`: Data collection of any type
- `rules`: Rules specification (references input collection)

**Outputs:**
- `output`: Reorganized collection (type determined by rules)
- Label: `${input.name} (re-organized)`

**Use Cases:**
- Complex filtering combined with structural modifications
- Arbitrary nesting/flattening operations
- Operations not possible with simpler collection tools
- Batch restructuring with saved rule definitions

**Training Resources:** https://training.galaxyproject.org/training-material/search?query=rule+builder

**Notes:**
- Does not increase quota usage
- Can handle operations too complex for other collection tools
- Rules can be exported as JSON and reused

---

### 2. Filtering and Selection Tools

#### Filter Collection (`__FILTER_FROM_FILE__`)
**Location:** `lib/galaxy/tools/filter_from_file.xml`

**Purpose:** Filter collection elements using identifiers from a supplied text file.

**Inputs:**
- `input`: Data collection to filter
- `how_filter`: Selection mode
  - `remove_if_absent`: Keep only elements whose identifiers are IN the file
  - `remove_if_present`: Keep only elements whose identifiers are NOT IN the file
- `filter_source`: Text file containing identifiers (one per line)

**Outputs:**
- `output_filtered`: Collection with matching elements
- `output_discarded`: Collection with removed elements

**Use Cases:**
- Subset collections based on sample lists
- Remove failed or problematic samples
- Keep only samples of interest for downstream analysis

**Example:**
Collection: [A, B, X] + File: [A, B, Z] with `remove_if_absent` → Filtered: [A, B], Discarded: [X]

**Notes:**
- Produces TWO collections (filtered and discarded)
- Identifiers in file that don't match collection elements are ignored

---

#### Filter Empty Datasets (`__FILTER_EMPTY_DATASETS__`)
**Location:** `lib/galaxy/tools/filter_empty_collection.xml`

**Purpose:** Remove empty datasets from a collection.

**Inputs:**
- `input`: Collection (type: list or list:paired)

**Outputs:**
- `output`: Collection with empty datasets removed

**Use Cases:**
- Continue multi-sample analysis when some samples produce no output
- Clean collections before downstream tools that require content

---

#### Filter Failed Datasets (`__FILTER_FAILED_DATASETS__`)
**Location:** `lib/galaxy/tools/filter_failed_collection.xml`

**Purpose:** Remove datasets in error (red) state from a collection.

**Inputs:**
- `input`: Collection (type: list or list:paired)
- `replacement`: Optional dataset to replace failed elements (instead of removing)

**Outputs:**
- `output`: Collection with failed datasets removed/replaced

**Use Cases:**
- Continue multi-sample pipeline when some samples fail
- Replace failed samples with placeholder data

---

#### Keep Success Datasets (`__KEEP_SUCCESS_DATASETS__`)
**Location:** `lib/galaxy/tools/keep_success_collection.xml`

**Purpose:** Keep only datasets in success (green) state, removing failed and paused datasets.

**Inputs:**
- `input`: Collection (type: list or list:paired)

**Outputs:**
- `output`: Collection with only successful datasets

**Use Cases:**
- Filter out failed or paused samples
- Ensure downstream tools only process completed samples

---

#### Extract Dataset (`__EXTRACT_DATASET__`)
**Location:** `lib/galaxy/tools/extract_dataset.xml`

**Purpose:** Extract a single dataset from a collection by position or identifier.

**Inputs:**
- `input`: Collection (type: list, paired, paired_or_unpaired, or record)
- `which_dataset`: Selection method
  - `first`: Extract the first dataset
  - `by_identifier`: Extract by element identifier name
  - `by_index`: Extract by position (0-indexed)

**Outputs:**
- `output`: Single extracted dataset

**Use Cases:**
- Extract reference sample from collection
- Get specific dataset for individual inspection
- Collapse nested collections to simpler structure

**Notes:**
- For nested collections, extracts from innermost level
- Creates new list where selected element replaces innermost collection

---

### 3. Structure Transformation Tools

#### Flatten Collection (`__FLATTEN__`)
**Location:** `lib/galaxy/tools/flatten_collection.xml`

**Purpose:** Flatten nested collections (list:paired, list:list, etc.) into a simple list.

**Inputs:**
- `input`: Nested data collection
- `join_identifier`: String to join identifier levels (default: "_")

**Outputs:**
- `output`: Flattened list collection

**Use Cases:**
- Convert list:paired → list (for single-dataset tools)
- Simplify nested list:list structures
- Prepare collections for tools requiring simple lists

**Example:**
```
Input:  list:paired [i1 → {forward, reverse}]
Output: list [i1_forward, i1_reverse]
```

---

#### Zip Collections (`__ZIP_COLLECTION__`)
**Location:** `lib/galaxy/tools/zip_collection.xml`

**Purpose:** Combine two datasets or collections into a paired collection.

**Inputs:**
- `input_forward`: Dataset or collection (forward reads)
- `input_reverse`: Dataset or collection (reverse reads)

**Outputs:**
- `output`: Paired collection with forward/reverse structure

**Use Cases:**
- Combine separate forward/reverse read collections
- Create paired structure from two simple lists
- Prepare data for paired-end analysis tools

**Example:**
```
Input:  forward_list [A, B] + reverse_list [A, B]
Output: paired [A → {forward, reverse}, B → {forward, reverse}]
```

---

#### Unzip Collection (`__UNZIP_COLLECTION__`)
**Location:** `lib/galaxy/tools/unzip_collection.xml`

**Purpose:** Split a paired collection into two separate list collections.

**Inputs:**
- `input`: Paired collection

**Outputs:**
- `forward`: List collection containing forward elements
- `reverse`: List collection containing reverse elements

**Use Cases:**
- Separate paired reads for single-end processing
- Process forward and reverse reads independently
- Extract specific read orientation

**Example:**
```
Input:  paired [A → {forward, reverse}, B → {forward, reverse}]
Output: forward_list [A, B] + reverse_list [A, B]
```

---

#### Nest Collection (`__NEST__`)
**Location:** `lib/galaxy/tools/nest_collection.xml`

**Purpose:** Add a nesting level to a collection (create collection of collections).

**Inputs:**
- `input`: Collection (type: list or paired)

**Outputs:**
- `output`: Nested collection (list:list or list:paired)

**Use Cases:**
- Enable map-over behavior for list-processing tools
- Add hierarchy level for batch processing
- Prepare collections for tools expecting nested structure

**Example:**
```
Input:  list [sample1, sample2]
Output: list:list [sample1 → [sample1], sample2 → [sample2]]
```

**Purpose Explanation:**
When a tool accepts a list, Galaxy maps over elements. If you want to process entire lists as units, add nesting so Galaxy maps over the outer lists instead.

---

### 4. Collection Building and Merging Tools

#### Build List (`__BUILD_LIST__`)
**Location:** `lib/galaxy/tools/build_list.xml`

**Purpose:** Build a new list collection from individual datasets or collections.

**Inputs:**
- `datasets`: Repeating parameter for dataset/collection inputs

**Outputs:**
- `output`: List collection containing all inputs

**Use Cases:**
- Combine individual datasets into a collection
- Merge dataset with collection elements (creates nested collection)
- Merge multiple collections (creates nested collection)

**Examples:**
- **Case A:** Individual datasets → simple list
- **Case B:** Collection + datasets → nested collection (dataset added to each collection element)
- **Case C:** Multiple collections → nested collection (must have equal element counts)

**Notes:**
- When merging collections, they must have the same number of elements
- If providing collections, tool runs in batch mode

---

#### Merge Collections (`__MERGE_COLLECTION__`)
**Location:** `lib/galaxy/tools/merge_collection.xml`

**Purpose:** Merge two or more collections into a single collection.

**Inputs:**
- `inputs`: Repeating parameter for collections (minimum 2)
- `conflict.duplicate_options`: How to handle duplicate identifiers
  - `keep_first`: Keep first occurrence (default)
  - `keep_last`: Keep last occurrence
  - `suffix_conflict`: Append suffix to all conflicting identifiers
  - `suffix_conflict_rest`: Append suffix to conflicts after first
  - `suffix_every`: Append suffix to every identifier
  - `fail`: Error on conflicts
- `suffix_pattern`: Pattern for suffixes (default: "_#")

**Outputs:**
- `output`: Merged collection (same type as first input)

**Use Cases:**
- Combine results from multiple analysis runs
- Merge sample collections from different sources
- Append additional samples to existing collection

**Example with suffix_conflict_rest:**
```
Input:  [A, B, X] + [A, B, Y]
Output: [A, B, A_2, B_2, X, Y]
```

---

#### Duplicate File to Collection (`__DUPLICATE_FILE_TO_COLLECTION__`)
**Location:** `lib/galaxy/tools/duplicate_file_to_collection.xml`

**Purpose:** Create a collection by duplicating a single dataset N times.

**Inputs:**
- `input`: Dataset to duplicate
- `number`: Number of duplicates to create (integer)
- `element_identifier`: Base name for element identifiers

**Outputs:**
- `output`: List collection with N identical elements

**Use Cases:**
- Create reference dataset collection matching sample count
- Replicate parameter file for batch processing
- Generate collections for testing

**Example:**
```
Input:  dataset.txt, number=3, identifier="ref"
Output: list [ref 1, ref 2, ref 3] (all identical)
```

---

### 5. Metadata and Organization Tools

#### Relabel Identifiers (`__RELABEL_FROM_FILE__`)
**Location:** `lib/galaxy/tools/relabel_from_file.xml`

**Purpose:** Change element identifiers in a collection using identifiers from a file.

**Inputs:**
- `input`: Collection to relabel
- `how_select`: Label specification method
  - `txt`: Simple text file (one identifier per line, order-dependent)
  - `tabular`: Two-column mapping (old → new identifiers)
  - `tabular_extended`: Any two columns from table
- `labels`: File containing new identifiers
- `strict`: Enforce exact matching (optional boolean)

**Outputs:**
- `output`: Collection with relabeled elements

**Use Cases:**
- Rename samples to human-readable names
- Map technical IDs to sample names
- Standardize naming across collections

**Valid Identifier Characters:** a-z, A-Z, 0-9, -, _, ., space, comma

**Example with tabular mapping:**
```
Input:  Collection [A, B, X]
File:   B → Beta, X → Gamma, A → Alpha
Output: Collection [Alpha, Beta, Gamma]
```

---

#### Sort Collection (`__SORTLIST__`)
**Location:** `lib/galaxy/tools/sort_collection_list.xml`

**Purpose:** Sort collection elements alphabetically, numerically, or by custom order.

**Inputs:**
- `input`: Collection (type: list or list:paired)
- `sort_type`: Sorting method
  - `alpha`: Alphabetical sorting
  - `numeric`: Numeric sorting (ignores non-numeric characters)
  - `file`: Custom order from file
- `sort_file`: Text file with desired order (for file-based sorting)

**Outputs:**
- `output`: Sorted collection

**Use Cases:**
- Organize samples alphabetically
- Order by sample numbers
- Apply custom experimental order

**Example with numeric sort:**
```
Input:  [Horse123, Donkey543, Mule176]
Output: [Horse123, Mule176, Donkey543]  (sorted by numbers: 123, 176, 543)
```

---

#### Tag Elements (`__TAG_FROM_FILE__`)
**Location:** `lib/galaxy/tools/tag_collection_from_file.xml`

**Purpose:** Add, set, or remove tags on collection elements.

**Inputs:**
- `input`: Collection to tag
- `tags`: Two-column tabular file (identifier → tags)
- `how`: Tag update mode
  - `add`: Add new tags, keep existing
  - `set`: Add new tags, remove existing
  - `remove`: Remove specified tags

**Outputs:**
- `output`: Collection with updated tags

**Tag Types:**
- **Simple tags:** Alternative labels for finding datasets
- **Name tags** (`name:` or `#`): Propagate through derived datasets
- **Group tags** (`group:`): Label groups (e.g., treatment/control)

**Use Cases:**
- Annotate samples with metadata
- Track experimental conditions
- Enable tag-based filtering downstream

**Training Resources:** https://training.galaxyproject.org/training-material/search?query=tags

---

### 6. Advanced Combination Tools

#### Flat Cross Product (`__CROSS_PRODUCT_FLAT__`)
**Location:** `lib/galaxy/tools/cross_product_flat.xml`

**Purpose:** Create all-vs-all combinations of two list collections for pairwise comparisons.

**Inputs:**
- `input_a`: First list collection (length n)
- `input_b`: Second list collection (length m)
- `join_identifier`: String to join identifiers (default: "_")

**Outputs:**
- `output_a`: List of size n×m (repeats from input_a)
- `output_b`: List of size n×m (repeats from input_b)

**Use Cases:**
- All-vs-all pairwise comparisons
- Combinatorial analysis
- Cross-reference testing

**How It Works:**
Creates two matched lists where the kth element identifier is the concatenation of input_a[i] and input_b[j] identifiers. The kth element of output_a contains input_a[i] data, and the kth element of output_b contains input_b[j] data. When used with a comparison tool, produces all combinations.

**Example:**
```
Input A: [a1, a2]  (n=2)
Input B: [b1, b2]  (m=2)

Output A: [a1_b1, a1_b2, a2_b1, a2_b2]  (contains: a1, a1, a2, a2)
Output B: [a1_b1, a1_b2, a2_b1, a2_b2]  (contains: b1, b2, b1, b2)

Comparison tool produces: [a1 vs b1, a1 vs b2, a2 vs b1, a2 vs b2]
```

**Notes:**
- Both output lists have identical element identifiers in same order
- Matching corresponding elements produces every combination
- Does not increase quota usage

---

## Tool Selection Guide

### When to Use Which Tool

**For Filtering:**
- **Simple cleanup:** `Filter Empty`, `Filter Failed`, `Keep Success`
- **Identifier-based selection:** `Filter from File`
- **Extract single item:** `Extract Dataset`

**For Restructuring:**
- **Simple operations:** `Flatten`, `Zip`, `Unzip`, `Nest`
- **Complex operations:** `Apply Rules` (most flexible)

**For Building Collections:**
- **From scratch:** `Build List`
- **Combining collections:** `Merge Collections`
- **Replicating data:** `Duplicate File to Collection`

**For Metadata:**
- **Rename elements:** `Relabel Identifiers`
- **Reorder elements:** `Sort Collection`
- **Add metadata:** `Tag Elements`

**For Advanced Operations:**
- **All-vs-all comparisons:** `Flat Cross Product`
- **Everything else complex:** `Apply Rules`

## Best Practices

### Reproducibility
1. **Prefer tools over API:** All these tools are workflow-compatible
2. **Document operations:** Tool parameters capture transformation logic
3. **Reuse patterns:** Export Apply Rules JSON for similar datasets
4. **Test incrementally:** Verify each transformation before chaining

### Workflow Integration
1. **Chain operations:** Tools work together seamlessly
2. **Preserve structure:** Choose tools that maintain needed hierarchy
3. **Consider downstream:** Match collection type to next tool's requirements
4. **Batch wisely:** Use nesting to control map-over behavior

### Performance
1. **Filter early:** Remove unwanted elements before heavy processing
2. **Flatten when appropriate:** Simpler structures are easier to work with
3. **Avoid unnecessary nesting:** Only nest when tools require it
4. **No quota impact:** Collection operations don't increase storage usage

## Common Patterns

### Pattern 1: Clean and Filter Pipeline
```
1. Filter Failed Datasets → Remove errors
2. Filter Empty Datasets → Remove empty files
3. Filter from File → Keep only samples of interest
4. Sort Collection → Organize for downstream
```

### Pattern 2: Paired-End Read Processing
```
1. Zip Collections → Combine forward/reverse lists
2. Process paired data (mapping, alignment)
3. Unzip Collection → Separate for single-end analysis
4. Flatten Collection → Convert to simple list if needed
```

### Pattern 3: Complex Restructuring
```
1. Apply Rules → Custom filtering/nesting/flattening
   - Load or create transformation rules
   - Preview results in interactive mode
   - Export rules JSON for reuse
2. Downstream analysis with restructured collection
```

### Pattern 4: Metadata Management
```
1. Relabel Identifiers → Standardize naming
2. Tag Elements → Add experimental metadata
3. Sort Collection → Order by experiment design
4. Downstream analysis with organized metadata
```

### Pattern 5: All-vs-All Analysis
```
1. Flat Cross Product → Generate all combinations
2. Comparison tool → Process each pair
3. Merge Collections → Combine with original data if needed
4. Analysis and visualization
```

## Summary: Tool-Based vs. API-Based Operations

### Why Tools Win

**Reproducibility:**
- Operations captured in workflow format
- Parameters documented automatically
- Re-execution produces identical results

**Traceability:**
- Galaxy tracks all transformations
- Provenance preserved throughout pipeline
- Operations visible in history

**Shareability:**
- Workflows extractable and shareable
- Community can reproduce analyses
- Published methods remain executable

**Consistency:**
- Tested and validated operations
- Uniform application across datasets
- Reduced human error

### When Claude Encounters Collection Requests

1. **Analyze requirements:** Understand data structure and goals
2. **Select appropriate tool(s):** Match operation to tool capabilities
3. **Explain approach:** Describe why tool-based solution is preferred
4. **Provide guidance:** Step-by-step instructions for tool usage
5. **Avoid API manipulation:** Only when no tool-based alternative exists

### The Galaxy Way

Collections + tool-based operations + workflow integration = reproducible, scalable, shareable bioinformatics analyses.
