---
type: research
tags:
  - target/galaxy
status: draft
created: 2026-04-30
revised: 2026-05-03
revision: 2
related_notes:
  - "galaxy-workflow-testability-design"
  - "iwc-test-data-conventions"
  - "planemo-asserts-idioms"
  - "implement-galaxy-workflow-test"
  - "tests-format"
  - "iwc-conditionals-survey"
  - "iwc-map-over-lifecycle-survey"
  - "iwc-tabular-operations-survey"
  - "iwc-transformations-survey"
summary: "What IWC test suites cut corners on (accepted) vs what's a code smell — existence-only probes, sim_size deltas, image dim checks, label coupling."
---

# IWC test-suite shortcuts and anti-patterns

## Purpose

When an agent translates or authors a Galaxy workflow for IWC submission, the test suite it writes will be reviewed against IWC's *de facto* style — not against an idealized assertion ladder. That style routinely tolerates assertions that look weak in isolation. This note distinguishes the corner-cutting that is **normal and accepted** in the corpus from the patterns that an agent should treat as **smells** worth flagging.

This note owns accepted-vs-smell calls. For positive workflow-structure guidance behind label stability, checkpoint promotion, and collection identifier design, use galaxy-workflow-testability-design.

Grounding: 115 `*-tests.yml` files under `workflow-fixtures/iwc-src/workflows/` (mirror of `galaxyproject/iwc`), prior synthesis in `galaxy-brain/vault/projects/workflow_state/skills/COMPONENT_GALAXY_WORKFLOW_TESTING.md`. Path citations below are relative to `iwc-src/workflows/` unless absolute.

## TL;DR rules of thumb

1. **Default to tolerant assertions.** `compare: sim_size` + `delta:`, `has_image_*` + `delta:`, `has_text` substring, `has_h5_keys`, `has_n_lines` + `delta:` are *the IWC vocabulary*. Strict `compare: diff` or exact-`file:` is the exception, used only when the upstream tool is fully deterministic on fixed inputs.
2. **No negative tests.** `expect_failure:` does not appear in the corpus. Don't author one.
3. **No checksums.** `md5:` / `checksum:` do not appear on outputs in the corpus. SHA-1 hashes are used on **inputs** (integrity of remote fetch), never on output assertions.
4. **Preserve labels.** Inputs and outputs are referenced by label. Renaming silently breaks tests; treat label changes as breaking changes that require a sibling `-tests.yml` update.
5. **Big data goes to Zenodo.** In-repo `test-data/` is for toy fixtures and expected outputs only.

---

## 1. Existence-only content probes

### Accepted

The HyPhy test files reduce JSON output validation to "starts with `{`":

- `comparative_genomics/hyphy/hyphy-core-tests.yml:32-71` — four output collections (`meme_output`, `prime_output`, `busted_output`, `fel_output`), each gene element asserts `has_text: text: "{"` and nothing else.
- `comparative_genomics/hyphy/hyphy-compare-tests.yml`, `capheine-core-and-compare-tests.yml` — same pattern across the rest of the family.

This is **accepted** because:
- HyPhy's MEME/PRIME/BUSTED/FEL/CFEL/RELAX statistical outputs embed run-dependent floats throughout (likelihoods, AIC, posterior probabilities). Substring assertions on numeric fields would fail intermittently.
- Selecting any specific gene name or category in the JSON would couple the test to internal HyPhy keying that the wrapper has changed across versions.
- The assertion does verify "the tool ran, produced JSON, did not crash, and the collection structure matches expected element identifiers" — which is genuinely useful given HyPhy's history of opaque failures.

A quick scan finds **298 lines** matching the existence-style `has_text:` pattern across the corpus (`grep "has_text:\s*$\|text: \"{\"$"` yields 298 hits across many files). It is widespread, not a HyPhy quirk.

Other variants in the same accepted-shortcut family:

- **First-line-of-header probes**: `amplicon/amplicon-mgnify/.../mgnify-amplicon-pipeline-v5-rrna-prediction-tests.yml:46-49` asserts `has_text: "# mapseq v1.2.6 (Jan 20 2023)"` — version banner only.
- **`has_n_columns` schema probes**: same file lines 50-52, 67-69 — "the table has 15 columns" / "4 columns" with no row-content check.
- **`has_h5_keys` structure probes**: `scRNAseq/scanpy-clustering/.../Preprocessing-...-Scanpy-tests.yml:27-32, 159-166` — confirms AnnData has `obs/louvain`, `var/highly_variable`, `uns/rank_genes_groups`, etc., but says nothing about cluster labels or values. Also `imaging/tissue-microarray-analysis/multiplex-tissue-microarray-analysis/multiplex-tma-tests.yml` for Merged anndata.

