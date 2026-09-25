# Galaxy integration and routing

Four routing modes are an _outcome_ of the plan you draft, not a
configuration setting:

- **galaxy** — steps run on Galaxy's tools and workflows; the default
  when a matching Galaxy tool or workflow exists
- **hybrid** — some steps local, some on Galaxy
- **local** — every step runs locally
- **remote** — entire plan is one Galaxy workflow invocation (an IWC
  workflow matches it end to end)

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

## Getting remote data into a history

When a history needs a file that lives at a public URL (reference
genomes, model weights, SRA/ENA accessions, released datasets, anything
addressable by http/https/ftp), hand Galaxy the URL and let its server
fetch it directly. Do **not** download the file locally and re-upload it.
A local download plus a local→Galaxy upload doubles the transfer, spends
the user's upstream bandwidth, fills local disk, and blocks the turn (a
2.3 GB local→Galaxy upload took 8+ minutes on a normal connection, where a
server-side fetch runs at datacenter bandwidth).

- Preferred: the Galaxy MCP fetch-by-URL tool
  `galaxy_upload_file_from_url({ url, history_id })` (optional `file_name`,
  `file_type`, `dbkey`).
- Scripting bioblend instead: use `gi.tools.put_url(url, history_id)` (one
  URL per line for several), which Galaxy fetches server-side. Don't call
  `gi.tools.upload_file()` on a path you just downloaded from that URL.
- Local→upload is the exception, used only when the source is genuinely
  local: a file the user created, or one that exists only on this machine
  with no URL Galaxy can reach itself.

## When Galaxy is not connected

All execution is local. Suggest connecting via `/connect` once if the
plan would benefit from Galaxy compute, but don't badger.

## When there is no local shell (remote-only builds)

Some builds have no local shell at all -- notably the native Windows
desktop, which removes the `bash` tool entirely. There, every step must
run on Galaxy: route plans **remote** (or per-step Galaxy). A plan that
needs a local leg (**local** or **hybrid**) is rejected by the init-gate
at `/execute` with a "re-tag `[galaxy]`/`[remote]`" message, so draft for
Galaxy from the start. File read/write in the workspace still works; only
shell/`bash` execution is unavailable.

## Invocation tracking

After invoking a Galaxy workflow and getting an `invocationId` back:

```
galaxy_invocation_record({
  invocationId,
  notebookAnchor: "plan-a-step-3",
  label: "BWA alignment"
})
```

Loom already wrote the `loom-invocation` block itself when the submission
answered, so this normally just sets the label and the anchor on it --
naming the plan step the run belongs to. It writes a new block only when
nothing in the notebook carries that invocation id.

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

### The evidence gate checks that

This is no longer only advice. Loom watches every `Edit`/`Write` to
`notebook.md` and reads the file as it stood _before_ the write. A plan
step going `- [ ]` → `- [x]` while the `loom-invocation` block bound to
its anchor still reads `status: in_progress` is a contradiction: a
verified result claimed for a run Galaxy says has not finished. That
status is written by the poller from Galaxy job state, not by you, so
rewriting it in the same edit does not clear the contradiction.

The gate ships in `warn` mode -- the write goes through and the decision
is recorded to `activity.jsonl` as an `evidence.decision` event. In
`deny` mode the write is refused, and the way forward is one of: leave
the step pending while the run is going, mark it `- [!]` and record what
failed, or -- if Galaxy has actually finished and the block is stale --
call `galaxy_invocation_check_all`, inspect the outputs, record that
evidence, and then flip the checkbox.

Deliberately narrow, so it does not fire on honest work: a flip with no
bound invocation gets no opinion, a `failed` block is never gated (it is
sticky and cannot be re-polled), and a rerun that leaves a stale block
beside a `completed` one for the same anchor is not a contradiction.

A refused write stays refused for as long as the contradiction stands.
Do not retry it unchanged. The exception belongs to the user, not to
you: if you think the gate is wrong, say so and ask them to run
`/override <step-anchor> <reason>`, which clears that one step for one
write and records the reason. Repeating the write is not a way to get
past it.

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

## Automatic follow-up

Loom queues a follow-up by default when a tracked job or workflow completes or
fails, including the first job failure in a workflow that is still running.
Check the latest notebook and user instructions before acting on a queued event.
Verify completed outputs and investigate failures without asking the researcher
to request those checks again. Record evidence in the notebook. Continue work
already authorized by the researcher only after its prerequisites are verified;
respect explicit pause/stop requests and do not create a new plan. Diagnose a
failure before repairing it, avoid blind or repeated retries, and ask only when
a necessary decision, information, or authorization is missing. Cancelled and
conditionally skipped runs do not trigger a follow-up.

Follow-ups pause after 3 consecutive automatic turns with no user input
(`experiments.autoResumeMaxTurns`), and when the user stops a turn; the user is
notified and the next message or command resumes them. Results that arrive
while paused are still recorded in the notebook.

Automatic follow-up can be disabled with `LOOM_AUTO_RESUME=0` or
`experiments.autoResume: false` in `~/.loom/config.json`.

## Batch SRA/ENA imports

Gather and deduplicate all run accessions requested for the current analysis
before submitting downloads. Inspect the notebook and destination history first:
reuse verified inputs, wait for matching jobs already running, and retry only
missing or demonstrated failures. Do not expand a request to every run in a
study or replace already verified inputs without that scope being requested.

For IUC `fastq_dump` / `fasterq_dump`, use one submission per compatible set of
accessions. Inspect the installed template and either:

- Set `input|input_select=accession_number` and provide a comma-separated string
  in `input|accession`; this avoids uploading an extra manifest dataset.
- Set `input|input_select=file_list` and point `input|file_list` at one text HDA
  containing one accession per line. Do not map over a collection of lists.

For paired-end runs, use the wrapper's native `list:paired` output instead of
creating per-run collections and merging them. Preserve requested parameters,
compression, and singleton/other outputs. Verify collection population, expected
accession identifiers/counts, both mates, dataset states, and suitable content
checks before downstream analysis. Job success alone is not output verification.
Batching reduces submission overhead and collection clutter; it does not remove
the need to extract each run. Different parameters or demonstrated server/resource
limits may justify separate batches. ENA URLs should similarly use a batched
server-side fetch into a paired collection, with checksums when supported.

Loom's `sra-import-gate` blocks sibling single-accession calls to the known IUC
wrappers when history, tool version, and other settings match. It blocks the
entire group before dispatch, gives the model a combined accession list, and
keeps the rejected batch together during tool-error recovery. It also blocks
explicit Galaxy mapping/batch expansion and repeated accessions within one
literal list. The gate does not ask the user for approval or silently rewrite
parameters. Its scope is structured `galaxy_run_tool` calls (including the MCP
proxy), not opaque scripts, workflow internals, or unknown custom wrappers.
Single-accession requests and later targeted retries remain available. Accessions
introduced one at a time without an observed sibling group and cross-session
history reuse rely on the always-loaded guidance; this is an efficiency guard,
not a complete scheduler or duplicate-download registry.

Reference: [IUC SRA wrapper input modes and accession loop](https://github.com/galaxyproject/tools-iuc/blob/main/tools/sra-tools/macros.xml).
