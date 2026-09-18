---
type: research
title: "Open-requirements ledger"
tags:
  - target/galaxy
status: draft
created: 2026-06-16
revised: 2026-08-29
revision: 3
related_notes:
  - "galaxy-workflow-draft-format"
related_molds:
  - "advance-galaxy-draft-step"
  - "repair-galaxy-draft-topology"
  - "implement-galaxy-tool-step"
summary: "Carried unresolved-requirements artifact the source→Galaxy pipeline discharges or explicitly surrenders, autonomously."
---

# Open-requirements ledger

The `open-requirements-ledger` is a single artifact threaded through the source→Galaxy pipeline that records **obligations the pipeline has taken on but not yet met** — a declared output with no producer, a parameter whose value the source never pinned, a tool with no corpus exemplar — and **source work it decided not to carry**. Each Mold that surfaces one **appends** it; each Mold whose decision closes one **marks it resolved**; the terminal path **surrenders** whatever remains open, explicitly, into the final artifact.

## Framing: obligations the pipeline discharges, not questions a human answers

This is deliberately *not* an "open questions for the user" list. The pipeline is autonomous — no human-in-the-loop gate is assumed. The ledger's consumers are **Molds and the loop's convergence gate**, with human readout a secondary affordance. An entry is closed by a downstream Mold doing work (wiring a producer, picking a wrapper, settling a value), or — when nothing can close it — surrendered: written into the final draft as a known, labelled gap rather than silently dropped or fabricated around.

The distinction matters because a "questions for a human" framing leaks an operator's personal interaction style into a tool meant to run inside anyone's harness. The ledger must behave identically cast into a fresh harness with no ambient configuration; that holds only because every obligation is **materialized in the artifact**, never carried as operator habit.

## Entry shape (v1, loose)

Like the `_plan_*` family in galaxy-workflow-draft-format, ledger entries are intentionally low-ceremony for v1 — enough structure to count and close, no contract pretending to be machine-parameterizable yet. A reasonable per-entry shape:

```yaml
- id: sccmec-evidence-missing
  status: open                # open | resolved | surrendered
  kind: gap                   # gap | dropped — see below; omit for gap
  blocking: true              # true only for a computability gap; the convergence gate counts these
  raised_by: implement-galaxy-tool-step   # Mold that appended it
  step: classify_context       # draft step the obligation attaches to (if any)
  unmet: "SCCmec-region candidate output category"
  missing: "no wired input carries SCCmec cassette evidence"
  resolved_by: null            # Mold that closed it, once closed
  supersedes: null             # id whose justification this entry refutes, once resolved
  note: ""                     # how it was closed or why surrendered
```

`kind` separates the two things an open entry can mean, which v1 conflated. A **`gap`** is
an obligation the pipeline cannot discharge: no producer is discoverable, Galaxy has no
datatype for the format, the source pinned no value. A **`dropped`** entry is source work
the pipeline *declined to carry* — a plane cut from the design, a parameter surface not
exposed, an output the repair removed. Both are honest; they are not the same admission,
and a reader cannot tell them apart from `unmet` / `missing` alone. Omit `kind` for a
plain gap.

A `dropped` entry carries two more fields:

```yaml
- id: annotation-planes-not-built
  status: open
  kind: dropped
  raised_by: nextflow-summary-to-galaxy-data-flow
  units: "25 of 31 designed nodes (rnaseq_short, gnomon, annot_proc, convert)"
  because: "`gxwf tool-search asn1` returns no wrapper reading seq-submit; searched 2026-08-29"
  unmet: "the pipeline's actual product — an annotated genome"
  missing: "the carried spine masks an assembly; it does not annotate a genome"
  note: ""
```

`units` names what was dropped in the source's own terms, so the drops can be totalled
without re-reading the design.

`because` says why, and **must carry its citation** — the source construct that is not
there, the target limitation named specifically enough that someone could check it, the
search actually run. A drop's reason is a claim about the world, and the first real run is
why the burden exists: 25 of 31 planes were cut because "each needs an authored Galaxy
wrapper for an undocumented binary available only inside the pipeline's container," and a
Tool Shed search one phase later found the whole pipeline already wrapped at the exact
pinned version. The claim was not dishonest. It was never checked, and nothing in the
entry showed that it had not been.

A reason you can cite, cite. A reason you cannot cite is still recorded — write it plainly
and leave it uncited rather than dressing it as evidence — but an uncited drop is not a
finding the run may reason from afterwards. It is a debt, and it should read as one.

