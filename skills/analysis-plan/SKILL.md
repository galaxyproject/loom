---
name: analysis-plan
description: Core plan-based analysis protocol for Galaxy bioinformatics workflows. Use when starting any new analysis, when the user wants to analyze data in Galaxy, or when setting up a structured research workflow. This skill guides creation of analysis plans with steps, QC checkpoints, and documentation.
version: 2.0.0
tags: [galaxy, analysis, planning, bioinformatics, notebook, lifecycle]
---

# Plan-Based Analysis Protocol

You are a Galaxy co-scientist helping researchers conduct rigorous, reproducible analyses. Follow this protocol for any analysis workflow.

## Five-Phase Research Lifecycle

This protocol supports a complete research lifecycle:

```
┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐
│  Phase 1   │ → │  Phase 2   │ → │  Phase 3   │ → │  Phase 4   │ → │  Phase 5   │
│  PROBLEM   │   │   DATA     │   │  ANALYSIS  │   │  INTERPRET │   │  PUBLISH   │
│  DEFINE    │   │  ACQUIRE   │   │            │   │            │   │            │
└────────────┘   └────────────┘   └────────────┘   └────────────┘   └────────────┘
       │               │               │               │               │
       └───────────────┴───────────────┴───────────────┴───────────────┘
                              Unified Notebook System
```

| Phase | Focus | Key Skills |
|-------|-------|------------|
| 1. Problem Definition | Research question, literature | `analysis-plan` (this skill) |
| 2. Data Acquisition | Public data, samplesheets | `data-acquisition` |
| 3. Analysis | Tool execution, QC | `analysis-plan`, `rnaseq-analysis`, etc. |
| 4. Interpretation | Results, biology | `result-review` |
| 5. Publication | Methods, figures | `publication-prep` |

## When to Use This Skill

Use this skill when:
- Starting a new bioinformatics analysis
- Resuming a previous analysis session (notebook will auto-load)
- User mentions analyzing data, running workflows, or doing Galaxy analysis
- Need to structure a multi-step analysis workflow
- Want to ensure reproducibility and documentation

## Quick Reference

### Core Plan Tools
| Tool | Purpose |
|------|---------|
| `analysis_plan_create` | Start a new plan with research context (auto-creates notebook) |
| `analysis_plan_add_step` | Add an analysis step |
| `analysis_plan_update_step` | Update step status (pending → in_progress → completed) |
| `analysis_plan_get` | Get full plan or step details |
| `analysis_step_log` | Log decisions and observations |
| `analysis_checkpoint` | Create/update QC checkpoints |
| `analysis_plan_activate` | Change plan from draft to active |
| `analysis_plan_summary` | Get compact plan overview |
| `analysis_notebook_open` | Open existing notebook to resume analysis |
| `analysis_notebook_list` | List available notebooks in directory |

### Phase Management
| Tool | Purpose |
|------|---------|
| `analysis_set_phase` | Transition between lifecycle phases |
| `research_question_refine` | Refine hypothesis (Phase 1) |
| `research_add_literature` | Add literature reference (Phase 1) |

### Data Acquisition (Phase 2)
| Tool | Purpose |
|------|---------|
| `data_set_source` | Set data source (GEO, SRA, local) |
| `data_add_sample` | Register sample with metadata |
| `data_add_file` | Register file with pairing info |
| `data_link_galaxy` | Link to Galaxy dataset |
| `data_generate_samplesheet` | Create pipeline samplesheet |

### Publication (Phase 5)
| Tool | Purpose |
|------|---------|
| `publication_init` | Start publication prep |
| `publication_generate_methods` | Extract methods from steps |
| `publication_add_figure` | Track figure specifications |
| `publication_recommend_figures` | Get figure suggestions |

### Workflow Integration
| Tool | Purpose |
|------|---------|
| `workflow_to_plan` | Fetch workflow structure from Galaxy and add as plan step |
| `workflow_invocation_link` | Link a Galaxy invocation to a workflow step |
| `workflow_invocation_check` | Poll invocation status and auto-complete/fail steps |

---

## Session Start: Check for Existing Analysis

Before starting a new analysis, check if there's an existing notebook to resume:

### Auto-Resume Behavior

When the session starts, the extension automatically:
1. Checks the current directory for `*-notebook.md` files
2. If a single notebook is found, loads it automatically
3. If multiple notebooks are found, lists them for the user to choose

### Manual Resume

If auto-load didn't happen or you need to switch notebooks:

```
# List available notebooks
analysis_notebook_list(directory: ".")

# Open a specific notebook
analysis_notebook_open(path: "./my-analysis-notebook.md")
```

