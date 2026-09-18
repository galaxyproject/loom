---
type: research
tags:
  - target/galaxy
status: draft
created: 2026-05-03
revised: 2026-05-06
revision: 2
related_notes:
  - "iwc-workflow-testability-survey"
  - "iwc-test-data-conventions"
  - "planemo-asserts-idioms"
  - "iwc-shortcuts-anti-patterns"
  - "planemo-workflow-test-architecture"
  - "implement-galaxy-workflow-test"
  - "gxformat2-schema"
  - "gxformat2-workflow-inputs"
  - "galaxy-datatypes-conf"
summary: "Design guidance for Galaxy workflow inputs, outputs, and checkpoints that make IWC-style workflow tests possible."
---

# Galaxy workflow testability design

Use this note when authoring or translating a Galaxy workflow **before** the `-tests.yml` file exists. It covers workflow structure choices that make later IWC-style tests meaningful: labels, promoted checkpoints, collection identifiers, and fixture-compatible inputs.

This is not a `content/patterns/` page. It is cross-cutting design guidance for Molds that need testable Galaxy workflows. Assertion syntax lives in planemo-asserts-idioms. Test YAML fixture shapes live in iwc-test-data-conventions. Accepted shortcut vs smell calls live in iwc-shortcuts-anti-patterns. Corpus evidence trail lives in iwc-workflow-testability-survey.

## 1. Treat labels as API

Workflow input and output labels are not cosmetic. Planemo and IWC tests address workflow inputs and outputs by label, and the survey found exact label matches for every asserted output across 114 matched workflow/test pairs. A generated workflow should therefore pick stable, descriptive labels before test authoring starts.

Rules:

- Label every output that may need a test assertion.
- Treat input/output renames as breaking changes requiring sibling `-tests.yml` updates.
- Prefer stable domain names over tool-step defaults or positional names.
- Do not rely on unlabeled or positional outputs for tests.

Evidence:

- Scanpy exposes outputs such as `Initial Anndata General Info`, `UMAP of louvain`, `Ranked genes with Wilcoxon test`, and `Dotplot of top genes on clusters` (`$IWC_FORMAT2/scRNAseq/scanpy-clustering/Preprocessing-and-Clustering-of-single-cell-RNA-seq-data-with-Scanpy.gxwf.yml:105-147`). The sibling test keys assertions by those exact labels (`$IWC/workflows/scRNAseq/scanpy-clustering/Preprocessing-and-Clustering-of-single-cell-RNA-seq-data-with-Scanpy-tests.yml:27-205`).
- VGP scaffolding uses punctuation-heavy labels such as `Hi-C duplication stats on scaffolds: Raw`, `Hi-C duplication stats on scaffolds: MultiQc`, and `Merged Alignment stats` (`$IWC_FORMAT2/VGP-assembly-v2/Scaffolding-HiC-VGP8/Scaffolding-HiC-VGP8.gxwf.yml:170-196`). The test asserts those exact labels (`$IWC/workflows/VGP-assembly-v2/Scaffolding-HiC-VGP8/Scaffolding-HiC-VGP8-tests.yml:218-245`).

## 2. Promote assertable checkpoints

IWC workflow tests assert workflow-level outputs. Intermediate step results are invisible unless promoted to top-level workflow outputs. When final reports are weakly assertable, expose intermediate checkpoints that carry deterministic content or structure.

Rules:

- Promote intermediate outputs when they are the best deterministic or structural checkpoint.
- Prefer a checkpoint table/text/HDF5 object that can prove content over a final plot/report that can only prove existence.
- Accept some output-list clutter when it buys meaningful tests.
- Do not promote every intermediate by default; expose checkpoints that map to concrete assertion intent.

Evidence:

