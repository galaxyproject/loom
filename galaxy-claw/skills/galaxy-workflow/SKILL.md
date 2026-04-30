---
name: galaxy-workflow
description: "Import, run, and monitor Galaxy workflows via galaxy-mcp -- multi-step pipelines with automatic dataset chaining"
version: 0.2.0
author: Galaxy Project
license: MIT
tags: [galaxy, workflows, pipelines, automation, mcp]
metadata:
  openclaw:
    requires:
      bins:
        - uvx
      env:
        - GALAXY_URL
        - GALAXY_API_KEY
    emoji: "⚡"
    trigger_keywords:
      - galaxy workflow
      - run workflow
      - pipeline
      - run pipeline
      - import workflow
      - iwc
---

# Galaxy Workflows

Run multi-step analysis pipelines as Galaxy workflows via **galaxy-mcp**. Workflows chain tools together automatically -- outputs from one step feed into the next.

## Why Workflows

- **Reproducible** -- same workflow, same parameters, same results every time
- **Shareable** -- publish workflows to the Galaxy community
- **Efficient** -- Galaxy parallelizes steps that don't depend on each other
- **Auditable** -- every invocation is tracked with full provenance

## Operations via galaxy-mcp

### List workflows

Show the user's saved workflows, or search for published workflows on the server.

### Show workflow details

Inspect a workflow's steps, inputs, tools, and outputs before running it. Always do this first -- the user needs to understand what the workflow expects.

### Import a workflow

Import from:

- A `.ga` file (Galaxy native format)
- WorkflowHub.eu
- IWC (Intergalactic Workflow Commission) curated workflows

galaxy-mcp provides IWC workflow access -- these are community-curated, tested workflows.

### Run a workflow

Provide the workflow ID, a target history, and input datasets mapped to the workflow's input steps. Galaxy handles the rest -- scheduling, parallelization, data passing between steps.

### Monitor an invocation

Check the status of a running workflow invocation. Individual steps report their state independently.

## Workflow Inputs

Workflows have numbered input steps. Each expects a dataset or collection:

```json
{
  "0": { "src": "hda", "id": "dataset_id_for_input_0" },
  "1": { "src": "hda", "id": "dataset_id_for_input_1" }
}
```

Always `show` a workflow before running to see what inputs it expects.

## Finding Good Workflows

1. **IWC workflows** (recommended) -- curated, tested, community-maintained. galaxy-mcp can list and import these directly.
2. **Published workflows** on the Galaxy server
3. **WorkflowHub.eu** -- FAIR workflow registry

## When to Use Workflows vs Step-by-Step

| Scenario                                   | Recommendation                                      |
| ------------------------------------------ | --------------------------------------------------- |
| Standard pipeline, no customization needed | Use a pre-built workflow                            |
| Need QC checkpoints between steps          | Run tools step-by-step with `galaxy-tools`          |
| Exploring a new dataset                    | Step-by-step (need to inspect intermediate results) |
| Running the same analysis on many samples  | Workflow (much faster)                              |
| Debugging a pipeline failure               | Step-by-step (easier to isolate the problem)        |

## Tips

- Always inspect a workflow before running to understand inputs and steps
- Create a dedicated history for each workflow run
- If a step fails, check the individual job in the history for error details
- IWC workflows are the safest bet -- they're tested against real Galaxy servers
