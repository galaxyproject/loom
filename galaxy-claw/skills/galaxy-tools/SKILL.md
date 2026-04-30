---
name: galaxy-tools
description: "Search, inspect, and execute any of Galaxy's 8,000+ bioinformatics tools via galaxy-mcp with full parameter schemas and history-persistent results"
version: 0.2.0
author: Galaxy Project
license: MIT
tags: [galaxy, bioinformatics, tools, execution, mcp]
metadata:
  openclaw:
    requires:
      bins:
        - uvx
      env:
        - GALAXY_URL
        - GALAXY_API_KEY
    emoji: "🔧"
    trigger_keywords:
      - galaxy tool
      - run tool
      - search tools
      - fastqc
      - hisat2
      - deseq2
      - kraken
      - bwa
      - samtools
      - trimmomatic
      - bioinformatics tool
---

# Galaxy Tools

Search, inspect, and run any tool from Galaxy's 8,000+ bioinformatics tools via **galaxy-mcp**. Results persist in Galaxy histories with full provenance.

## Key Principle

**Do NOT hardcode parameters.** Galaxy tools expose full parameter schemas via the API. Always inspect a tool's inputs before running it, and let the user confirm parameter choices. The right parameters depend on the data and the research question.

## How It Works

galaxy-mcp exposes Galaxy's tool API as MCP tools. The agent uses these directly -- no wrapper scripts needed.

### Search for tools

Use the galaxy-mcp `search_tools` tool with a keyword query. Galaxy searches tool names, descriptions, and panel sections.

### Inspect tool parameters

Use the galaxy-mcp tool detail/show endpoint to get the full input schema. Galaxy tools have rich parameter definitions including:

- Required vs optional inputs
- Data type constraints (FASTQ, BAM, VCF, etc.)
- Conditional parameters (show X only when Y is selected)
- Default values with domain-appropriate presets

As of Galaxy v26.0, tools also expose formal JSON Schema at `/api/tools/{tool_id}/parameter_request_schema` -- this handles conditionals as `oneOf` discriminated unions, repeats as arrays, and sections as nested objects.

### Run a tool

Use galaxy-mcp's tool execution. Provide:

- **Tool ID** -- from the search results
- **History ID** -- where to put the outputs (create one first if needed)
- **Inputs** -- parameter values matching the tool's schema

The job runs server-side on Galaxy infrastructure. Poll for completion.

## Common Tools by Category

### Quality Control

- **FastQC** -- read quality reports
- **MultiQC** -- aggregate QC across samples
- **fastp** -- all-in-one preprocessing (trim, filter, QC)
- **Trimmomatic** -- adapter trimming

### Alignment

- **BWA-MEM2** -- short read alignment (DNA)
- **HISAT2** -- spliced alignment (RNA-seq)
- **minimap2** -- long read alignment
- **Bowtie2** -- short read alignment

### Quantification

- **featureCounts** -- gene-level read counting
- **Salmon** -- transcript quantification (alignment-free)
- **StringTie** -- transcript assembly and quantification

### Differential Expression

- **DESeq2** -- differential expression (count-based)
- **edgeR** -- differential expression (count-based)
- **limma-voom** -- differential expression

### Variant Calling

- **FreeBayes** -- short variant calling
- **GATK4 HaplotypeCaller** -- germline variant calling
- **bcftools** -- variant manipulation and filtering

### Metagenomics

- **Kraken2** -- taxonomic classification
- **MetaPhlAn** -- microbial profiling
- **HUMAnN** -- functional profiling

### File Manipulation

- **samtools** -- BAM/SAM manipulation
- **bedtools** -- BED/interval operations

## Tips for the Agent

- When the user describes an analysis goal, search for the relevant tool category first
- Always inspect a tool's inputs before running -- never guess parameter values
- Prefer tools from `iuc` or `devteam` owners -- these are community-maintained and tested
- If multiple tool versions exist, prefer the latest
- After running, check the history to verify outputs are in `ok` state before proceeding
- Galaxy tool IDs look like `toolshed.g2.bx.psu.edu/repos/iuc/fastqc/fastqc/0.74+galaxy1` -- use the full ID including version
