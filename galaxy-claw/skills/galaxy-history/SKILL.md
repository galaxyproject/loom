---
name: galaxy-history
description: "Manage Galaxy histories via galaxy-mcp -- create, list, browse datasets, download results, and share for reproducibility"
version: 0.2.0
author: Galaxy Project
license: MIT
tags: [galaxy, history, datasets, reproducibility, provenance, mcp]
metadata:
  openclaw:
    requires:
      bins:
        - uvx
      env:
        - GALAXY_URL
        - GALAXY_API_KEY
    emoji: "📋"
    trigger_keywords:
      - galaxy history
      - history
      - datasets
      - download results
      - share history
---

# Galaxy History

Manage Galaxy histories via **galaxy-mcp** -- the core unit of reproducibility. Every tool run creates datasets in a history, and that history captures the complete provenance chain.

## Why Histories Matter

Galaxy histories are NOT just file storage. They are:

- **Complete provenance** -- every dataset knows what tool created it, with what parameters, from what inputs
- **Shareable** -- publish a history and anyone can see exactly what you did
- **Re-runnable** -- extract a workflow from a history and rerun it on new data
- **The reproducibility bundle** -- no commands.sh or environment.yml needed

## Operations via galaxy-mcp

The agent uses galaxy-mcp's history MCP tools directly:

### List histories

Get the user's recent histories with names, IDs, and dataset counts.

### Create a history

Always create a new history for each analysis with a descriptive name.
Good: "RNA-seq DE: control vs treated, 2026-03-20"
Bad: "Untitled history" or dumping everything into one history.

### Show history contents

List all datasets in a history with their states, types, and IDs.

### Upload files

Upload local files to a Galaxy history. Galaxy auto-detects file types (FASTQ, BAM, VCF, etc.)

### Download datasets

Download specific result files locally when the user needs them for external tools or reporting.

### Publish/share

Make a history accessible via link for collaborators or manuscript reviewers.

## Dataset States

| State       | Meaning                           |
| ----------- | --------------------------------- |
| `ok`        | Dataset is ready                  |
| `running`   | Job is still executing            |
| `queued`    | Job is waiting for a compute slot |
| `error`     | Job failed -- check stderr        |
| `paused`    | Waiting for upstream dependency   |
| `discarded` | Deleted                           |

## Workflow for the Agent

1. **Start an analysis** -- create a new history with a descriptive name
2. **Upload data** -- put input files into the history
3. **Run tools** -- each tool run adds output datasets to the history
4. **Check status** -- list the history to see which datasets are done
5. **Download** -- get specific results locally when needed
6. **Share** -- publish the history for collaborators or reviewers

## Tips

- Always create a new history per analysis -- don't dump everything into one
- Name histories descriptively with the analysis type and date
- After running a multi-step pipeline, check all outputs are `ok` before proceeding
- If a dataset is in `error` state, check its stderr/stdout for the failure message
- Use `publish` to generate a shareable link for manuscripts