- Scanpy exposes 21 workflow outputs and the sibling test asserts all 21. These include initial AnnData summaries, intermediate plots, ranked-gene tables, final AnnData, cluster-count tables, and final plots (`$IWC_FORMAT2/scRNAseq/scanpy-clustering/Preprocessing-and-Clustering-of-single-cell-RNA-seq-data-with-Scanpy.gxwf.yml:105-147`; `$IWC/workflows/scRNAseq/scanpy-clustering/Preprocessing-and-Clustering-of-single-cell-RNA-seq-data-with-Scanpy-tests.yml:27-205`).
- RNA-seq paired-end exposes mapped reads, stranded/unstranded coverage, abundance estimates, expression tables, counts tables, and MultiQC reports (`$IWC_FORMAT2/transcriptomics/rnaseq-pe/rnaseq-pe.gxwf.yml:90-112`). The sibling test asserts sizes for coverage/read outputs and stronger regex/line checks for expression/count outputs (`$IWC/workflows/transcriptomics/rnaseq-pe/rnaseq-pe-tests.yml:48-97`).
- MGnify complete exposes 83 workflow outputs; 38 are asserted in the sibling test, including MultiQC reports, FASTA collections, taxonomic classifications, OTU tables, and HDF5/JSON outputs (`$IWC_FORMAT2/amplicon/amplicon-mgnify/mgnify-amplicon-pipeline-v5-complete/mgnify-amplicon-pipeline-v5-complete.gxwf.yml:163-329`; `$IWC/workflows/amplicon/amplicon-mgnify/mgnify-amplicon-pipeline-v5-complete/mgnify-amplicon-pipeline-v5-complete-tests.yml:15-120`).

## 3. Stabilize collection output identifiers

Collection tests key assertions by element identifier. If a workflow emits collections with unstable or opaque identifiers, the test cannot target elements cleanly.

Rules:

- Preserve biologically or sample-meaningful identifiers through map-over and collection reshaping.
- When generating or relabeling collections, make the identifier derivation deterministic and visible in workflow structure.
- For nested collections, ensure each axis has predictable identifiers.
- Quote special identifiers in tests when YAML requires it, but do not simplify identifiers merely for YAML convenience.

Evidence:

- 59 of 115 IWC test files use `element_tests:`, with 227 `element_tests:` blocks in the corpus survey.
- 10x CellPlex tests nested collection outputs by `subsample`, then inner `matrix`, `barcodes`, and `genes` elements (`$IWC/workflows/scRNAseq/fastq-to-matrix-10x/scrna-seq-fastq-to-matrix-10x-cellplex-tests.yml:82-128`). The workflow exposes the corresponding collection outputs (`$IWC_FORMAT2/scRNAseq/fastq-to-matrix-10x/scrna-seq-fastq-to-matrix-10x-cellplex.gxwf.yml:73-91`).
- HyPhy collection outputs are tested by generated gene identifiers such as `NC_001477.1|capsid_protein_C|95-394_DENV1` (`$IWC/workflows/comparative_genomics/hyphy/hyphy-core-tests.yml:31-71`). The workflow exposes collection outputs for MEME, PRIME, BUSTED, and FEL (`$IWC_FORMAT2/comparative_genomics/hyphy/hyphy-core.gxwf.yml:26-38`).

## 4. Choose checkpoints by assertion strength

Assertion choice is not only a test-file decision. It should feed back into workflow output design. If the only exposed output is a stochastic plot or binary file, the best possible test may be a weak size check. Exposing a sibling table, report, HDF5 structure, or summary line can make the same workflow much more testable.

Rules:

- For image-heavy workflows, expose data or summary outputs behind the plot when possible.
- For stochastic statistical outputs, expose structural checkpoints and stable summary tokens.
- For binary outputs, expose a text/table report or stats file when the tool can produce one.
- Use planemo-asserts-idioms to select the assertion family after choosing the checkpoint.

Evidence:

- Scanpy image outputs are mostly smoke-tested with `has_size`, `has_image_width`, and `has_image_height`, but the same workflow also exposes AnnData HDF5 keys and cluster-count table checks (`$IWC/workflows/scRNAseq/scanpy-clustering/Preprocessing-and-Clustering-of-single-cell-RNA-seq-data-with-Scanpy-tests.yml:33-205`).
- RNA-seq paired-end pairs coarse size checks for coverage/mapped-read outputs with stronger regex and exact-line checks for expression/count tables (`$IWC/workflows/transcriptomics/rnaseq-pe/rnaseq-pe-tests.yml:48-97`).
- VGP scaffolding tests combine stable text checks for scaffold/report stats with size checks for map/alignment artifacts (`$IWC/workflows/VGP-assembly-v2/Scaffolding-HiC-VGP8/Scaffolding-HiC-VGP8-tests.yml:173-245`).