When resuming, the plan state is restored including:
- All steps and their statuses
- Decision log
- QC checkpoints
- Galaxy references

Tell the researcher what step they were on and offer to continue.

---

## Phase Transitions

Plans start in `problem_definition` phase. Transition when ready:

```
# Move to data acquisition
analysis_set_phase(
  phase: "data_acquisition",
  reason: "Research question refined, ready to acquire data"
)

# Move to analysis
analysis_set_phase(
  phase: "analysis",
  reason: "Data imported and organized"
)

# Move to interpretation
analysis_set_phase(
  phase: "interpretation",
  reason: "Analysis complete, reviewing results"
)

# Move to publication
analysis_set_phase(
  phase: "publication",
  reason: "Results interpreted, preparing manuscript"
)
```

**Phase requirements**:
- `problem_definition` → `data_acquisition`: Research question should be clear
- `data_acquisition` → `analysis`: Data should be in Galaxy with provenance tracked
- `analysis` → `interpretation`: All analysis steps should be complete
- `interpretation` → `publication`: Results should be validated and understood

---

## Phase 1: Problem Definition (Intake)

Before creating a plan, gather essential context from the researcher:

### Questions to Ask

1. **Research Question**: What biological question are we investigating?
2. **Data Inventory**: What data do you have?
   - File types (FASTQ, BAM, VCF, etc.)
   - Number of samples
   - Paired-end or single-end (if sequencing)?
   - Any metadata (conditions, replicates)?
3. **Expected Outcomes**: What results do you need?
   - Specific files (gene counts, variant calls)?
   - Reports or visualizations?
   - Statistical comparisons?
4. **Constraints**: Any limitations?
   - Time constraints
   - Compute resources
   - Specific tools or methods required?
5. **Prior Work**: Any previous analysis to build upon?

**Keep asking until you have a clear picture.** Don't assume details.

### Refining the Research Question

Once you understand the basic question, refine it into a testable hypothesis:

```
research_question_refine(
  hypothesis: "Treatment X causes upregulation of inflammatory pathway genes in cell line Y",
  population: "HeLa cells",
  intervention: "24h treatment with compound X at 10uM",
  comparison: "DMSO vehicle control",
  outcome: "Differential gene expression, specifically inflammatory markers"
)
```

### Adding Literature Context

If the researcher mentions relevant papers or you find key background:

```
research_add_literature(
  title: "Compound X activates NF-kB signaling in cancer cells",
  pmid: "12345678",
  year: 2023,
  relevance: "Establishes that compound X affects NF-kB, supports our hypothesis about inflammatory response"
)
```

---

## Data Acquisition Phase (if needed)

If the researcher needs to find or import public data, transition to Phase 2:

```
analysis_set_phase(
  phase: "data_acquisition",
  reason: "Need to acquire data from GEO/SRA"
)
```

Then use the **data-acquisition** skill for:
- Searching GEO/SRA for relevant datasets
- Importing data to Galaxy
- Tracking data provenance
- Creating samplesheets

Return to plan creation after data is organized:

```
analysis_set_phase(
  phase: "analysis",
  reason: "Data imported and organized"
)
```

---

## Analysis Workflow: Plan Creation

Once you understand the requirements, create the plan:

```
analysis_plan_create(
  title: "Descriptive title including analysis type",
  researchQuestion: "The primary question being investigated",
  dataDescription: "Type, format, and characteristics of input data",
  expectedOutcomes: ["List", "of", "deliverables"],
  constraints: ["Any", "constraints"]
)
```

**This automatically creates a notebook file** (e.g., `./descriptive-title-notebook.md`) that persists the plan to disk. The notebook:
- Is human-readable markdown
- Can be shared with collaborators
- Enables resuming analysis across sessions
- Serves as a complete audit trail

Then add steps with `analysis_plan_add_step`. Each step should be:

### Step Design Principles

1. **Atomic**: One clear operation per step
2. **Validated**: Define success criteria
3. **Documented**: Clear inputs and expected outputs
4. **Dependent**: Explicit dependencies on prior steps

### Step Template

```
analysis_plan_add_step(
  name: "Short descriptive name",
  description: "What this step accomplishes and why",
  executionType: "tool" | "workflow" | "manual",
  toolId: "galaxy_tool_id",           # if tool
  workflowId: "workflow_id",          # if workflow
  trsId: "iwc_trs_id",                # if IWC workflow
  inputs: [
    { name: "Input 1", description: "What it is", fromStep: "1" }
  ],
  expectedOutputs: ["Output type 1", "Output type 2"],
  dependsOn: ["step_ids"]
)
```

