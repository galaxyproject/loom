# Galaxy integration and routing

Three operating modes are an _outcome_ of the plan you draft, not a
configuration setting:

- **local** — every step runs locally
- **hybrid** — some local, some Galaxy
- **remote** — entire plan is one Galaxy workflow invocation

The agent makes the routing decision **per plan, during drafting**,
once Galaxy is connected. The mode follows from those step-by-step
decisions.

## When Galaxy is connected

Before drafting a plan, consult Galaxy resources:

1. **Search the IWC workflow registry** for matching workflows. If a
   full match exists, propose running the plan as a single Galaxy
   workflow invocation (mode: **remote**).
2. **Search the Galaxy tool catalog** per step
   (`galaxy_search_tools_by_name`). For each step:
   - Heavy compute (alignment, large variant calling, big assemblies,
     long-running BLAST) — if the Galaxy server has the tool, mark it
     Galaxy.
   - Light/exploratory (parsing, summarization, awk/sed/jq, small
     scripts) — mark it local.
3. Document each routing decision inline in the markdown plan section.

## When Galaxy is not connected

All execution is local. Suggest connecting via `/connect` once if the
plan would benefit from Galaxy compute, but don't badger.

## Invocation tracking

After invoking a Galaxy workflow and getting an `invocationId` back:

```
galaxy_invocation_record({
  invocationId,
  notebookAnchor: "plan-a-step-3",
  label: "BWA alignment"
})
```

This writes a `loom-invocation` YAML block to the notebook so polling
tools can find it later.

Periodically call `galaxy_invocation_check_all` to advance in-flight
work. The tool auto-transitions YAML status (all-jobs-ok → completed,
any-error → failed) and writes results back to the notebook. After a
transition, inspect the output datasets enough to confirm they exist and
look plausible for the request. Then write that verification evidence to
the notebook and edit the markdown checkbox: `- [ ]` → `- [x]` (or
`- [!]` on failure).

Treat invocation YAML status as Galaxy job state. Treat the plan checkbox
as verified-result state: a YAML `completed` invocation still needs
output inspection and notebook evidence before the corresponding step is
marked `- [x]`.

## Artifact verification

Generated Galaxy artifacts are not complete just because a file exists
locally. For authored workflows (`.ga` or workflow JSON), import/upload
the workflow to Galaxy, invoke it on a small appropriate test input, poll
to a terminal state, and inspect the outputs. If credentials, test data,
or tool availability block that check, record the blocker and say
"created but not verified" rather than claiming the artifact is done.

Useful verification examples:

- Galaxy dataset: check state, datatype, size/metadata, and a small
  preview/peek; for collections, confirm element count and failures.
- BAM/CRAM: use Galaxy metadata or `samtools quickcheck`; add `flagstat`
  or `idxstats` when alignment quality or reference coverage matters.
- VCF/BCF: parse headers, count records, check sample names, and verify
  compression/index status when downstream tools need it.
- FASTQ/FASTA: verify gzip/container integrity, read/sequence counts, and
  expected identifiers in a small preview.
- CSV/TSV/JSON/YAML/config: parse with a real parser, check required
  columns/keys, and compare row/object counts to the request.
