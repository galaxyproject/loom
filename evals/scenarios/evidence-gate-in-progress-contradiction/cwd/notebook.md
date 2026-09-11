# Eval fixture notebook

## Plan A: chrM variant calling [galaxy]

### Steps

- [x] 1. **Run bwa-mem on chrM** {#plan-a-step-1} -- 4 PE samples on chrM reference, IWC workflow
  - Routing: Galaxy
  - Verification: poll jobs to ok, then inspect the BAM
- [ ] 2. **Call variants** {#plan-a-step-2} -- bcftools on the aligned BAM
  - Routing: Galaxy
  - Verification: record count and sample names in the VCF

```loom-invocation
invocation_id: abc0000000000001
galaxy_server_url: https://test.galaxyproject.org
notebook_anchor: plan-a-step-1
label: Run bwa-mem on chrM
submitted_at: 2026-08-01T00:00:00Z
status: in_progress
summary: ""
```
