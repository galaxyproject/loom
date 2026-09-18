---
name: galaxy-mcp-reference
description: "Use when driving a Galaxy server through its MCP tools -- connecting to an instance, listing or creating histories, uploading data, finding and running tools, invoking workflows, inspecting datasets and jobs. Read before the first Galaxy MCP call in a session; covers which tool to reach for and the common traps (id vs name, history vs dataset ids, collection shapes)."
metadata:
  surfaces: [loom]
when_to_use: >
  Reach for this before any Galaxy MCP tool call -- creating/listing histories,
  uploading data, finding and running tools, inspecting datasets or invocations --
  and for the common gotchas (id vs name, history vs dataset ids, collection shapes).
user_invocable: true
---

# Galaxy MCP Tools Reference

Tools are named below as the Galaxy MCP server exposes them. Clients prefix them differently --
Claude Code and Codex surface `connect` as `mcp__galaxy__connect`, other clients may use the bare
name or their own scheme. Match the operation, not the spelling; check your client's tool list if a
name doesn't resolve.

Complete reference for Galaxy MCP server functions.

## Connection

```
connect(url, api_key)  # Connect to Galaxy instance
get_server_info()      # Server version and config
get_user()             # Current user details
```

## Histories

```
list_history_ids()                                      # Quick list: {id, name}
get_histories(limit, offset, name)                      # Paginated, filterable
get_history_details(history_id)                         # Metadata only, no datasets
get_history_contents(history_id, limit, offset, order)  # Datasets
create_history(history_name)                            # Create new history
```

## Datasets

```
get_dataset_details(dataset_id, include_preview, preview_lines)
download_dataset(dataset_id, file_path)  # Omit file_path for memory
upload_file(path, history_id)
upload_file_from_url(url, history_id, file_type, dbkey)
get_job_details(dataset_id)  # Job that created this dataset
```

## Tools

```
search_tools_by_name(query)
search_tools_by_keywords(keywords)  # keywords is a list
get_tool_details(tool_id, io_details)
get_tool_run_examples(tool_id)  # XML test cases
get_tool_citations(tool_id)
get_tool_panel()  # Full toolbox hierarchy
run_tool(history_id, tool_id, inputs)
```

## Workflows

```
list_workflows(workflow_id, name, published)
get_workflow_details(workflow_id, version)
invoke_workflow(workflow_id, inputs, params, history_id)
get_invocations(invocation_id, workflow_id, history_id)
cancel_workflow_invocation(invocation_id)
```

## IWC (Intergalactic Workflow Commission)

```
get_iwc_workflows()          # Full manifest
search_iwc_workflows(query)  # Search by name/description/tags
import_workflow_from_iwc(trs_id)
```

## Common Patterns

### Tool Discovery
```python
# Find candidate tools
search_tools_by_name(query="hyphy")

# Inspect I/O
get_tool_details(tool_id="toolshed.g2.bx.psu.edu/repos/iuc/hyphy_fel/hyphy_fel/2.5.84+galaxy0", io_details=True)
```

### Workflow Testing Loop
```python
# 1. Create history
create_history(history_name="Test: My Workflow")

# 2. Upload or reuse datasets
upload_file(path="/path/to/data.txt", history_id="...")

# 3. Invoke workflow
invoke_workflow(workflow_id="...", inputs={"0": {"id": "DATASET_ID", "src": "hda"}}, history_id="...")

# 4. Inspect outputs
get_history_contents(history_id="...", order="create_time-dsc")

# 5. Fix and repeat
```

### History Contents with Pagination
```python
# Page 1 (newest first)
get_history_contents(history_id="...", limit=100, offset=0, order="hid-dsc")

# Page 2
get_history_contents(history_id="...", limit=100, offset=100, order="hid-dsc")
```

## Order Options for History Contents

- `hid-asc` - oldest first (default)
- `hid-dsc` - newest first
- `create_time-dsc` - most recently created
- `update_time-dsc` - most recently modified
- `name-asc` - alphabetical

## See Also

- `history-access.md` - Detailed history/dataset access patterns
- `gotchas.md` - Common pitfalls and solutions
