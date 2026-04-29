---
name: galaxy-variant
description: "Guided variant calling pipeline on Galaxy -- from aligned reads to annotated variants with QC checkpoints"
version: 0.1.0
author: Galaxy Project
license: MIT
tags: [galaxy, variant-calling, genomics, snp, indel, vcf]
metadata:
  openclaw:
    requires:
      bins:
        - python3
      env:
        - GALAXY_URL
        - GALAXY_API_KEY
    emoji: "🔬"
    trigger_keywords:
      - variant calling
      - snp
      - indel
      - vcf
      - mutations
      - germline variants
      - somatic variants
      - whole genome sequencing
      - whole exome sequencing
      - wgs
      - wes
---

# Galaxy Variant Calling Pipeline

Guided variant calling on Galaxy -- from raw reads or aligned BAMs to annotated, filtered variant calls.

## Pipeline Overview

```
  Raw FASTQ reads (or BAM)
       │
       ▼
  [1] FastQC ──── QC checkpoint
       │
       ▼
  [2] fastp ──── Trim adapters/quality
       │
       ▼
  [3] BWA-MEM2 ──── Align to reference genome
       │
       ▼
  [4] samtools markdup ──── Mark PCR duplicates
       │
       ▼
  [5] FreeBayes / GATK4 ──── Call variants
       │
       ▼
  [6] bcftools filter ──── Quality filtering
       │
       ▼
  [7] SnpEff / VEP ──── Functional annotation
       │
       ▼
  Annotated VCF with impact predictions
```

## Before You Start

Ask the user:

1. **Germline or somatic?** -- different callers and filtering strategies
2. **What organism and genome build?** -- e.g. hg38, mm39, GRCz11
3. **WGS or WES/targeted?** -- affects depth expectations and filtering
4. **Single sample or cohort?**
5. **Starting from FASTQ or BAM?**

## Step-by-Step Guide

### Step 1-2: QC and Trimming

Same as RNA-seq pipeline. Use FastQC and fastp. For variant calling, quality is critical -- even a small number of bad bases can produce false positive variants.

### Step 3: Alignment with BWA-MEM2

**Tool:** `toolshed.g2.bx.psu.edu/repos/iuc/bwa_mem2/bwa_mem2`

**Key parameters:**

- **Reference genome** -- must match the genome build exactly
- For paired-end: provide both R1 and R2

**Why BWA-MEM2 over BWA-MEM?** BWA-MEM2 is the successor with identical output but 2-3x faster. Use it when available.

**QC checkpoint:** Alignment rate should be >95% for WGS, >90% for WES.

### Step 4: Mark Duplicates

**Tool:** `toolshed.g2.bx.psu.edu/repos/devteam/samtools_markdup/samtools_markdup`

PCR duplicates inflate variant allele frequencies. Mark them so callers can ignore them.

**Expected duplication rates:**

- WGS: 5-15% is normal
- WES: 10-30% is normal (capture-based enrichment creates more duplicates)
- > 40%: library quality concern

### Step 5: Variant Calling

**For germline variants:**

**FreeBayes** (`toolshed.g2.bx.psu.edu/repos/devteam/freebayes/freebayes`):

- Good all-around caller, works well for single samples and small cohorts
- Key param: `--min-alternate-fraction 0.2` for diploid organisms
- Sensitive to low-frequency variants

**GATK4 HaplotypeCaller** (if available on your Galaxy):

- Industry standard for germline calling
- Best with GATK Best Practices pipeline (BaseRecalibration first)
- More conservative than FreeBayes

**For somatic variants:**

- Requires matched tumor-normal pairs
- Use **Mutect2** (GATK4) or **VarScan2**
- Filtering is more aggressive -- somatic variants are rare

### Step 6: Variant Filtering

**Tool:** `toolshed.g2.bx.psu.edu/repos/iuc/bcftools_filter/bcftools_filter`

**Recommended filters for germline FreeBayes calls:**

- `QUAL > 20` -- minimum variant quality
- `DP > 10` -- minimum read depth
- `AO > 3` -- minimum alternate observations

**Why these thresholds?**

- QUAL 20 = 99% confidence the variant is real
- DP 10 = enough coverage to call a heterozygous variant reliably
- AO 3 = reduces single-read artifacts

Adjust for your data: WGS with 30x coverage can use stricter filters; low-coverage data may need relaxed thresholds.

### Step 7: Functional Annotation

**SnpEff** (`toolshed.g2.bx.psu.edu/repos/iuc/snpeff/snpEff`):

- Fast, gene-model-based annotation
- Reports impact: HIGH (frameshift, stop-gain), MODERATE (missense), LOW (synonymous), MODIFIER (intronic/intergenic)

**VEP** (Variant Effect Predictor):

- More detailed, includes SIFT/PolyPhen predictions
- Slower but richer annotation

## Common Problems

| Problem                           | Likely Cause                      | Fix                                    |
| --------------------------------- | --------------------------------- | -------------------------------------- |
| Too many variants (>5M for WGS)   | Insufficient filtering            | Apply stricter QUAL/DP filters         |
| Too few variants                  | Over-filtered or wrong ref genome | Check reference build, relax filters   |
| Transition/transversion ratio off | Ti/Tv should be ~2.0-2.1 for WGS  | If <1.5 or >3.0, investigate quality   |
| Many variants in repeats          | Mapping artifacts                 | Filter by mappability or use GATK BQSR |
