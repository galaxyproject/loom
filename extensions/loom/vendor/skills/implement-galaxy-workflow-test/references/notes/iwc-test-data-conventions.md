---
type: research
tags:
  - target/galaxy
status: draft
created: 2026-04-30
revised: 2026-05-03
revision: 3
related_notes:
  - "galaxy-workflow-testability-design"
  - "iwc-shortcuts-anti-patterns"
  - "planemo-asserts-idioms"
  - "implement-galaxy-workflow-test"
  - "tests-format"
  - "iwc-tabular-operations-survey"
summary: "How IWC workflows organize and reference test data — Zenodo-first, SHA-1 integrity, collection shapes, CVMFS gotchas."
---

# IWC test data conventions

Reference for an agent implementing or editing a `<workflow>-tests.yml` in IWC style. All evidence cited from `https://github.com/galaxyproject/iwc/blob/main/workflows/` (raw IWC clone) and `workflows/README.md`. Authoritative spec: [planemo.readthedocs.io/en/latest/test_format.html](https://planemo.readthedocs.io/en/latest/test_format.html). The companion analysis at `https://github.com/jmchilton/galaxy-brain/blob/main/vault/projects/workflow_state/skills/COMPONENT_GALAXY_WORKFLOW_TESTING.md` is the synthesized source for several normative claims here.

This note owns **test YAML fixture shapes**. For workflow-structure choices that make those fixtures possible before the test file exists, use galaxy-workflow-testability-design.

## 1. Where does test data live? Remote vs in-repo

Two storage patterns. They mix freely inside one job.

**Remote `location:` (default for any non-trivial input).** Strongly preferred for anything bigger than a toy fixture. Order of preference, observed in the corpus:

- **Zenodo** — overwhelming default, persistent DOI-backed URL.
  - `read-preprocessing/short-read-qc-trimming/short-read-quality-control-and-trimming-tests.yml:13,17` — `https://zenodo.org/records/11484215/files/paired_r1.fastq.gz` (note the modern `/records/` plural form; older entries use `/record/`).
  - `metabolomics/lcms-preprocessing/Mass_spectrometry__LC-MS_preprocessing_with_XCMS-tests.yml:6,17,24,...` — 11+ mzML files all hosted at `zenodo.org/record/10130758/files/...`.
  - `sars-cov-2-variant-calling/sars-cov-2-consensus-from-variation/consensus-from-variation-tests.yml:5` — `https://zenodo.org/record/4555735/files/NC_045512.2_reference.fasta?download=1`.
  - `repeatmasking/RepeatMasking-Workflow-tests.yml:5` — `https://zenodo.org/record/8364146/files/eco.fasta?download=1`. The `?download=1` query suffix is acceptable but optional; both forms appear.
- **EBI/ENA REST** — for canonical reference sequences.
  - `virology/pox-virus-amplicon/pox-virus-half-genome-tests.yml:5` — `https://www.ebi.ac.uk/ena/browser/api/fasta/AF325528.1?download=true`.
- **SRA / ENA FTP** — for raw read accessions where re-uploading to Zenodo is wasteful.
  - `pox-virus-half-genome-tests.yml:27,34,49,56` — `ftp://ftp.sra.ebi.ac.uk/vol1/fastq/SRR151/076/SRR15145276/SRR15145276_1.fastq.gz`.

**In-repo `path: test-data/...` (toy fixtures + small expected outputs only).** Used when:

- File is small enough to commit (rule of thumb from corpus: low single-digit MB or smaller).
- File is a hand-crafted toy or trimmed reference (e.g. a 5-element FASTA for HyPhy).
- File is the *expected output* baseline for a `file:` exact-comparison assertion: `consensus-from-variation-tests.yml:31` — `file: test-data/masked_consensus.fa`.

`workflows/README.md:67` makes the contract explicit: "try to generate a toy dataset … and then publish it to zenodo to have a permanent URL." `workflows/README.md:98`: "if some outputs are large, it is better to use assertions than storing the whole output file to the iwc repository."

Subdirectory layout inside `test-data/` is free-form and used to organize related fixtures, e.g. `comparative_genomics/hyphy/test-data/unaligned_seqs/`, `test-data/codon_alignments/`, `test-data/iqtree_trees/` (referenced from `hyphy-core-tests.yml:13,17,21,...`).

**Decision rule for an agent:**

1. Expected-output baseline that's small — commit to `test-data/`.
2. Toy/trimmed input < ~5 MB — commit to `test-data/`.
3. Anything else — Zenodo (or EBI/SRA for canonical accessions). Add `hashes:` SHA-1.
4. If the input is a reference index resolvable from CVMFS (`hg38`, `dm6`, `mm10`, …), use the plain string form. See section 5.

## 2. The `class: File` block — exact YAML shapes

All snippets verbatim from the IWC corpus.

### 2a. Single remote file (with integrity hash)

`virology/pox-virus-amplicon/pox-virus-half-genome-tests.yml:3-9`:

```yaml
Reference FASTA:
  class: File
  location: "https://www.ebi.ac.uk/ena/browser/api/fasta/AF325528.1?download=true"
  filetype: fasta
  hashes:
  - hash_function: SHA-1
    hash_value: 927d0d00b7db6ad60524bb9e50d3ab41c4ac5ecf
```

Field order is conventional but not enforced. `filetype:` is the Galaxy datatype name (`fasta`, `fastqsanger.gz`, `mzml`, `bed`, `tabular`, `csv`, `gtf`, `vcf`, …). `location:` URLs may be quoted or bare; both forms occur.

### 2b. Single local file

`comparative_genomics/hyphy/hyphy-core-tests.yml:3-6`:

```yaml
reference cds:
  class: File
  path: test-data/denv1_ref_cds.fasta
  filetype: fasta
```

`path:` is relative to the workflow directory (the directory containing the `-tests.yml`). Hashes are usually omitted on local files — the file is in-tree, so integrity is implicit. They are nonetheless added in some workflows: `consensus-from-variation-tests.yml:15-18` shows `path: test-data/aligned_reads_for_coverage.bam` paired with a SHA-1 hash. The pattern appears to be: hashes added when the `-tests.yml` was generated by `planemo workflow_test_init --from_invocation`, which mints them automatically.

A dataset attribute can be set on a single file to force a `dbkey`, e.g. `epigenetics/consensus-peaks/consensus-peaks-chip-pe-tests.yml:7-10`:

```yaml
- class: File
  identifier: rep1
  path: test-data/rep1.bam
  dbkey: mm10
```

`dbkey:` and `decompress: true` (`scrna-seq-fastq-to-matrix-10x-cellplex-tests.yml:30`) are documented per-file attributes that ride alongside `class: File`.

### 2c. List collection

`hyphy-core-tests.yml:7-30`:

```yaml
unaligned sequences:
  class: Collection
  collection_type: list
  elements:
  - identifier: AB178040.1|2002
    class: File
    path: test-data/unaligned_seqs/AB178040.1|2002.fasta
    filetype: fasta
  - identifier: AB195673.1|2003
    class: File
    path: test-data/unaligned_seqs/AB195673.1|2003.fasta
    filetype: fasta
  ...
```

Each element is a single-file dict with an `identifier:`. A larger remote-only example with hashes per element: `metabolomics/lcms-preprocessing/Mass_spectrometry__LC-MS_preprocessing_with_XCMS-tests.yml:11-22`:

```yaml
Mass-spectrometry Dataset Collection:
  class: Collection
  collection_type: list
  elements:
  - class: File
    identifier: Blanc05.mzML
    location: https://zenodo.org/record/10130758/files/Blanc05.mzML
    filetype: mzml
    hashes:
    - hash_function: SHA-1
      hash_value: e98d5a4cd8849a145a032bdc31c348ad97cb59c3
```

### 2d. Paired collection (single pair)

A `paired` collection is a Collection whose two elements have identifiers `forward` and `reverse`. In IWC it is rarely used at top level — it is almost always wrapped as a single-element `list:paired` (see 2e). When it appears bare, the shape is the inner block of 2e without the outer `list:paired` wrapper.

### 2e. `list:paired` collection

`read-preprocessing/short-read-qc-trimming/short-read-quality-control-and-trimming-tests.yml:3-18`:

```yaml
Raw reads:
  class: Collection
  collection_type: list:paired
  elements:
  - class: Collection
    type: paired
    identifier: pair
    elements:
    - class: File
      identifier: forward
      location: https://zenodo.org/records/11484215/files/paired_r1.fastq.gz
      filetype: fastqsanger.gz
    - class: File
      identifier: reverse
      location: https://zenodo.org/records/11484215/files/paired_r2.fastq.gz
      filetype: fastqsanger.gz
```

Note: outer `collection_type: list:paired`, inner `type: paired` (not `collection_type:`). Inner element identifiers are the literal strings `forward` and `reverse` — these are reserved.

A multi-pair list:paired with full hashes: `virology/pox-virus-amplicon/pox-virus-half-genome-tests.yml:17-38` or `scRNAseq/fastq-to-matrix-10x/scrna-seq-fastq-to-matrix-10x-cellplex-tests.yml:3-24`.

### 2f. `list:list:paired` and deeper

Not directly observed in sampled IWC inputs. The shape is recursive — wrap a `list:paired` element list inside another `class: Collection, collection_type: list:list:paired`, where each outer element is `class: Collection, type: list:paired` (analogous to the `list:paired` → `paired` nesting in 2e). For deeply-nested collections planemo's [`_writing_collections.rst`](https://github.com/galaxyproject/planemo/blob/master/docs/_writing_collections.rst) is the de-facto reference.

Output side: nested-collection assertions DO exist in the corpus. `scrna-seq-fastq-to-matrix-10x-cellplex-tests.yml:82-98`:

```yaml
Seurat input for gene expression (filtered):
  attributes: {collection_type: list:list}
  element_tests:
    subsample:
      elements:
        matrix:
          asserts:
            has_line:
              line: "23932 3 1171"
        barcodes:
          asserts:
            has_line:
              line: "CACATGATCATAAGGA"
```

Pattern: outer `element_tests:` keyed by outer identifier; inner `elements:` (note plural, not `element_tests:` here) keyed by inner identifier. Optional `attributes: {collection_type: ...}` asserts the shape of the produced collection.

### 2g. `composite_data:`

**Not observed** in the sampled IWC corpus (`grep -rln "composite\|imzml\|primary_file\|extra_files" workflows/ --include="*-tests.yml"` returns nothing). Per the planemo spec the shape is a `composite_data:` mapping listing each component file path, but an agent emitting one in IWC style has no in-corpus reference and should treat it as unproven territory — fall back to the planemo docs and verify against `galaxy.tool_util.parser.yaml`.

### 2h. CWL-style shorthand (list of File dicts without identifiers)

Documented in planemo; not observed in sampled IWC. IWC always supplies explicit identifiers.

### 2i. `tags:` on elements (Galaxy 20.09+)

Documented in planemo; not surfaced in sampled IWC `-tests.yml` files (`grep "  tags:" --include="*-tests.yml"` empty across the sampled set). Practical absence — IWC tests rely on identifier matching, not tags.

## 3. SHA-1 integrity hashes — when, when not, why

**Format.** Always a list under `hashes:`, even for one entry. Each entry is `{hash_function: SHA-1, hash_value: <40-hex>}`. Verbatim from `pox-virus-half-genome-tests.yml:7-9`:

```yaml
hashes:
- hash_function: SHA-1
  hash_value: 927d0d00b7db6ad60524bb9e50d3ab41c4ac5ecf
```

Only `SHA-1` observed in the IWC corpus. The planemo spec also accepts `MD5`, `SHA-256`, `SHA-512` as `hash_function:` values; IWC does not exercise these.

**When present:**

- Every remote `location:`-fetched input in the sampled corpus carries a SHA-1 (Zenodo, EBI REST, SRA FTP). The hash guards against silent upstream corruption — Zenodo records are immutable but bit-rot and CDN-edge errors do happen; ENA FASTA endpoints can quietly change line-wrap.
- Many local `path:`-loaded inputs also carry a SHA-1. This is `--from_invocation` autogeneration leaking through (planemo emits hashes for every input it captured).
- `consensus-from-variation-tests.yml:6-8,17-18,27-28` — every input in the test, local and remote, has a hash.

**When omitted:**

- Hand-written local-file fixtures often skip hashes — `hyphy-core-tests.yml:3-30` has zero `hashes:` blocks across six local-file inputs.
- Output assertions: `file:`-comparison outputs and `location:`-comparison outputs (`RepeatMasking-Workflow-tests.yml:13`) **do not** carry `hashes:`. The integrity story for outputs is handled by `compare:` / `asserts:` instead.

**Why bother on local files.** Catches accidental corruption when collaborators hand-edit `test-data/` fixtures.

## 4. Element identifier conventions

Identifiers are arbitrary strings, used both as the YAML key (`element_tests:`) and as the produced Galaxy collection element name. Conventions surfaced from the corpus:

- **Pipes are legal** and survive YAML round-trip without quoting on the input side: `hyphy-core-tests.yml:11` — `identifier: AB178040.1|2002`. On the *output* side they're quoted because they appear as YAML mapping keys: `hyphy-core-tests.yml:34` — `"NC_001477.1|capsid_protein_C|95-394_DENV1":`. Quote when the identifier contains characters that would otherwise start a YAML flow node (`{`, `[`, `&`, `*`, `!`, `|`, `>`, `'`, `"`, `%`, `@`, `` ` ``) or look like a number/bool.
- **Dots, hyphens, underscores** — common, no quoting needed: `Blanc05.mzML`, `HU_neg_048.mzML`, `SRR11578257`, `Rep1`, `subsample`, `pair`.
- **Reserved inside `paired` collections:** `forward` and `reverse` (lowercase). Never use these names for outer identifiers in `list:paired`.
- **Inline comments after identifier** are legal and used for provenance: `pox-virus-half-genome-tests.yml:23` — `identifier: 20L70   # SRR15145276`.
- **Whitespace and special chars in workflow input *labels*** survive too — they are job-mapping keys, not collection identifiers, but the same YAML quoting rules apply. Example from the analysis doc: `Manually annotate celltypes?: true` as a job key in `Preprocessing-and-Clustering-of-single-cell-RNA-seq-data-with-Scanpy-tests.yml:23`.

### 4a. Workflow-interface implications

Fixture shape should feed back into workflow input design. Tests supply job inputs by workflow input label, and collection fixtures must match the workflow's declared collection type.

- The 10x CellPlex test uses `fastq PE collection GEX`, `fastq PE collection CMO`, and `sample name and CMO sequence collection` as job keys with `list:paired` and `list` collection fixtures; the workflow declares matching collection inputs at `$IWC_FORMAT2/scRNAseq/fastq-to-matrix-10x/scrna-seq-fastq-to-matrix-10x-cellplex.gxwf.yml:4-72`.
- CVMFS/data-table shortcuts like `reference genome: dm6` are workflow-interface choices as much as test YAML choices: they require the workflow input to be a string/data-table-backed parameter, not a file input.
- If a fixture needs stable sample names, decide whether those names should enter through collection element identifiers, a mapping file, or a workflow parameter before writing assertions.

Rule for an agent: when a new workflow input is being designed and the test fixture is already known, check galaxy-workflow-testability-design before locking the input label/type.

## 5. CVMFS / `.loc` / built-in-index references

When a workflow input is a Galaxy data-table-backed reference (built-in genome index, dbsnp file, kraken DB, …), the input takes a **plain string** matching the `value` column of a `.loc` file. No `class: File`, no `location:`. Examples:

- `scrna-seq-fastq-to-matrix-10x-cellplex-tests.yml:25` — `reference genome: dm6 # To test on usegalaxy.eu dm6full`
- `epigenetics/cutandrun/cutandrun-tests.yml:27` — `reference_genome: 'hg38canon'`
- `epigenetics/atacseq/atacseq-tests.yml:25` — `reference_genome: hg19`
- `microbiome/host-contamination-removal/host-contamination-removal-short-reads/host-or-contamination-removal-on-short-reads-tests.yml:19` — `Host/Contaminant Reference Genome: hg38`
- `microbiome/pathogen-identification/nanopore-pre-processing/Nanopore-Pre-Processing-tests.yml:22` — `host_reference_genome: apiMel3`
- `transcriptomics/goseq/goseq-go-kegg-enrichment-analsis-tests.yml:24` — `Select genome to use: mm10`

The string is the first column of the `.loc` entry. `workflows/README.md:169-182` shows the lookup procedure: browse `http://datacache.galaxyproject.org/indexes/location/<table>.loc`, find the `.loc` row, take the value column (which column varies by tool — check the matching `tool_data_table_conf.xml.sample`).

**Portability implication:** these tests **only** run on a Galaxy with CVMFS mounted at `/cvmfs/data.galaxyproject.org`. IWC CI mounts CVMFS in-runner (`setup-cvmfs: true` in `.github/workflows/test_workflows.yml`). On a plain developer laptop running `planemo test`, CVMFS-string inputs fail unresolved. An agent generating tests should either:

1. Stay URL-driven: replace the CVMFS string with a `class: File` + `location:` to a Zenodo-hosted reference (portable, slower CI, larger inputs).
2. Use the CVMFS string and document "CI-only" — the user cannot reproduce locally without a CVMFS mount.

There is no `.loc`-resolution shorthand in the YAML — it is just a bare string parameter. Agents must not invent `class: DataTable` or similar.

## 6. Reviewer-feedback patterns (PR-review)

Recurring asks from IWC reviewers, distilled from the contribution README and community help threads:

- **Move large data to Zenodo before merge.** Anything bigger than a toy fixture committed in `test-data/` will be flagged. `workflows/README.md:67`.
- **Use assertions, not exact-file comparison, for large outputs.** `workflows/README.md:98` — "if some outputs are large, it is better to use assertions than storing the whole output file."
- **Generate tests with `planemo workflow_test_init --from_invocation`, don't hand-write.** `workflows/README.md:88-94`. The autogenerated test will mint correct hashes, correct labels, and a working `test-data/` snapshot.
- **Set creator `identifier:` to a full ORCID URL** (e.g. `https://orcid.org/0000-0002-1825-0097`) — `workflows/README.md:53`. The most common lint failure; enforced in [planemo#1458](https://github.com/galaxyproject/planemo/pull/1458).
- **Don't use `compare: diff` on outputs that embed timestamps or non-deterministic ordering.** Switch to `has_text` / `has_n_lines` (with `delta:`) or `compare: sim_size`+`delta:`.
- **Bump `release:` in the `.ga` and add a `CHANGELOG.md` entry** in the same PR — enforced by the IWC PR template; reviewers verify via `bump_version.py`.
- **Lower-case + `-` only** in directory names — `workflows/README.md:11,72`.
- **Element identifiers must round-trip** — quote in YAML when they contain pipes/colons/whitespace.

## 7. What is *not* covered by current convention

Gaps an agent should be aware of:

- **`composite_data:` is unrepresented in the IWC corpus.** No working examples to imitate for imzml+ibd or other multi-file datatypes. Treat as off-trail; cite planemo docs and verify by parser.
- **`tags:` on elements unused.** Galaxy 20.09+ supports them; IWC does not exercise them.
- **CWL-style shorthand File lists unused.** IWC always names elements.
- **No negative tests.** Zero `expect_failure:` across the sampled corpus. There is no IWC convention for asserting a workflow *should* fail on bad input.
- **No checksum-based output assertion in the wild.** `checksum: "sha1$..."` is documented and used at the input side as `hashes:`, but output-side `checksum:` was not surfaced in sampled tests. The corpus prefers `file:` (exact), `compare: sim_size`+`delta:` (size only), or `asserts:` (content probes).
- **No data-cache layer beyond pip/planemo.** Every test re-pulls remote inputs from Zenodo / EBI / SRA on every CI run. A Zenodo outage breaks many PRs simultaneously. There is no IWC-side mirror or cache.
- **No per-test timeout / retry convention.** A hung tool blocks the whole chunk until the GitHub Actions 6-hour limit.
- **No portable story for CVMFS-only tests.** The same `-tests.yml` either works locally (URL-driven) or works in CI (CVMFS-string-driven), not both. There is no documented switch.
- **Hash function is de-facto SHA-1.** The spec accepts SHA-256/SHA-512/MD5; IWC does not use them. Agents that emit a stronger hash will pass planemo but break corpus convention.
- **Local-file `hashes:` are inconsistently present.** `--from_invocation`-generated tests have them, hand-written tests usually don't. Either is accepted; don't expect uniformity.
- **`decompress: true` and `dbkey:` are file-level attributes** but undocumented at the planemo test_format page in the same place as `class:`/`location:`/`hashes:`. Cross-reference against the `gxformat2` Schema-Salad bindings if unsure.
- **`?download=1` query string on Zenodo URLs** is optional. Both forms appear (`/record/4555735/files/X?download=1` vs `/records/11484215/files/Y`). The newer `/records/` plural is the modern Zenodo URL form; both work.

## Cross-references

- galaxy-workflow-testability-design — workflow input/output structure choices that make these fixture shapes testable.
- `https://github.com/jmchilton/galaxy-brain/blob/main/vault/projects/workflow_state/skills/COMPONENT_GALAXY_WORKFLOW_TESTING.md` — full synthesis with assertion-vocabulary table, CI internals, and tooling rundown. Sections 2b, 3, 4, 5, 9 are the direct upstream of this note.
- planemo test format spec: [planemo.readthedocs.io/en/latest/test_format.html](https://planemo.readthedocs.io/en/latest/test_format.html).
- planemo best practices: [planemo.readthedocs.io/en/latest/best_practices_workflows.html](https://planemo.readthedocs.io/en/latest/best_practices_workflows.html).
- planemo collections reference: [github.com/galaxyproject/planemo/blob/master/docs/_writing_collections.rst](https://github.com/galaxyproject/planemo/blob/master/docs/_writing_collections.rst).
- IWC contribution contract: `workflows/README.md` in [github.com/galaxyproject/iwc](https://github.com/galaxyproject/iwc).
- Galaxy datacache (CVMFS `.loc` browsing): [datacache.galaxyproject.org/indexes/location/](http://datacache.galaxyproject.org/indexes/location/).