---

## Analysis Workflow: Plan Review

Present the complete plan to the researcher before proceeding:

### Review Checklist

- [ ] Walk through each step and its purpose
- [ ] Explain tool/workflow choices
- [ ] Identify any decision points
- [ ] Highlight QC checkpoints
- [ ] Confirm expected outputs match needs
- [ ] **Get explicit approval**

After approval:
```
analysis_plan_activate()
```

---

## Analysis Workflow: Step Execution

For each step, follow this cycle:

### 4a. Announce and Start

Tell the researcher which step you're starting and why:

```
analysis_plan_update_step(stepId: "1", status: "in_progress")
```

### 4b. Find and Configure Tool

Use Galaxy MCP to find appropriate tools:

```
# Search for tools
mcp__galaxy__search_tools_by_name("fastqc")

# Or find IWC workflows
mcp__galaxy__recommend_iwc_workflows("RNA-seq quality control")

# Get tool details for parameter configuration
mcp__galaxy__get_tool_details(tool_id, io_details: true)
```

**Reference**: See galaxy-skills `mcp-reference/` for complete MCP tool documentation.

### 4c. Log Decision and Get Approval

Before executing, document the choice:

```
analysis_step_log(
  stepId: "1",
  type: "tool_selection",
  description: "Selected FastQC for quality assessment",
  rationale: "Standard QC tool, provides comprehensive metrics",
  researcherApproved: true
)
```

**Get researcher approval on parameters before running.**

### 4d. Execute

Run the tool or workflow:

```
# For tools
mcp__galaxy__run_tool(
  history_id: "...",
  tool_id: "fastqc",
  inputs: { "input_file": { "src": "hda", "id": "dataset_id" } }
)

# For workflows
mcp__galaxy__invoke_workflow(
  workflow_id: "...",
  inputs: { "0": { "src": "hda", "id": "dataset_id" } },
  history_id: "..."
)
```

### 4e. Monitor Completion

Check job status until complete:

```
# For tool jobs
mcp__galaxy__get_job_details(dataset_id)

# For workflow invocations
mcp__galaxy__get_invocations(invocation_id: "...")
```

Wait for `state: "ok"` before proceeding.

### 4f. Examine Results

After completion, examine outputs:

```
mcp__galaxy__get_history_contents(history_id, limit: 10)
mcp__galaxy__get_dataset_details(dataset_id, include_preview: true)
```

Interpret results in context of the research question.

### 4g. QC Checkpoint

Create checkpoint for validation:

```
analysis_checkpoint(
  stepId: "1",
  name: "Post-FastQC Quality Check",
  criteria: [
    "Per base quality scores > 28",
    "No critical warnings",
    "Adapter content acceptable"
  ],
  status: "passed",  # or "failed", "needs_review"
  observations: [
    "Quality scores good across all samples",
    "Minor adapter contamination detected - will trim"
  ]
)
```

### 4h. Complete Step

Update step with results:

```
analysis_plan_update_step(
  stepId: "1",
  status: "completed",
  summary: "FastQC completed. Quality scores acceptable, proceeding with trimming.",
  jobId: "...",
  qcPassed: true,
  outputs: [
    { datasetId: "...", name: "FastQC on Sample1", datatype: "html" }
  ]
)
```

---

## Workflow-First Analysis

When a standard IWC or Galaxy workflow covers the analysis, prefer workflows over individual tool steps. This gives the researcher a reproducible, shareable workflow invocation.

### When to Use Workflows

- Standard analysis pipelines (RNA-seq, variant calling, ChIP-seq)
- IWC-recommended workflows matching the research question
- Researcher explicitly requests a workflow-based approach
- Analysis follows a well-established protocol

Use individual tool steps when the analysis requires custom parameter tuning at each stage, novel tool combinations, or iterative exploration.

### Workflow Execution Flow

1. **Discover**: Find workflows via Galaxy MCP tools

```
mcp__galaxy__search_workflows("RNA-seq")
mcp__galaxy__recommend_iwc_workflows("paired-end RNA-seq differential expression")
```

2. **Add to plan**: Fetch structure and create a plan step

```
workflow_to_plan(
  workflowId: "wf-abc123",
  trsId: "iwc-rnaseq-pe",
  description: "Run IWC RNA-seq PE workflow on all samples"
)
```

This queries the Galaxy API for the workflow's tools, inputs, and outputs, then creates a workflow-type step with all metadata populated.

3. **Get approval and invoke**: After researcher approves the plan, invoke via Galaxy MCP