Provenance (`raised_by`, `resolved_by`) is the audit trail for *when* each obligation entered and left — the traceability #281 asked for, and the evidence the convergence gate reads.

`blocking` separates the two grades of obligation the pipeline carries. A plain entry is an unmet need the chain can keep working around — an unpinned parameter, a missing exemplar. A **blocking** entry is a computability gap: a declared step output no wired input can supply, which `gxwf` validation cannot see because the connection graph knows ports connect, not what they carry. Omit `blocking` (or set it `false`) for a plain obligation. Only blocking entries drive topology-repair escalation, and only they are counted by the decreasing-blocker invariant.

## How to use the ledger

This section is the runtime protocol for every Mold that carries the ledger. A Mold's own page states only what is local to it — what raises an entry there, and what it does when it reads one; the mechanics are here.

**Read it before you decide.** Ahead of the decisions this step owns, read the `open` entries. Ones bearing on those decisions are the ones you may be able to close. Never re-derive an obligation the chain already recorded — that re-derivation is the failure this artifact exists to end.

**Start one when none is supplied.** Every carrying Mold declares the ledger as an input, but the first Mold in a run receives none. Its absence is not an error: start an empty ledger at the declared filename and proceed.

**Append what you newly surface.** Each new obligation gets a stable kebab-case `id`, `status: open`, `raised_by` set to your own Mold name, and enough in `unmet` / `missing` for a later Mold to act without re-reading the source. Attach it to a draft step via `step` where one applies. Set `blocking: true` only for a computability gap.

**Mark resolved what you close.** When a decision you make discharges an open entry, set `status: resolved`, `resolved_by` to your own Mold name, and `note` to how it closed. Resolving is not deleting — a resolved entry stays in the ledger as the audit trail.

**Carry the rest untouched.** Entries you neither raise nor close pass through unchanged, statuses and provenance intact. Never renumber, re-word, or drop another Mold's entry.

**Never fabricate around an entry.** An open obligation is the honest state. Inventing a connection, a tool id, or a value so the artifact looks complete converts a tracked gap into a silent defect — the specific failure the ledger replaces.

**Record a drop as a drop.** When a decision removes source work from what the run will
carry — narrowing a design, cutting a plane, dropping an output during repair — append a
`kind: dropped` entry naming the `units` and a cited `because`. A cut recorded only as
prose in a brief is invisible to every later Mold; a cut recorded as a `gap` reads as
something the pipeline could not do rather than something it chose not to do. Recording
the drop is not the same as discharging it, and a well-written entry is not a substitute
for the work — an entry makes a cut *legible*, never *justified*.

**A refuted justification reopens its decision.** When work you do contradicts the
`because` another entry rests on — discovery finds the wrapper a drop assumed absent, a
later brief supplies the evidence a narrowing assumed missing — set `supersedes` to that
entry's `id` on your own resolved entry, and return the superseded entry to `status: open`
with its `because` struck and the contradiction quoted in its `note`. Do not leave a
refuted rationale standing: the terminal writes these into the final artifact, and a
surrendered gap whose stated reason is known to be false is worse than an unexplained one.
Reopening does not oblige *you* to do the dropped work — it obliges the run to stop
claiming a settled reason it no longer has.

**Record a surrender note; leave the status to the terminal.** When you cannot close an entry and nothing downstream can either — no producer is discoverable, the output cannot be honestly narrowed — leave it `open` and say so in `note`. `surrendered` is a terminal status, set at the end of a run: the escalation cap reached, or the final artifact emitted with the obligation still unmet. Either way the entry stays visible and is written into the final artifact as a labelled gap, never dropped.

**Maintain the escalation budget** — loop Molds only. The `topology_repair` header is loop-level state, described under **Escalation budget (loop-level state)** below. On each escalation the orchestrator increments `escalations`, appends the post-repair open blocking-entry count to `open_history`, and surrenders the still-open blocking entries once `escalations` reaches `cap`.

## Role in topology repair

In the Galaxy per-step loop, the ledger is the substrate the topology-repair escalation rides on (see galaxy-workflow-draft-format and repair-galaxy-draft-topology):

- **implement-galaxy-tool-step** detects, mid-implementation, that a declared step output cannot be computed from its wired inputs. Rather than fabricate, it appends a blocking entry and falls through to repair.
- **repair-galaxy-draft-topology** reads the open blocking entries, re-wires the affected region (template-tier authoring — one step or a small sub-path), and marks each entry it closes `resolved`; the existing discover-or-author → implement machinery then realizes the new steps.
- The loop's **decreasing-blocker invariant** counts open blocking entries: each repair escalation must strictly reduce that count, under a hard cap on escalations. When the cap is hit with entries still open, those entries are **surrendered** into the final draft — the clean terminal that replaces spin-or-fabricate.

