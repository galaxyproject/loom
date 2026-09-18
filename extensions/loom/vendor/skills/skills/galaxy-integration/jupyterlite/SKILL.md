---
name: jupyterlite-galaxy
description: Write JupyterLite notebooks that read and write Galaxy datasets in the browser with the gxy package. Use when the analysis needs custom Python over data already in a history -- plotting, reshaping, ad-hoc inspection -- rather than a Galaxy tool run, or when the user asks for a notebook inside Galaxy.
user_invocable: true
---

# JupyterLite Galaxy Notebook Skill

When helping users write JupyterLite notebooks for Galaxy:

## Quick Reference

### Import
```python
import gxy
```

### Download Datasets
```python
# By HID (history item number)
path = await gxy.get(1)           # single dataset
paths = await gxy.get([1, 2, 3])  # multiple

# By name (partial match)
path = await gxy.get("sample", identifier_type="name")

# By tag
path = await gxy.get("input_data", identifier_type="tag")

# By regex
paths = await gxy.get(r".*\.fastq$", identifier_type="regex")

# By dataset ID
path = await gxy.get("f9cad7b01a472135", identifier_type="id")

# Get datatype too
path, dtype = await gxy.get(1, retrieve_datatype=True)
```

### Upload Results
```python
# Upload file to history
await gxy.put("output.csv")

# Custom name and extension
await gxy.put("results.txt", output="My Analysis Results", ext="tabular")

# With genome build
await gxy.put("variants.vcf", ext="vcf", dbkey="hg38")
```

### API Calls (GET and POST only)
```python
# GET request (default)
user = await gxy.api("/api/users/current")

# POST request
result = await gxy.api("/api/histories", method="POST", data={"name": "New History"})

# NOTE: Only GET and POST supported. No PUT, DELETE, PATCH.
```

### History Info
```python
# Get current history ID
history_id = await gxy.get_history_id()

# Get visible datasets in history (not deleted/hidden)
datasets = await gxy.get_history()
for ds in datasets:
    print(f"{ds['hid']}: {ds['name']} ({ds['extension']})")
```

## Common Patterns

### Read tabular data with pandas
```python
import gxy
import pandas as pd

path = await gxy.get(1)
df = pd.read_csv(path, sep="\t")
```

### Process FASTA
```python
import gxy

path = await gxy.get("sequences", identifier_type="name")
with open(path) as f:
    for line in f:
        if line.startswith(">"):
            print(line.strip())
```

### Save plot to Galaxy
```python
import gxy
import matplotlib.pyplot as plt

plt.plot([1, 2, 3], [1, 4, 9])
plt.savefig("plot.png")
await gxy.put("plot.png", output="My Plot", ext="png")
```

### Batch processing
```python
import gxy

paths = await gxy.get(r".*\.fastq$", identifier_type="regex")
for path in paths:
    # process each file
    result = process(path)
    await gxy.put(result)
```

## Important Notes

1. All gxy functions are **async** - use `await`
2. Downloaded files go to Pyodide virtual filesystem
3. File naming: `{hid}.{ext}.{id}.{txt|dat}`
4. Collections (`hdca`) not yet supported
5. Pre-installed packages: pandas, numpy, matplotlib, seaborn, plotly
6. Source: [galaxy-visualizations/jupyterlite/gxy](https://github.com/galaxyproject/galaxy-visualizations/blob/main/packages/jupyterlite/gxy/gxy/__init__.py)

## Workflow with MCP

Before writing notebook code, use Galaxy MCP tools to discover datasets:

```
# In Claude Code, use MCP to find dataset IDs:
get_history_contents(history_id="...")

# Then reference those IDs in notebook code:
path = await gxy.get("dataset_id_here", identifier_type="id")
```

## Examples

See `examples/` for complete notebooks:
- `average_col3.ipynb` - Simple tabular data processing
- `extract_sample_metadata.ipynb` - Metadata extraction with regex
- `variant_annotation.ipynb` - Complex analysis with Biopython + visualization
- `vcp_variant_map.ipynb` - Geographic visualization with Altair
