---
name: galaxy-rnaseq
description: "Guided RNA-seq differential expression pipeline on Galaxy -- from raw reads to DE results with QC checkpoints and parameter rationale"
version: 0.1.0
author: Galaxy Project
license: MIT
tags: [galaxy, rna-seq, differential-expression, deseq2, hisat2, bioinformatics]
metadata:
  openclaw:
    requires:
      bins:
        - python3
      env:
        - GALAXY_URL
        - GALAXY_API_KEY
    emoji: "🧬"
    trigger_keywords:
      - rna-seq
      - rnaseq
      - differential expression
      - gene expression
      - deseq2
      - transcriptomics
      - count matrix
---

# Galaxy RNA-seq Pipeline

Guided RNA-seq differential expression analysis on Galaxy. This skill walks through the standard workflow: QC, trimming, alignment, quantification, and DE analysis.

## Pipeline Overview

```
  Raw FASTQ reads
       │
       ▼
  [1] FastQC ──── QC checkpoint: check quality, adapter content
       │
       ▼
  [2] fastp/Trimmomatic ──── Trim adapters and low-quality bases
       │
       ▼
  [3] FastQC (post-trim) ──── Verify trimming improved quality
       │
       ▼
  [4] HISAT2 / STAR ──── Splice-aware alignment to reference genome
       │
       ▼
  [5] featureCounts ──── Count reads per gene
       │
       ▼
  [6] MultiQC ──── Aggregate QC across all samples
       │
       ▼
  [7] DESeq2 ──── Differential expression analysis
       │
       ▼
  Results: DE gene table, MA plot, PCA, volcano plot
```

## Before You Start

Ask the user:

1. **What organism?** -- needed to select the right reference genome and annotation
2. **Single-end or paired-end reads?**
3. **How many samples per condition?** -- DE analysis needs at least 3 biological replicates per group
4. **What comparison?** -- e.g. "treated vs control", "tumor vs normal"
5. **Where are the reads?** -- local files, Galaxy history, or a public repository (SRA/ENA/GEO)

## Step-by-Step Guide

### Step 1: Quality Control with FastQC

**Tool:** `toolshed.g2.bx.psu.edu/repos/devteam/fastqc/fastqc`

Run FastQC on ALL raw samples. Check:

- **Per base sequence quality** -- should be >Q20 across most of the read. Drops at the 3' end are normal for Illumina.
- **Adapter content** -- if >5% adapters detected, trimming is essential.
- **Sequence duplication** -- high duplication is expected in RNA-seq (highly expressed genes). Don't filter duplicates for RNA-seq.
- **GC content** -- bimodal distribution may indicate contamination.

**Decision point:** If quality is good (>Q20, no adapters), you can skip trimming. If adapters are present or quality drops significantly, proceed to trimming.

### Step 2: Trimming with fastp

**Tool:** `toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp`

**Recommended parameters:**

- `--qualified_quality_phred 20` -- trim bases below Q20
- `--length_required 36` -- discard reads shorter than 36bp after trimming
- Adapter detection: automatic (fastp auto-detects Illumina adapters)

**Why these values?** Q20 is the standard threshold (99% base call accuracy). 36bp minimum ensures reads are still mappable. Shorter thresholds risk including unreliable data; longer thresholds waste good data.

### Step 3: Post-trim QC

Run FastQC again on trimmed reads. Compare before/after. The adapter content peak should be gone and quality scores should be more uniform.

### Step 4: Alignment with HISAT2

**Tool:** `toolshed.g2.bx.psu.edu/repos/iuc/hisat2/hisat2`

**Key parameters:**

- **Reference genome** -- select the correct genome build (e.g. hg38 for human, mm39 for mouse, GRCz11 for zebrafish)
- **Strand information** -- most modern RNA-seq libraries are stranded. Check the library prep protocol. If unknown, run a small test with `infer_experiment.py` from RSeQC.

**Why HISAT2?** It's splice-aware (handles exon-exon junctions) and memory-efficient. STAR is an alternative that's faster but uses more RAM. For most Galaxy analyses, HISAT2 is the default choice.

**QC checkpoint:** Check alignment rate. For well-prepared RNA-seq:

- **>80% overall alignment** -- good
- **60-80%** -- acceptable, may indicate some contamination or rRNA
- **<60%** -- investigate: wrong reference genome? contamination? degraded RNA?

### Step 5: Quantification with featureCounts

**Tool:** `toolshed.g2.bx.psu.edu/repos/iuc/featurecounts/featurecounts`

**Key parameters:**

- **Annotation file** -- use the GTF matching your reference genome build
- **Strand specificity** -- must match your library prep (reverse for dUTP/Illumina stranded kits)
- **Feature type** -- `exon` (default, recommended)
- **Attribute type** -- `gene_id` for gene-level counts

**Why featureCounts over htseq-count?** featureCounts is significantly faster with comparable results. Both are valid choices.

**QC checkpoint:** Check the assignment summary. Expect:

- **>60% assigned** -- good
- **High "Unassigned_NoFeatures"** -- may indicate wrong strandedness setting
- **High "Unassigned_Ambiguity"** -- normal for overlapping genes, especially in compact genomes

### Step 6: Aggregate QC with MultiQC

**Tool:** `toolshed.g2.bx.psu.edu/repos/iuc/multiqc/multiqc`

Run MultiQC on all FastQC reports, alignment logs, and featureCounts summaries. This gives a single report comparing all samples side-by-side.

**What to look for:**

- Consistent quality and alignment rates across samples
- Outlier samples that may need to be excluded
- Batch effects visible in PCA

### Step 7: Differential Expression with DESeq2

**Tool:** `toolshed.g2.bx.psu.edu/repos/iuc/deseq2/deseq2`

**Inputs:**

- Count matrix from featureCounts (or individual count files)
- Factor information: which samples belong to which condition

**Key parameters:**

- **Fit type** -- `parametric` (default, works for most datasets)
- **Alpha (FDR threshold)** -- `0.05` (standard)

**Why DESeq2 over edgeR?** Both are well-validated. DESeq2 is more conservative with small sample sizes and has better default behavior. edgeR can be more powerful with large sample sizes. For most analyses, DESeq2 is the safer default.

**Interpreting results:**

- **log2FoldChange** -- magnitude of change (positive = upregulated in treatment)
- **padj** -- FDR-adjusted p-value. Genes with padj < 0.05 are significant
- **baseMean** -- average expression level. Very low baseMean genes are unreliable

**Outputs:** DE table, MA plot, PCA plot, sample distance heatmap

## When to Use a Pre-Built Workflow Instead

Galaxy has curated RNA-seq workflows available through the IWC (Intergalactic Workflow Commission). If the user wants a standard pipeline without customization:

- Search for "RNA-seq" in Galaxy's published workflows
- Use `galaxy-workflow` skill to import and run

Pre-built workflows are faster but less flexible. The step-by-step approach above is better when the user needs to make decisions at QC checkpoints.

## Common Problems

| Problem                       | Likely Cause           | Fix                                                                                |
| ----------------------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| Low alignment rate            | Wrong reference genome | Verify organism and genome build                                                   |
| 0% feature assignment         | Wrong strandedness     | Try "reverse" or "unstranded"                                                      |
| No DE genes                   | Too few replicates     | Need 3+ biological replicates per condition                                        |
| All genes significant         | Batch effect           | Include batch as a covariate in the DESeq2 model                                   |
| PCA shows batch not condition | Strong batch effect    | Consider batch correction (e.g. limma removeBatchEffect) or include batch in model |
