# Galaxy History Access Patterns

Detailed patterns for accessing Galaxy history datasets via MCP.

## List User Histories
```
list_history_ids()
# Returns: [{id, name}, ...]
```

## Get History by Name
```
get_histories(name="Measles")
# Partial match, case-sensitive
```

## Get History Summary (no datasets)
```
get_history_details(history_id="...")
# Returns metadata + dataset count only
```

## Getting History Contents

### Default (visible, non-deleted only)
```
get_history_contents(
    history_id="...",
    limit=100
)
```

### Get ALL datasets (including hidden/deleted)
```
get_history_contents(
    history_id="...",
    limit=100,
    deleted=true,
    visible=false
)
```

### Get Most Recent Datasets First
```
get_history_contents(
    history_id="...",
    limit=10,
    order="hid-dsc"
)
```

### Pagination
```
# Page 1
get_history_contents(history_id="...", limit=100, offset=0)

# Page 2
get_history_contents(history_id="...", limit=100, offset=100)
```

## Dataset Details

### Preview Dataset Content
```
get_dataset_details(
    dataset_id="...",
    include_preview=true,
    preview_lines=15
)
```

### Download Dataset
```
download_dataset(
    dataset_id="...",
    file_path="/path/to/save.txt"
)
```

## Common Patterns

### Find Dataset by HID
```python
# Get recent datasets, find specific HID
contents = get_history_contents(
    history_id="...",
    limit=50,
    order="hid-dsc",
    deleted=true,
    visible=false
)
# Search results for target hid
```

### Find Dataset by Name
```python
# Use get_history_contents then filter by name in results
# Or use Galaxy API via gxy.api() in notebooks
```

## Upload to History

### From Local File
```
upload_file(
    path="/local/path/file.txt",
    history_id="..."
)
```

### From URL
```
upload_file_from_url(
    url="https://example.com/data.fasta",
    history_id="...",
    file_type="fasta"
)
```

## Gotchas

1. **Empty results?** Default only shows visible, non-deleted. Use `deleted=true, visible=false` to see all.

2. **Can't find recent dataset?** Use `order="hid-dsc"` to get newest first.

3. **History shows count but no datasets?** Datasets may be hidden. Set `visible=false`.

4. **Large history?** Use pagination with `limit` and `offset`. Don't request all at once.

5. **Dataset ID vs HID**:
   - `hid` = human-readable number shown in UI (e.g., 13437)
   - `id` = hex hash used in API calls (e.g., "f9cad7b01a472135...")
