---
name: galaxy-metagenomics
description: "Guided metagenomics profiling pipeline on Galaxy -- taxonomic classification, functional profiling, and diversity analysis"
version: 0.1.0
author: Galaxy Project
license: MIT
tags: [galaxy, metagenomics, microbiome, kraken2, metaphlan, 16s]
metadata:
  openclaw:
    requires:
      bins:
        - python3
      env:
        - GALAXY_URL
        - GALAXY_API_KEY
    emoji: "🦠"
    trigger_keywords:
      - metagenomics
      - microbiome
      - 16s
      - taxonomic classification
      - kraken
      - metaphlan
      - microbial community
      - amplicon sequencing
---

# Galaxy Metagenomics Pipeline

Guided metagenomics analysis on Galaxy -- from raw reads to community composition profiles and functional annotations.

## Two Main Approaches

### Amplicon sequencing (16S/18S/ITS)

Targeted sequencing of marker genes. Cheaper, good for "who's there?" questions.

### Whole metagenome shotgun (WMS)

Sequence everything. More expensive, but answers "who's there?" AND "what are they doing?"

Ask the user which type of data they have before proceeding.

## Shotgun Metagenomics Pipeline

```
  Raw FASTQ reads
       │
       ▼
  [1] FastQC ──── QC checkpoint
       │
       ▼
  [2] fastp ──── Trim and filter
       │
       ▼
  [3] Host depletion (optional) ──── Remove human reads if needed
       │
       ├───────────────────┐
       ▼                   ▼
  [4a] Kraken2          [4b] MetaPhlAn
  (fast, k-mer)         (marker gene)
       │                   │
       ▼                   ▼
  [5a] Bracken          Taxonomic profile
  (abundance re-est.)
       │
       ▼
  [6] HUMAnN ──── Functional profiling (pathways, gene families)
       │
       ▼
  Community composition + functional capacity
```

## Step-by-Step: Shotgun Metagenomics

### Step 1-2: QC and Trimming

Same as other pipelines. Quality is important -- metagenomic classification is sensitive to sequencing errors.

### Step 3: Host Depletion (if applicable)

**When to do this:** Human microbiome samples (gut, skin, oral) contain significant human DNA. Remove it before classification.

**Tool:** BWA-MEM2 against the human reference, then extract unmapped reads with samtools.

**Why:** Human reads would be classified as "unknown" or misclassified. Removing them speeds up classification and improves accuracy.

### Step 4a: Taxonomic Classification with Kraken2

**Tool:** `toolshed.g2.bx.psu.edu/repos/iuc/kraken2/kraken2`

**Key parameters:**

- **Database** -- critical choice. Galaxy provides several:
  - `Standard` -- bacteria, archaea, viruses, human (most common)
  - `PlusPF` -- standard + protozoa + fungi
  - `PlusPFP` -- everything including plants
- **Confidence threshold** -- `0.0` (default). Increase to 0.1 for fewer false positives.
- **Minimum hit groups** -- `2` (default). Increase for more specificity.

**Why Kraken2?** Fastest classifier (millions of reads/minute). Good for initial screening. Not the most accurate at species level -- use MetaPhlAn for that.

### Step 4b: Alternative -- MetaPhlAn

**Tool:** `toolshed.g2.bx.psu.edu/repos/iuc/metaphlan/metaphlan`

MetaPhlAn uses clade-specific marker genes. Slower than Kraken2 but more accurate at species level. Better for quantitative abundance estimates.

**When to choose MetaPhlAn over Kraken2:**

- Quantitative species-level abundance is important
- Low-biomass samples where false positives are costly
- Published benchmarks matter for your study

### Step 5: Abundance Re-estimation with Bracken

**Tool:** `toolshed.g2.bx.psu.edu/repos/iuc/bracken/bracken`

Bracken refines Kraken2's output by redistributing reads classified at higher taxonomic levels. Use it after Kraken2 for better species-level abundance estimates.

**Key parameter:** `--level S` (species level, default and recommended)

### Step 6: Functional Profiling with HUMAnN

**Tool:** `toolshed.g2.bx.psu.edu/repos/iuc/humann/humann`

HUMAnN profiles metabolic pathways and gene families. Answers "what is the community doing?"

**Outputs:**

- **Gene families** -- UniRef90/50 gene family abundances
- **Pathway abundance** -- MetaCyc pathway abundances
- **Pathway coverage** -- what fraction of each pathway is present

## 16S/ITS Amplicon Pipeline

For amplicon data, the pipeline is different:

```
  Paired FASTQ (16S amplicon)
       │
       ▼
  [1] DADA2 / QIIME2 dada2 ──── Denoise, error-correct, make ASVs
       │
       ▼
  [2] Taxonomic classification ──── SILVA/Greengenes/UNITE database
       │
       ▼
  [3] Diversity analysis ──── Alpha/beta diversity, ordination
       │
       ▼
  Community composition + diversity metrics
```

Galaxy has QIIME2 tools for the full amplicon workflow. Use the `galaxy-tools` skill to search for "qiime2" or "dada2".

## Common Problems

| Problem                    | Likely Cause                             | Fix                                                      |
| -------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| Most reads unclassified    | Wrong database or host contamination     | Try a more comprehensive database; check for host reads  |
| Unrealistic species        | Database contamination or low confidence | Increase confidence threshold; filter low-abundance taxa |
| Very low diversity         | Over-aggressive quality filtering        | Relax fastp parameters; check for primer contamination   |
| Batch effects in diversity | DNA extraction method differences        | Include extraction batch as covariate                    |

## Key Decision: Kraken2 vs MetaPhlAn

| Criterion          | Kraken2                           | MetaPhlAn                     |
| ------------------ | --------------------------------- | ----------------------------- |
| Speed              | Very fast                         | Moderate                      |
| Accuracy (species) | Good                              | Better                        |
| Quantification     | Relative (use Bracken)            | Directly quantitative         |
| Database           | General genomic                   | Marker genes only             |
| False positives    | More                              | Fewer                         |
| Recommendation     | Initial screening, large datasets | Publication-quality abundance |
