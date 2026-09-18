---
type: research
tags:
  - target/galaxy
status: draft
created: 2026-04-30
revised: 2026-05-11
revision: 6
related_notes:
  - "galaxy-workflow-testability-design"
  - "iwc-test-data-conventions"
  - "iwc-shortcuts-anti-patterns"
  - "implement-galaxy-workflow-test"
  - "tests-format"
  - "planemo-workflow-test-architecture"
  - "validate-tests"
  - "iwc-tabular-operations-survey"
  - "galaxy-discover-datasets"
summary: "Decision and idiom guide for picking planemo workflow-test assertions: which family per output type, how to size tolerances, when to validate."
---

# Planemo asserts: idiom and decision guide

Companion to iwc-test-data-conventions (input shapes), galaxy-workflow-testability-design (workflow structure before test YAML exists), and iwc-shortcuts-anti-patterns (what's accepted vs smell). This note is forward-looking: when authoring a new `<workflow>-tests.yml`, which assertion family fits which output, and what the recommended tolerances and operators are.

The **vocabulary itself is not restated here** — every assertion's parameter list, types, defaults, required fields, and Python docstring is rendered from the test-format JSON Schema at tests-format. Assertion names below deep-link into that page (e.g. has_text jumps straight to that `$def`).

## 1. Choose by output type

The single most useful decision table. Pick the row that matches the file format the workflow emits; default to the recommended assertion family.

| Output type | Default assertion family | Why | Fallback |
|---|---|---|---|
| **Plain text reports / logs** (FastQC summary, MultiQC text section) | has_text (substring on a known stable token) + has_n_lines with `delta:` | Substring is robust across versions; line count catches truncation | has_text_matching (regex) when token text changes per run |
| **HTML reports** (MultiQC HTML, custom dashboards) | has_text against stable section names | HTML embeds timestamps and asset hashes; byte-diff is hopeless | has_size + large `delta` as last resort |
| **Tabular** (TSV, CSV, BED-like) | has_n_columns + has_text for headers + has_n_lines with `delta:` | Schema-shape + content probes; tolerant to row reordering | has_line_matching for a known canonical row |
| **VCF** | `compare: diff` with `lines_diff: 6` | The `lines_diff: 6` constant matches the typical VCF header preamble that embeds `##fileDate=` and `##source=` | has_text_matching for known variants |
| **BAM** | has_size + has_archive_member (BAM is a gzipped block format) | Headers contain `@PG` lines with command lines and Galaxy job IDs; never byte-diff | Convert to SAM in a downstream step and assert on text |
| **FASTA** (deterministic — assemblies, consensus) | `file:` exact comparison or has_text for known sequence | Output is byte-stable when the upstream tool is deterministic | has_n_lines if line wrapping varies |
| **FASTA** (non-deterministic — RepeatModeler libraries) | `compare: sim_size` with large `delta:` | Family content varies run-to-run | has_n_lines with `delta:` |
| **FASTQ** (rare as workflow output) | has_n_lines (must be multiple of 4) | Quality scores are read-id-dependent | `compare: sim_size` |
| **JSON** (deterministic — config dumps, params) | has_json_property_with_value / has_json_property_with_text | Surgical: assert on the property you care about, ignore the rest | `compare: diff` if the JSON is fully canonical |
| **JSON** (stochastic — HyPhy stats, MCMC results) | `has_text: text: "{"` (existence-only) | Embedded floats break any structural assertion; see iwc-shortcuts-anti-patterns §1 | has_h5_keys-equivalent for top-level structural keys |
| **HDF5 / AnnData** | has_h5_keys + has_h5_attribute for known structure | Asserts shape, not values — values are float-noisy | has_size with `delta:` |
| **XML** | is_valid_xml + has_element_with_path + `element_text_is`/`element_text_matches` | Surgical structural probes; byte-diff fails on whitespace/attribute-order | has_n_elements_with_path for cardinality |
| **PNG / image plots** | has_image_width + has_image_height + has_size with `delta:` (5–10%) | Catches "rendered something with the right dimensions"; corpus norm | has_image_center_of_mass if mask/segmentation outputs are deterministic |
| **TIFF / multipage images** | has_image_frames + has_image_channels + has_size with `delta:` | Same logic, channel/frame structure matters | — |
| **Archives** (zip, tar.gz) | `has_archive_member: path: "regex"` with nested `asserts:` | Asserts on a specific member; archive timestamps never byte-stable | has_size with `delta:` |
| **GFF / GTF** | has_n_lines with `delta:` + has_text for known feature | Tools reorder freely; hard to byte-diff | `has_n_columns: 9` (GFF spec) |
| **Cool / HiC matrices** | `compare: sim_size` with multi-MB `delta:` | Binary, run-to-run variance | has_archive_member for HDF5 component |

When in doubt: start with has_size + `delta_frac: 0.1`. It catches the catastrophic failure mode (empty / 10x bigger output). Then add a content probe.

### 1a. If the assertion is too weak, revisit the workflow output

Assertion choice sometimes reveals a workflow-design problem. If the only available output can support only a size check or image-dimension smoke test, check whether the workflow should expose a stronger checkpoint before settling for the weak assertion.

- Scanpy's plot outputs use size and image-dimension assertions, but the same workflow also exposes AnnData HDF5 checkpoints and a cluster-count table (`$IWC/workflows/scRNAseq/scanpy-clustering/Preprocessing-and-Clustering-of-single-cell-RNA-seq-data-with-Scanpy-tests.yml:33-205`).
- RNA-seq paired-end uses coarse size bands for coverage/mapped-read outputs, but expression/count tables get stronger regex and exact-line checks (`$IWC/workflows/transcriptomics/rnaseq-pe/rnaseq-pe-tests.yml:48-97`).

Rule: if a translated workflow exposes only weakly assertable final reports, consult galaxy-workflow-testability-design and consider promoting a table/text/HDF5 checkpoint before writing the final assertions.

## 2. The `compare:` operators

Top-level on a `file:` output assertion. Vocabulary, in decreasing strictness:

- **`diff`** (default). Byte-for-byte equality with optional `lines_diff:` tolerance for a fixed number of header lines. Use only when the upstream tool is deterministic on fixed inputs *and* the output has no embedded timestamps, command lines, version banners, or hash-ordered Python-dict-style keys.
- **`re_match` / `re_match_multiline`**. Each line of the expected fixture is a regex that must match the corresponding output line. Useful when a few fields per row are timestamped but the rest is canonical. Rare in the corpus.
- **`contains`**. The expected fixture is a substring of the output. Cheap; weak. Prefer `asserts: has_text` for new code unless you genuinely have a multi-line block to assert as a whole.
- **`sim_size`**. Output file size matches the fixture's size within `delta:` (bytes) or `delta_frac:` (fraction). Use when the output is necessarily non-deterministic but its rough size is reproducible (RepeatModeler libraries, HiC matrices, Bayesian sampler outputs).

Picking `lines_diff:`: count the mutable header lines in the output format. VCF: ~6 (`##fileformat`, `##fileDate`, `##source`, `##reference`, contig/info lines vary). SAM/text headers: count `@HD`/`@PG`/`@CO` lines. Set `lines_diff:` to the count exactly — looser values mask real diffs.

## 3. Tolerance picking

**`delta:`** is bytes (for has_size and `compare: sim_size`) or absolute count (for has_n_lines, has_n_columns, has_image_width, etc.). Suffix multipliers documented in the schema — `1K`, `1M`, `1G` work.

**`delta_frac:`** is a fraction (0.1 = 10%). Use when expected size scales with input volume. Three IWC tests use it (`scRNAseq/baredsc/*`, `genome-assembly/polish-with-long-reads/*`); the rest use absolute `delta:`.

**Picking magnitudes** (from corpus survey in iwc-shortcuts-anti-patterns §2):

- Image dimensions: `delta: 25–30` pixels (5% of typical matplotlib defaults).
- Image file size: `delta: 5K–60K` (5–10% of file size).
- Small text reports: `delta: 1K–10K`.
- HTML reports: `delta: 25K–100K`.
- BAM files: `delta: 1M–10M`.
- RepeatModeler / Bayesian sampler outputs: `delta: 30K–90M` (extreme, but justified by the underlying nondeterminism).

**Heuristic for new outputs:** `delta_frac: 0.1` is a defensible default. Tighten if the output proves more deterministic than expected.

## 4. Text family — has_text vs has_text_matching vs has_line vs has_line_matching vs has_n_lines

All five are common; choose by what you're verifying.

- **has_text** — output contains the substring `text:`. Anywhere in the output, any number of times. Add `n:` / `min:` / `max:` to constrain occurrence count. Add `delta:` to allow slack on the count.
- **has_text_matching** — output matches the regex `expression:`. Use sparingly; prefer literal has_text when you can.
- **has_line** — output has at least one *line* matching `line:` exactly. Use when line boundaries matter (e.g. asserting on a specific row in a table).
- **has_line_matching** — same but with regex.
- **has_n_lines** — assert the line count is `n:` ± `delta:`.

A common combination in IWC: `has_n_lines: n: 100, delta: 5` + `has_text: text: "expected_token"` — line-count sanity-check plus a content marker. This catches both truncation and content drift in one assertion pair.

`negate: true` is supported on every assertion. Used for the "this output should NOT contain X" case.

## 5. Collection output assertions (`element_tests:`)

For Galaxy collection outputs, the test format keys element assertions by element identifier:

```yaml
my_collection_output:
  element_tests:
    sample_1:
      asserts:
        has_text:
          text: "expected"
    sample_2:
      file: test-data/expected_sample_2.txt
```

Optional `attributes:` at the collection level can assert on the produced collection shape:

```yaml
my_collection_output:
  attributes: {collection_type: list:list}
  element_tests:
    ...
```

Nested collections: outer `element_tests:` keyed by outer identifier; inner uses `elements:` (note plural, no `_tests` suffix on the inner). See iwc-test-data-conventions §2f for the live example.

For a list-of-files where every element should pass the same minimal check, the existence-probe pattern (`has_text: "{"` for JSON; `has_size: min: 100` for any non-empty binary) is widely used and accepted in IWC.

## 6. The validate-against-workflow inner loop

A `-tests.yml` file can be **structurally invalid** in two distinct ways:

1. **Schema-invalid** — wrong field names, wrong nesting, wrong types. Caught by the test-format JSON Schema.
2. **Workflow-incoherent** — schema-valid YAML, but the input/output labels don't match the actual workflow. Renaming an output in the `.ga` and forgetting to update its sibling `-tests.yml` produces this case. Planemo will surface it as an "output not found" error at test-runtime, but only after a full workflow run.

The `@galaxy-tool-util/schema` npm package ships **two** validators that catch both cases statically — no Galaxy or Planemo invocation needed:

- **`validateTestsFile(yaml)`** — runs the file against `tests.schema.json` (AJV). Reports schema violations with paths.
- **`checkTestsAgainstWorkflow(workflow, tests)`** — cross-checks a `.ga` / format2 workflow against a tests file: missing input labels, missing output labels, type incompatibilities (e.g. test supplies a `File` for a parameter typed `int`).

Both are pure-JS, take milliseconds, and have no Galaxy dependency. Wire them into the inner authoring loop:

```
edit -tests.yml
  → validateTestsFile()                    # schema gate
  → checkTestsAgainstWorkflow(.ga, tests)  # coherence gate
  → planemo workflow_test_on_invocation    # assertion gate (no full re-run)
  → planemo test                           # full integration (slow)
```

The first two gates short-circuit cheap mistakes before a slow planemo run. They are the static-validation equivalent of `gxwf` for tests, and the `implement-galaxy-workflow-test` mold should reference them as its primary inner-loop tooling. Source: galaxy-tool-util-ts package, `src/test-format/index.ts` exports.

## 7. Authoring loop — generation, then refinement

Reviewer convention is to **generate** the initial `-tests.yml` rather than hand-write it. Two planemo subcommands cover this:

- **`planemo workflow_test_init --from_invocation <invocation_id>`** (planemo-workflow_test_init) — given a successful Galaxy invocation ID, emit a `-tests.yml` with a `job:` block that captures all inputs (with SHA-1 hashes) and an `outputs:` block with `file:` references to the actual outputs (downloaded into `test-data/`). Hand-tighten the assertions afterward.
- **`planemo workflow_test_on_invocation <tests.yml> <invocation_id>`** (planemo-workflow_test_on_invocation) — re-evaluate an edited `-tests.yml` against a saved invocation without re-running the workflow. The fast inner loop for assertion iteration; complements the static gates in §6.

Together these cut the assertion-iteration cost dramatically. An agent should:

1. Run the workflow once on usegalaxy.* (or local) to get a known-good invocation.
2. `--from_invocation` to bootstrap the test file.
3. Replace the autogenerated `file:` exact-comparison assertions with assertion-family-appropriate alternatives per §1.
4. planemo-workflow_test_on_invocation after each edit; full planemo-test at the end.

## 8. What the schema gives you for free

When the test-format schema lands as a Foundry-rendered note, the agent can consult any assertion's `$def` directly for: parameter types, defaults, required fields, the `that` discriminator constant, and the original Python docstring (carried through as `description`). This note does **not** restate that vocabulary — it complements it with the corpus-grounded *which-and-when*.

What's still missing from the schema and worth keeping in research notes:

- This decision table (§1) — output-type → assertion family.
- Tolerance magnitudes (§3) — corpus-derived defaults.
- The `validateTestsFile` / `checkTestsAgainstWorkflow` integration story (§6).
- Anti-pattern flags — see iwc-shortcuts-anti-patterns.

## 9. Common combinations (recipes)

Six recipes worth memorizing.

**Stable text report (FastQC summary, simple stats).**
```yaml
my_report:
  asserts:
    has_n_lines: { n: 12, delta: 2 }
    has_text: { text: "Total Sequences" }
```

**MultiQC HTML report.**
```yaml
multiqc_report:
  asserts:
    has_text: { text: "Filtered Reads" }
    has_text: { text: "FastQC" }
```

**VCF (pinned tool, fixed reference).**
```yaml
called_variants:
  file: test-data/expected.vcf
  compare: diff
  lines_diff: 6
```

**Stochastic JSON (HyPhy-style).**
```yaml
hyphy_meme:
  element_tests:
    geneA: { asserts: { has_text: { text: "{" } } }
    geneB: { asserts: { has_text: { text: "{" } } }
```

**Matplotlib plot.**
```yaml
umap_plot:
  asserts:
    has_size: { size: 68416, delta: 6000 }
    has_image_width: { width: 601, delta: 30 }
    has_image_height: { height: 429, delta: 25 }
```

**AnnData (HDF5).**
```yaml
clustered_anndata:
  asserts:
    has_h5_keys: { keys: "obs/louvain" }
    has_h5_keys: { keys: "var/highly_variable" }
    has_h5_keys: { keys: "uns/rank_genes_groups" }
    has_size: { size: 12000000, delta: 1500000 }
```

## 10. Cross-references

- galaxy-workflow-testability-design — decide which workflow outputs and checkpoints to expose before choosing assertions.
- iwc-test-data-conventions — input-side conventions (job inputs, collection shapes, `hashes:`, CVMFS).
- iwc-shortcuts-anti-patterns — accepted-vs-smell catalog and corpus prevalence; this note's mirror image.
- Test-format schema (`@galaxy-tool-util/schema` npm package) — authoritative vocabulary; will be vendored into a Foundry-rendered schema note. See `content/meta/casting.md` for the casting story.
- Planemo test-format spec: [planemo.readthedocs.io/en/latest/test_format.html](https://planemo.readthedocs.io/en/latest/test_format.html).
- galaxy-xsd — Galaxy XSD assertion source of truth, vendored from upstream.
- Tightening of the schema and Pydantic source: [galaxyproject/galaxy#22566](https://github.com/galaxyproject/galaxy/pull/22566).
- TS schema sync into npm: [jmchilton/galaxy-tool-util-ts#75](https://github.com/jmchilton/galaxy-tool-util-ts/pull/75).