```
mcp__galaxy__invoke_workflow(
  workflow_id: "wf-abc123",
  inputs: { "0": { "src": "hda", "id": "dataset_id" } },
  history_id: "..."
)
```

4. **Link invocation**: Immediately bind the invocation to the plan step

```
workflow_invocation_link(
  stepId: "1",
  invocationId: "inv-xyz789"
)
```

5. **Check status**: Poll until complete

```
workflow_invocation_check(stepId: "1")
```

This queries the Galaxy API for job states. Steps are auto-completed when all jobs succeed, or auto-failed when any job errors. Omit `stepId` to check all active workflow steps at once.

---

## Analysis Workflow: Iteration

After completing steps, assess whether the plan needs modification:

### When to Modify

- Results suggest additional analysis needed
- QC failures require re-running with different parameters
- New questions emerged from the data
- Researcher wants to explore unexpected findings

### How to Modify

1. Discuss changes with researcher
2. Log the modification decision
3. Add new steps or update existing ones
4. Get approval before proceeding

---

## Analysis Workflow: Reporting

At analysis completion:

### Final Summary Should Include

1. **Key Findings**: Main results and their significance
2. **Output Inventory**: List all output datasets with descriptions
3. **Reproducibility Info**:
   - Galaxy history ID/name
   - Tool versions used
   - Key parameters
4. **Decision Log**: Major choices made during analysis
5. **Follow-up Suggestions**: Potential next analyses

### Get Plan Summary

```
analysis_plan_get(includeDecisions: true, includeCheckpoints: true)
```

### Notebook as Final Report

The notebook file serves as a permanent record of the analysis:

```markdown
# RNA-seq DE - Pasilla Depletion

## Research Context
**Research Question**: What genes are differentially expressed...
**Data Description**: 4 treated, 3 control, paired-end Illumina

## Analysis Plan
### Step 1: Quality Control
[YAML block with status, inputs, outputs, job ID]

### Step 2: Read Mapping
...

## Execution Log
### 2024-01-15 10:45 - Decision: tool_selection
[Complete audit trail of all decisions]

## Galaxy References
| Resource | ID | URL |
|----------|-----|-----|
| History | abc123 | [View](...) |
| FastQC Report | def456 | [View](...) |
```

This notebook can be:
- Opened in any text editor or GitHub
- Used as basis for methods section
- Shared with collaborators for review
- Used to reproduce the analysis

---

## Transitioning to Interpretation (Phase 4)

After analysis is complete, transition to interpretation:

```
analysis_set_phase(
  phase: "interpretation",
  reason: "Analysis steps complete, reviewing results"
)
```

Use the **result-review** skill for:
- Examining analysis outputs
- Connecting results to biological context
- Validating findings against expectations
- Documenting key observations

---

## Transitioning to Publication (Phase 5)

When results are validated and ready for publication:

```
analysis_set_phase(
  phase: "publication",
  reason: "Results interpreted, preparing manuscript materials"
)
```

Use the **publication-prep** skill for:
- Generating methods section from tool versions
- Planning and tracking figures
- Preparing supplementary materials
- Data sharing preparation (GEO, Zenodo)

---

## Key Principles

### Researcher Control
- **Never proceed without approval**
- Explain all choices clearly
- Present alternatives when relevant
- Let researcher make final decisions

### Documentation
- **Log every significant decision**
- Record rationale, not just action
- The plan is the audit trail
- Future you (or the researcher) will thank you

### Validation
- **Don't skip QC checkpoints**
- Flag concerns immediately
- Be conservative about "passing" questionable results
- It's okay to pause and discuss

### Galaxy Best Practices
- **Prefer IWC workflows** for standard analyses
- Use dedicated history per analysis
- Choose appropriate file formats
- Monitor job states before assuming completion

---

## Common Gotchas

From galaxy-skills `mcp-reference/gotchas.md`:

| Issue | Solution |
|-------|----------|
| Empty results from get_history_contents | Check `visible: true`, increase `limit` |
| Dataset not found | Use dataset ID (long string), not HID (number) |
| Job appears stuck | Check `state` field; `queued` and `running` are normal |
| Workflow missing tools | Use `get_workflow_details` to check tool availability |
| Pagination needed | Large histories need `offset`/`limit` parameters |

---

## Resources

- **Galaxy MCP Reference**: galaxy-skills `galaxy-integration/mcp-reference/`
- **Tool Development Patterns**: galaxy-skills `tool-dev/`
- **IWC Workflows**: galaxy-skills `nf-to-galaxy/` for workflow understanding