## 5. Design inputs with fixtures in mind

Workflow input labels and types constrain the eventual `job:` block. Fixture planning is not only a test-file activity: it should influence whether the workflow exposes a file input, a collection input, a string data-table input, or a typed parameter.

Rules:

- Choose input labels that will be readable as test `job:` keys.
- Match workflow input collection types to realistic fixture shapes.
- Decide early whether reference data should be a portable remote file or a CVMFS/data-table string.
- Keep typed parameters explicit when tests need to set them (`int`, `boolean`, `string`) rather than burying them in step defaults.

Evidence:

- 10x CellPlex job inputs include `fastq PE collection GEX`, `reference genome`, `gtf`, `cellranger_barcodes_3M-february-2018.txt`, `fastq PE collection CMO`, `sample name and CMO sequence collection`, and `Number of expected cells` (`$IWC/workflows/scRNAseq/fastq-to-matrix-10x/scrna-seq-fastq-to-matrix-10x-cellplex-tests.yml:2-75`). The workflow declares matching collection, data, string, boolean, and int inputs (`$IWC_FORMAT2/scRNAseq/fastq-to-matrix-10x/scrna-seq-fastq-to-matrix-10x-cellplex.gxwf.yml:4-72`).
- HyPhy accepts a `list` collection of unaligned sequences and preserves accession-like fixture identifiers through to output element assertions (`$IWC/workflows/comparative_genomics/hyphy/hyphy-core-tests.yml:7-30`; `$IWC_FORMAT2/comparative_genomics/hyphy/hyphy-core.gxwf.yml:14-25`).

## 6. Know what a gxformat2 output entry contains

Top-level gxformat2 `outputs:` is the public workflow-output surface. It is separate from per-step `out:` declarations and from step post-job actions such as `change_datatype` or `rename`.

Authoring rules:

- Use `label` as the stable public name tests and users will address.
- Use `outputSource` to point at the producing step output; do not rely on positional output order.
- Use `doc` for short user-facing context when the label is not self-explanatory.
- Keep `type` aligned with the exposed value (`data`, `collection`, or scalar vocabulary from gxformat2-workflow-inputs) when the schema needs it.
- Apply `change_datatype` at the producing step output when Galaxy needs a stronger datatype than the tool reports; choose values from galaxy-datatypes-conf.
- Use `rename` only for generated dataset names inside Galaxy histories. It is not a substitute for stable workflow-output `label`.
- Treat `add_tags` and `remove_tags` as metadata helpers, not as the test API. IWC tests key by labels and collection element identifiers, not tags.
- Avoid `hide` or `delete_intermediate_datasets` on outputs that are promoted as test checkpoints.

Design inference: a workflow-output promotion decision should pick both the public `outputs:` entry and any producer-side post-job action needed to make that output useful. For example, a synthesized BED checkpoint needs a stable output `label` plus a producer-side `change_datatype: bed`; one without the other is incomplete for a testable workflow.

## Cross-references

- iwc-workflow-testability-survey — corpus survey and distribution rationale.
- iwc-test-data-conventions — job/input YAML shapes, remote fixtures, hashes, collection fixture syntax.
- planemo-asserts-idioms — assertion-family choice after an output is exposed.
- iwc-shortcuts-anti-patterns — accepted shortcut vs smell calls for weak assertions and label coupling.
- planemo-workflow-test-architecture — Planemo execution, output-problem ambiguity, and structured artifacts.
- gxformat2-schema — structural vocabulary for top-level workflow outputs and step post-job actions.
- galaxy-datatypes-conf — valid Galaxy datatype extensions for `format` and `change_datatype` choices.