### Smell

Existence probes on **deterministic** outputs. If the underlying tool is deterministic on fixed inputs (alignment, simple QC stats, well-defined transformations), reducing to `has_text: "{"` is laziness — agent should at least pull a known stable substring from the expected JSON.

Heuristic for an agent: **if the source workflow's tool is on the "stochastic / floating-point heavy / version-fragile" list (HyPhy, RepeatModeler, scanpy plots, MCMC samplers, ML inference), existence probes are accepted. Otherwise, prefer `has_text` against a stable token from a real output.**

---

## 2. Size-only comparisons (`compare: sim_size` + `delta:`)

### Accepted

Canonical example: `repeatmasking/RepeatMasking-Workflow-tests.yml:11-46` — every output is `compare: sim_size` with `delta: 30000` (30 KB) on small outputs and `delta: 90000000` (90 MB!) on the Stockholm seed-alignment file. RepeatModeler's discovered repeat families differ run-to-run; only output magnitude is reproducible.

`grep "compare: sim_size"` returns 9 files using this pattern:
- `repeatmasking/RepeatMasking-Workflow-tests.yml`, `repeatmasking/Repeat-masking-with-RepeatModeler-and-RepeatMasker-tests.yml` (RepeatModeler — large delta band)
- `epigenetics/hic-hicup-cooler/chic-fastq-to-cool-hicup-cooler-tests.yml`, `epigenetics/hic-hicup-cooler/hic-fastq-to-cool-hicup-cooler-tests.yml` (HiC matrices)
- `genome_annotation/functional-annotation/functional-annotation-of-sequences/Functional_annotation_of_sequences-tests.yml`
- `VGP-assembly-v2/kmer-profiling-hifi-trio-VGP2/kmer-profiling-hifi-trio-VGP2-tests.yml`
- `genome-assembly/polish-with-long-reads/Assembly-polishing-with-long-reads-tests.yml`
- `scRNAseq/baredsc/baredSC-1d-logNorm-tests.yml`, `scRNAseq/baredsc/baredSC-2d-logNorm-tests.yml` (Bayesian sampling — uses `delta_frac:` here)

### Delta-magnitude survey

From `grep "delta: [0-9]+"` distribution across the corpus:

| Delta band | Count | Typical use |
|---|---|---|
| 4–100 (tiny) | ~20 | image pixel dimensions, line counts |
| 1K–10K | ~40 | small text/tabular outputs, plot PNGs |
| 25K–100K | ~25 | mid-size reports, multi-page plots |
| 200K–1M | ~10 | report HTML, BAM stats |
| 1M–10M | ~10 | medium BAM/BCF/cool files |
| 10M+ (up to 90M) | ~7 | RepeatModeler libraries, large alignments |

The 90 MB delta on `RepeatMasking-Workflow-tests.yml:20` is at the extreme. It says "this output is somewhere between zero bytes and 180 MB" — effectively only catches the empty-output failure mode. Accepted because RepeatModeler's seed alignments are known to vary by tens of MB across runs.

### `delta_frac:`

Used in 3 files (`scRNAseq/baredsc/*`, `genome-assembly/polish-with-long-reads/*`). Preferred over absolute `delta:` when the expected output size scales with input. An agent translating a workflow whose output size depends on input volume should consider `delta_frac:` over `delta:`.

### Smell

`compare: sim_size` on outputs from a **deterministic** tool. If the tool is bwa/bowtie2/samtools-sort with fixed seeds and pinned versions, there's no excuse for size-only — `compare: diff` (with modest `lines_diff:`) or content assertions are appropriate.

Also a smell: stacking size + `has_image_*` checks on a PNG without any content assertion when the workflow's claim is *about the data shown* (e.g., a clustering plot). The corpus does this routinely (Scanpy file below) — accepted, but a translated workflow that has a more deterministic plotter should do better.

---

## 3. Image plot assertions

### Accepted