So the ledger is not a convenience here; it is the countable state the termination guard depends on.

## Escalation budget (loop-level state)

The decreasing-blocker invariant needs more than the entries themselves: "strictly reduce the open count, under a hard cap" is *loop-level* state — it spans iterations and belongs to no single entry. The ledger carries it in a small `topology_repair` header beside the `entries:` list:

```yaml
topology_repair:
  escalations: 2           # repairs invoked this run
  cap: 5                   # hard ceiling; at cap, still-open entries are surrendered
  open_history: [4, 3, 2]  # open blocking-entry count after each escalation — must be strictly decreasing
entries:
  - id: sccmec-evidence-missing
    status: open
    blocking: true
    # … per-entry shape above
```

- `escalations` — how many times advance-galaxy-draft-step has escalated to repair-galaxy-draft-topology this run. The orchestrator increments it on each escalation.
- `cap` — the hard ceiling. When `escalations` reaches `cap`, the loop stops escalating and surrenders any still-`open` blocking entries into the final draft as labelled gaps rather than retrying forever.
- `open_history` — the open blocking-entry count recorded after each escalation. The convergence gate requires it to be strictly decreasing: a repair that fails to lower the open count — or raises it by inserting a producer that is itself uncomputable — is non-convergent and trips the gate immediately, without waiting for the cap.

This block lives in the ledger as a v1 expedient: the ledger is already the carried, cast-visible state the loop reads each iteration. Its better long-term home is the **draft itself** — a workflow-level annotation that travels with the artifact it bounds, so the budget survives even when the ledger is stripped at the terminal. Recorded here for now; migrate when the draft grows a home for it.

## Threaded through the whole design tier

The ledger is not loop-only. Every design-tier Mold in the source→Galaxy pipelines **consumes and re-emits** it — the interface, reference-data, data-flow, IWC-comparison, and template Molds (`*-summary-to-galaxy-interface`, `*-summary-to-galaxy-data-flow`, `*-summary-to-galaxy-reference-data`, `compare-against-iwc-exemplar`, `*-summary-to-galaxy-template`), alongside the change-set Molds on the update path. This is the direct answer to #281: the chain stops re-deriving the same unknowns because each Mold inherits them.

The template Mold's computability review pass is the notable appender ahead of the loop — `*-summary-to-galaxy-template` re-reads each settled step and, where an output needs evidence no input carries, wires the producer or records the gap as a blocking entry. Source-summary Molds upstream of the design tier keep their own free-text open-questions; the design tier is where those formalize into the ledger.

## Open work

- Decide whether the drops should be **counted**, not just labelled. `kind: dropped` and `units` make each cut legible one entry at a time; nothing totals them, so a run that drops a plane four times over still reports four reasonable-looking entries. A conservation rule — every source unit ends the run carried, subsumed, or surrendered, and the buckets sum to the source total — would make the aggregate visible the way `open_history` makes escalation visible. Deliberately not attempted here: labelling is cheap and may prove sufficient, counting needs a definition of "source unit" per source kind.
- Decide whether entry structure should harden further (typed `unmet` / `missing`, links back to source-summary evidence, machine-checkable `status` transitions) once two or three worked runs exercise it. Hardening it would also give the producing Molds an `output_artifacts[].schema` to cite, which none carry today.
- Assign terminal surrender of *non-blocking* entries. advance-galaxy-draft-step surrenders open blocking entries at the escalation cap, but an unpinned-parameter entry the design tier appended and nobody closed currently rides out the run without ever being marked `surrendered`. Nothing owns that pass today.
- Reconcile the design-tier briefs' free-text "open questions" sections with the ledger. Every design Mold still emits both, with no rule for which destination an unresolved choice belongs in.
- Decide whether the source-summary Molds should also emit structured entries, or keep their free-text open-questions until the design tier formalizes them.
- Specify how surrendered entries surface in the runnable gxformat2 (a workflow-level annotation, a report output, or a sidecar) when the draft is stripped of `_plan_*` and TODO sentinels.
- Move the `topology_repair` escalation budget out of the ledger and into the draft (a workflow-level annotation) so it travels with the artifact it bounds; the ledger home is a v1 expedient.