`scRNAseq/scanpy-clustering/.../Preprocessing-...-Scanpy-tests.yml:33-205` is the dense example. ~15 PNG outputs each get the same triple:

```yaml
UMAP of louvain:
  has_size:
    size: 68416
    delta: 6000
  has_image_width:
    width: 601
    delta: 30
  has_image_height:
    height: 429
    delta: 25
```

What this catches:
- Plot was rendered (non-zero size).
- Render dimensions are stable (matplotlib defaults didn't drift, theme didn't change).
- Approximate file size hasn't shifted by an order of magnitude (no catastrophic content change like all-white or all-noise).

What this **misses**: cluster assignments wrong, axes mislabeled, points in wrong positions, colors swapped, the wrong subset plotted, NaN handling regression. Two visually different UMAPs can have identical width/height/size-within-10%.

Other observed image-assertion users (`grep "has_image"`):
- `imaging/tissue-microarray-analysis/tissue-microarray-analysis/tissue-micro-array-analysis-tests.yml`
- `imaging/tissue-microarray-analysis/multiplex-tissue-microarray-analysis/multiplex-tma-tests.yml`

The TMA tests use a friendlier shorthand: `has_size: size: 181K, delta: 50K` (human-readable units).

### Smell

Asserting `has_image_width`/`has_image_height` with **zero delta** on a tool that re-encodes (PNG round-trips through matplotlib) is brittle. The corpus uses 5–10% deltas; an agent emitting `delta: 0` should be flagged unless the renderer is byte-stable.

Note `has_image_channels`, `has_image_center_of_mass` are documented (galaxy XSD) but **not observed** in the sampled corpus. An agent with a deterministic mask/segmentation output could use `has_image_center_of_mass` to actually verify spatial correctness — this would be an *upgrade* over the current corpus norm, not a smell.

---

## 4. Happy-path-only culture (`expect_failure:`)

`grep -r "expect_failure"` over all 115 tests files returns **zero hits**. The IWC corpus has no negative tests. Period.

This is a structural property of IWC: the workflows are published artifacts intended to *succeed* on canonical inputs. Adversarial / error-path testing happens in tool wrappers, not in workflow tests.

**Implication for an agent:** Do not author `expect_failure:` cases when translating a workflow. If the source pipeline (e.g., nf-core) had a "fail on bad reference" test, drop it — it doesn't belong in IWC. If the validation logic is important, it should be in a wrapper-level tool test, not a workflow test.

---

## 5. `md5:` / `checksum:` rarity

`grep -r "md5:\|checksum:"` over `*-tests.yml`: **zero hits**.

SHA-1 `hashes:` blocks are pervasive — but exclusively on **inputs** (`hash_function: SHA-1` paired with a remote `location:`), to guard against silent corruption of the fetched fixture. Output assertions never use them.

Accepted. The reason is empirical: outputs of real bioinformatics tools (BAM with PG headers and timestamps, VCFs with command-line provenance, JSON with run dates) are almost never byte-stable across runs. A `checksum:` would fail intermittently.

**Smell:** an agent emitting `checksum:` or `md5:` on a workflow output. Even for "fully deterministic" tools, embedded provenance breaks checksums. Use `compare: diff` + `lines_diff:` instead, or content assertions.

---

## 6. Output label coupling

Test files key outputs by **workflow label**, with spaces, capitals, punctuation preserved verbatim. Examples:

- `scanpy-clustering/.../Preprocessing-...-Scanpy-tests.yml:27` — `Anndata with Celltype Annotation:` (spaces, mixed case)
- `scanpy-clustering/.../Preprocessing-...-Scanpy-tests.yml:33` — `UMAP of louvain and top ranked genes:`
- `imaging/tissue-microarray-analysis/multiplex-tissue-microarray-analysis/multiplex-tma-tests.yml` — `Merged anndata:`, `Spatial Scatterplot Montage:`
- `consensus-from-variation-tests.yml:30` — `multisample_consensus_fasta:` (snake-case style)

**Both styles coexist.** Snake-case (older / SARS-CoV-2 family) and natural-language-with-spaces (newer / scanpy / TMA) are equally valid. Reviewers do not enforce a single convention.

### Coupling consequences

Renaming an output label in the `.ga` without updating the sibling `-tests.yml` is a silent breakage:
- Test references the old label → key not present in invocation outputs → assertion mismatch surfaces as an opaque "output not found" error in planemo.
- `planemo workflow_lint --iwc` enforces that workflow outputs are *labeled*, not that test labels match.

**Discipline observed:** every output a test asserts on is a labeled workflow output. The corpus does not assert on positional / unlabeled outputs.

**Smell:** a translated workflow with unlabeled outputs that later need test coverage. Agent should label every output it intends to assert on, before writing assertions.

Positive design guidance now lives in galaxy-workflow-testability-design: pick stable labels before test authoring and treat renames as test-breaking API changes.

---

## 7. Intermediate-step output gap

`-tests.yml` can only assert on workflow-level **outputs** (entries in the `.ga`'s top-level outputs). Intermediate step results are inaccessible to assertions.

Observed workaround across the corpus: **promote the intermediate to a workflow output**. This is visible indirectly — many workflows expose what would naturally be intermediates as labeled outputs solely for testability:

- `scanpy-clustering` exposes `Initial Anndata General Info`, `Anndata with raw attribute`, `Plot highly variable`, `Elbow plot of PCs and variance` — these are mid-pipeline checkpoints surfaced specifically to be assertable. Compare counts: 22 outputs asserted vs the 7-or-so "user-meaningful" final artifacts.
- `MAGs-generation-tests.yml` exposes a `Full MultiQC Report` even though MultiQC is logically intermediate to MAG annotation.

**Cost:** "test-only" outputs clutter the workflow's user-facing output list. Reviewers tolerate this in exchange for testability.

**Accepted shortcut:** promoting an intermediate to a workflow output for test purposes. Not a smell.

**Smell:** asserting on a step output via some side-channel (e.g., relying on Galaxy collection ordering, indexing into `tool_state`). The corpus does not do this and an agent should not invent it.

Positive design guidance now lives in galaxy-workflow-testability-design: promote assertable checkpoints deliberately, especially when final reports or plots can only support weak smoke tests.

---

## 8. Remote-data fragility

### Pattern

Overwhelming preference for **Zenodo** as the input store. Every remote `location:` is paired with a SHA-1 `hashes:` block. Examples already cited in nearly every snippet above.

Non-Zenodo remote sources observed (from `grep "ftp.sra.ebi\|ftp://\|figshare\|github.com"`):
- `virology/pox-virus-amplicon/pox-virus-half-genome-tests.yml:27,34,48,55` — `ftp://ftp.sra.ebi.ac.uk/...` SRA fastqs
- `amplicon/amplicon-mgnify/.../mgnify-amplicon-pipeline-v5-rrna-prediction-tests.yml:21` — `ftp://ftp.ebi.ac.uk/...` reference DB
- `data-fetching/parallel-accession-download/parallel-accession-download-tests.yml`, `VGP-assembly-v2/Plot-Nx-Size/...` — accession-driven
- `variant-calling/generic-variant-calling-wgs-pe/Generic-variation-analysis-on-WGS-PE-data-tests.yml` — github raw URLs

### The fragility

- **Zenodo is a single point of failure across CI.** A Zenodo outage breaks every IWC PR concurrently. SHA-1 hashes guard against silent corruption but provide no mitigation for outages or HTTP 503s.
- **EBI/SRA FTP is even less reliable** — observed flake-prone in the broader Galaxy CI history.
- No retry / backoff configured at the test-format level; planemo-ci-action's defaults handle transient failures only via re-running the chunk job manually.

### Accepted

This is just life in the IWC. Don't try to "fix" it in a translated workflow by inlining large data — reviewers will push back (see §10).

### Smell

Inputs hosted on a contributor's personal endpoint, S3 bucket, or Dropbox. Reviewers ask for migration to Zenodo before merge.

---

## 9. `compare: diff` on timestamped outputs

`compare: diff` usage from `grep`:

- `sars-cov-2-variant-calling/sars-cov-2-ont-artic-variant-calling/ont-artic-variation-tests.yml:32` — `compare: diff, lines_diff: 6` on annotated VCF
- `sars-cov-2-variant-calling/sars-cov-2-pe-illumina-wgs-variant-calling/pe-wgs-variation-tests.yml:35` — same
- `imaging/fluorescence-nuclei-segmentation-and-counting/segmentation-and-counting-tests.yml:16` — `lines_diff: 0`
- `variant-calling/variation-reporting/Generic-variation-analysis-reporting-tests.yml:21,25,29,33` — `lines_diff: 6`
- `variant-calling/generic-variant-calling-wgs-pe/Generic-variation-analysis-on-WGS-PE-data-tests.yml:39,45,55` — `lines_diff: 6`

The `lines_diff: 6` constant is suspicious — 6 lines is the typical VCF header preamble that embeds `##fileDate=...` and `##source=...`. The use is **defensible**: tolerance window matches the known mutable header lines, content lines are diffed strictly.

### Smell

- `compare: diff` with `lines_diff: 0` on a file that contains *any* timestamp, command-line capture, version banner, or random tie-break (hash-ordered dictionaries in Python output, etc.). The single observed `lines_diff: 0` case (`segmentation-and-counting-tests.yml:16`) appears to be on a numeric tabular output where it's defensible — verify content type before flagging.
- `compare: diff` on a BAM. BAM headers include `@PG` lines with full command lines and Galaxy job IDs. Use `has_size` + content extracts via `has_archive_member` or `samtools view`-piped XML asserts — not byte-level diff.

**Recommended replacement** when timestamps appear:
- For VCF: `compare: diff, lines_diff: <header-line-count>` (corpus convention is 6).
- For tabular reports: `has_text` against stable column headers + `has_n_columns`.
- For HTML reports (MultiQC etc.): `has_text` substring on stable section names — example `short-read-qc-trimming/short-read-quality-control-and-trimming-tests.yml:25-28` asserts `"Filtered Reads"` substring on the MultiQC HTML report rather than diffing.

---

## 10. Reviewer-feedback recurring asks

Synthesized from the COMPONENT_GALAXY_WORKFLOW_TESTING.md analysis (sections 9 and the "Common PR-review feedback" subsection) plus structural observation of what every accepted workflow has and rejected drafts apparently lack:

| Reviewer ask | Where it bites | Source |
|---|---|---|
| **Creator `identifier:` must be a full ORCID URI** (`https://orcid.org/...`), not bare ID. | `.ga` frontmatter `creator:` block. Most common lint failure. | planemo PR #1458; `consensus-from-variation.ga:4-10` shows the conformant shape. |
| **Move large inputs to Zenodo.** Inline `path: test-data/big.bam` for >1 MB inputs gets pushback. | `-tests.yml` job inputs. | `iwc/workflows/README.md` (per prior analysis). |
| **Bump `release` + add CHANGELOG.md entry in the same PR.** | `.ga` `release:` and sibling `CHANGELOG.md`. Enforced by `bump_version.py`. | `iwc/workflows/README.md:217-247`. |
| **Generate tests via `planemo workflow_test_init --from_invocation <id>`**, not by hand. Reviewers push back on hand-authored job blocks. | Any new test contribution. | help.galaxyproject.org thread 13903. |
| **Don't use `compare: diff` on outputs that embed timestamps.** Switch to `has_text`/`has_n_lines` with `delta:`. | See §9. | Recurring review comment. |
| **Add labeled outputs for any output you assert on.** Unlabeled outputs caught by `planemo workflow_lint --iwc`. | `.ga` outputs. | §6 above. |
| **Hashes on every remote `location:`.** SHA-1 block paired with the URL. Reviewers spot-check. | `-tests.yml` job inputs. | Universal in the corpus; missing hashes get flagged. |

### Smell to flag for an agent submission

- Bare ORCID ID (`0000-0002-...`) in `creator:` instead of full URL.
- Test job referencing >1 MB local fixture instead of a Zenodo URL.
- PR that bumps a workflow without CHANGELOG / `release:` bump.
- Hand-authored `-tests.yml` that reads "too clean" — reviewers know `--from_invocation` output has a recognizable fingerprint.

---

## Summary cheatsheet for the implement-galaxy-workflow-test mold

**Use these freely (accepted shortcuts):**
- `has_text: text: "{"` for stochastic JSON outputs.
- `compare: sim_size, delta:` for non-deterministic file outputs; pick delta from §2 distribution by tool family.
- `has_image_width/height/has_size` triple with 5–10% delta for matplotlib plots.
- `has_h5_keys` for AnnData/HDF5 — assert structure not values.
- Promoting intermediates to workflow outputs to make them assertable.
- Labels with spaces, mixed case, punctuation as the output key.
- SHA-1 hashes on every input `location:`.

**Avoid (smells reviewers or future-you will catch):**
- `expect_failure:` — not an IWC pattern.
- `md5:` / `checksum:` on outputs.
- `compare: diff, lines_diff: 0` on anything containing timestamps, BAM `@PG` lines, or Python dict ordering.
- `has_image_*` with zero delta.
- Existence-only `has_text: "{"` on outputs from a deterministic tool.
- Asserting on positional/unlabeled outputs.
- Inlining >1 MB binary fixtures in `test-data/`.
- Bare ORCID identifier in `.ga` frontmatter.

**Review-time checklist before submission:**
1. Every output asserted on has a label in the `.ga`.
2. Every remote `location:` has a `hashes: SHA-1` block.
3. Inputs >1 MB live on Zenodo, not in `test-data/`.
4. `release:` bumped and `CHANGELOG.md` updated if `.ga` changed.
5. `creator.identifier:` is a full `https://orcid.org/...` URL.
6. Test was generated by `planemo workflow_test_init --from_invocation`, not hand-written.

---

## Sources

- Positive workflow-structure guidance: galaxy-workflow-testability-design.
- Prior synthesis: `https://github.com/jmchilton/galaxy-brain/blob/main/vault/projects/workflow_state/skills/COMPONENT_GALAXY_WORKFLOW_TESTING.md` (sections 2c, 2d, 2e, 9).
- Corpus root: `https://github.com/galaxyproject/iwc/blob/main/workflows/` (115 `*-tests.yml` files across 22 categories).
- Specific files cited:
  - `comparative_genomics/hyphy/hyphy-core-tests.yml`, `hyphy-compare-tests.yml`, `capheine-core-and-compare-tests.yml`
  - `repeatmasking/RepeatMasking-Workflow-tests.yml`, `Repeat-masking-with-RepeatModeler-and-RepeatMasker-tests.yml`
  - `scRNAseq/scanpy-clustering/Preprocessing-and-Clustering-of-single-cell-RNA-seq-data-with-Scanpy-tests.yml`
  - `read-preprocessing/short-read-qc-trimming/short-read-quality-control-and-trimming-tests.yml`
  - `virology/pox-virus-amplicon/pox-virus-half-genome-tests.yml`
  - `metabolomics/lcms-preprocessing/Mass_spectrometry__LC-MS_preprocessing_with_XCMS-tests.yml`
  - `sars-cov-2-variant-calling/sars-cov-2-consensus-from-variation/consensus-from-variation-tests.yml`
  - `sars-cov-2-variant-calling/sars-cov-2-pe-illumina-wgs-variant-calling/pe-wgs-variation-tests.yml`
  - `sars-cov-2-variant-calling/sars-cov-2-ont-artic-variant-calling/ont-artic-variation-tests.yml`
  - `variant-calling/variation-reporting/Generic-variation-analysis-reporting-tests.yml`
  - `variant-calling/generic-variant-calling-wgs-pe/Generic-variation-analysis-on-WGS-PE-data-tests.yml`
  - `imaging/fluorescence-nuclei-segmentation-and-counting/segmentation-and-counting-tests.yml`
  - `imaging/tissue-microarray-analysis/multiplex-tissue-microarray-analysis/multiplex-tma-tests.yml`
  - `amplicon/amplicon-mgnify/mgnify-amplicon-pipeline-v5-rrna-prediction/mgnify-amplicon-pipeline-v5-rrna-prediction-tests.yml`
  - `epigenetics/atacseq/atacseq-tests.yml`
  - `epigenetics/hic-hicup-cooler/chic-fastq-to-cool-hicup-cooler-tests.yml`, `hic-fastq-to-cool-hicup-cooler-tests.yml`
  - `microbiome/mags-building/MAGs-generation-tests.yml`
  - `genome-assembly/polish-with-long-reads/Assembly-polishing-with-long-reads-tests.yml`
  - `scRNAseq/baredsc/baredSC-1d-logNorm-tests.yml`, `baredSC-2d-logNorm-tests.yml`
- Corpus-wide grep tallies:
  - `expect_failure`: 0 hits.
  - `md5:|checksum:` on outputs: 0 hits.
  - `compare: sim_size`: 9 files.
  - `compare: diff`: 5 files (variant-calling and imaging).
  - `has_image_*`: 3 files.
  - Existence-style `has_text:` patterns: ~298 line matches.
  - `delta_frac:`: 3 files.
