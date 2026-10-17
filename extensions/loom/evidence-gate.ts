/**
 * Evidence gate for plan-step completion.
 *
 * Loom's system prompt says "Evidence comes before assertion -- you must run an
 * actual verification step before marking a notebook step complete", and
 * `docs/agent/galaxy-routing.md` is sharper still: "Treat invocation YAML
 * status as Galaxy job state. Treat the plan checkbox as verified-result
 * state." Nothing checked either one. Loom hard-gates what can hurt you
 * (exec-guard, write-jail, destructive deletes) and asked nicely for the thing
 * the product is actually for.
 *
 * ## Deny on contradiction, warn on absence
 *
 * The tempting design -- "block a checkbox flip that arrives without evidence"
 * -- is wrong here, and the codebase says so. `/execute` teaches
 * *evidence-first*: step 5 "Write the verification evidence into the notebook
 * before changing status", step 6 "Only after verification succeeds, edit the
 * markdown checkbox". So a flip-only edit is the **documented honest shape**,
 * and a gate keyed on "this edit added nothing" would fire on exactly the
 * behaviour Loom teaches. Absence of evidence is not decidable from one write:
 * Galaxy evidence lands in a `loom-invocation` block at end of file, prose
 * evidence may sit in a results section, and the honest sequence spans two
 * edits.
 *
 * What *is* decidable is **contradiction**: a claim in the notebook that a
 * record the model can't author disagrees with. There are two such records,
 * so there are two verdict paths.
 *
 * ## The registry path: steps with a recorded run
 *
 * When the approval registry (`registry.ts`) holds an attempt bound to the
 * step that has a submission -- a run the registry knows about -- the verdict
 * is the registry's. The step is held while none of its runs is
 * `handoff_eligible` (recomputed here, so a revocation held in memory counts)
 * and the user hasn't overridden any of them. The evaluation writer
 * (`registry-evaluator.ts`) sets that flag from Galaxy's own answers, and the
 * registry is signed by the session, so nothing in the notebook moves it.
 * Only checkbox states are read from the notebook, by anchor, anywhere in the
 * file:
 *
 * - a held step arriving at `- [x]` is denied, whatever its block's `status:`
 *   says (the old two-edit split);
 * - a held step whose checkbox disappears -- an anchor renamed, the line
 *   fenced, the box broken -- is denied, which is what stops a rename from
 *   carrying a completion past the check in one edit or two;
 * - a plan-heading rename doesn't hide a step, because anchored checkboxes are
 *   found outside `## Plan` sections too.
 *
 * Marking a held step `- [!]` is always allowed. An approval nothing has been
 * submitted for yet is not a run and leaves the step to the legacy path.
 *
 * ## The legacy path: runs the registry doesn't know
 *
 * Until `loom_submit` (registry slice 3) records gated submissions, that is
 * every raw submission. When a plan step flips to `- [x]` while the
 * `loom-invocation` block bound to it still reads `in_progress`, the agent is
 * claiming a verified result for a run Galaxy says has not finished. That
 * status is written by the poller, so it can't be satisfied by writing a
 * convincing sentence -- but it is notebook text, and so is the step's
 * identity, which leaves the three gaps listed below.
 *
 * Everything else is recorded, not blocked. A flip with no invocation binding
 * (a local step, say) gets no opinion at all: guessing there produces the false
 * positives that get gates switched off.
 *
 * ## Modes
 *
 * `off | warn | deny`, from `LOOM_EVIDENCE_GATE` or `evidenceGate.mode` in the
 * config, default `deny`. Every decision that involves a completion is
 * recorded to `activity.jsonl` as `evidence.decision`, with the
 * contradiction's source, so `scripts/evidence-gate-audit.mjs` can tabulate
 * what deny would have done; `docs/evidence-gate-audit.md` holds the audit
 * the default rests on.
 *
 * ## The exception is the user's, not the model's
 *
 * The first cut of this gate let the second attempt on a step through, which
 * made the decision advisory: a model that disagrees only has to ask twice. So
 * the deny persists for as long as the contradiction does, and the escape
 * hatch is `/override <step-key> <reason>` (`evidence-override-command.ts`) --
 * a person, a named step, a recorded reason. On the registry path it is
 * written into the registry as an evidence-gate exception on the runs it held
 * the step for; a later run on the step is held again. On the legacy path it
 * is a one-shot token for the run in flight. It is also the way out of the
 * pinned-`in_progress` case: credentials that vanish mid-session, or an
 * invocation that ends with nothing ok and nothing failed.
 *
 * ## What remains
 *
 * 1. **Legacy path, two-edit split.** Rewrite `status:` in one edit, flip the
 *    checkbox in the next: the pre-image already says `completed`.
 * 2. **Legacy path, anchor rename plus flip.** The post-image step key is not
 *    the pre-image's, so it does not read as a flip.
 * 3. **Legacy path, plan-heading rename plus flip.** The step stops parsing.
 *    All three have tests pinning them, and close for raw submissions only
 *    when slice 3 records them in the registry.
 * 4. **Bash.** `WRITE_TOOLS` is `write` and `edit`. On the desktop the
 *    exec-guard denies shell writes to `notebook.md`, `activity.jsonl` and the
 *    registry and provenance directories outright (a floor, not an ask), and
 *    never auto-allows a line that names them, so an interpreter one-liner
 *    asks the user. A script that finds the files itself still can, and is out
 *    of scope for a command-string classifier.
 * 5. **`activity.jsonl` through the file tools.** Not floored there: the
 *    activity log is an audit trail, not an input to any verdict, now that the
 *    verdict lives in the signed registry.
 * 6. **Positional anchors.** A step with no `{#id}` is addressed by position
 *    (`plan-a-step-2`), so inserting a step above it moves its address onto
 *    another line. On the registry path, different text at a held positional
 *    address is treated as that move and refused, which also means a held
 *    positional step can't be retitled until it's eligible; explicit anchors
 *    don't have the problem. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config";
import { getNotebookPath } from "./state";
import { recordStore } from "./record-store";
import { appendActivityEvent } from "./activity";
import { findInvocationBlocks, type InvocationYaml } from "./notebook-writer";
import { findJobBlocks, type JobYaml } from "./galaxy-job-block";
import { attemptOwns, readAttemptRecordSync } from "./galaxy-provenance";
import { collectCheckboxSteps } from "./notebook-anchors";
import { computeHandoffEligible, type Attempt, type Registry } from "./registry";
import { NO_APPROVAL_REVISION } from "./registry-evaluation";
import { getSessionRegistry, sessionView } from "./registry-runtime";
import { readEnv } from "../../shared/orbit-env.js";
import { applySectionEdit } from "../../shared/markdown-sections.js";
import { MCP_FAMILY, type GalaxyToolFamily } from "../../shared/galaxy-mcp-tools.js";

/** pi emits its built-in file tools lowercase; mirrors exec-guard's FILE_WRITE_TOOLS. */
const WRITE_TOOLS = new Set(["write", "edit"]);

export type EvidenceGateMode = "off" | "warn" | "deny";

export function resolveMode(): EvidenceGateMode {
  const env = readEnv("EVIDENCE_GATE")?.trim().toLowerCase();
  if (env === "off" || env === "warn" || env === "deny") return env;
  const cfg = loadConfig() as { evidenceGate?: { mode?: string } };
  const mode = cfg.evidenceGate?.mode?.trim().toLowerCase();
  if (mode === "off" || mode === "warn" || mode === "deny") return mode;
  return "deny";
}

/** `## Plan A: Title [routing]` -- same shape init-gate.ts parses. */
const PLAN_HEADING = /^##\s+Plan\s+([^:]+):\s*(.+?)(?:\s*\[(local|galaxy|hybrid|remote)\])?\s*$/i;
const ANY_H2 = /^##\s+/;
/** A plan step checkbox line: indent + open bracket, state char, close, rest. */
const STEP_LINE = /^(\s*-\s+\[)([ xX!])(\]\s+)(.*)$/;
const ANCHOR = /\{#([^}]+)\}/;

export interface PlanStep {
  /** Stable identity across edits: the anchor when present, else a normalized title. */
  key: string;
  anchor?: string;
  state: " " | "x" | "!";
  text: string;
}

/**
 * Normalize a step's text into a stable key. Strips the ordinal, bold wrapper,
 * anchor and punctuation so an edit that renumbers or retitles cosmetically
 * doesn't read as a different step.
 */
function normalizeTitle(raw: string): string {
  return raw
    .replace(ANCHOR, "")
    .replace(/^\d+\.\s*/, "")
    .replace(/\*\*([^*]+)\*\*/, "$1")
    .replace(/[—\-:|].*$/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Parse every checkbox line that sits inside a `## Plan X:` section.
 *
 * Scoped deliberately: a plain markdown to-do list elsewhere in the notebook is
 * not a plan step, and gating it would be a false positive on ordinary note
 * taking. Keyed rather than line-indexed, because inserting a line anywhere
 * above destroys line identity while leaving the step untouched.
 */
export function parsePlanSteps(content: string): Map<string, PlanStep> {
  const out = new Map<string, PlanStep>();
  let inPlan = false;
  let inFence = false;
  let planKey = "";
  for (const line of content.split("\n")) {
    // Fenced content is quoted, not asserted. A plan section that shows an
    // example checkbox in a ``` block was otherwise parsed as a real step, and
    // because the map is keyed by anchor and last-write-wins, an example
    // carrying the same anchor as a real step overwrote the real step's state
    // -- flip the step and paste a pending copy of it in a fence below, and the
    // completion vanished from the post-image. Also the honest reading: the
    // `loom-invocation` blocks are fenced too, and nothing in one is a plan
    // step.
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = line.match(PLAN_HEADING);
    if (heading) {
      inPlan = true;
      planKey = heading[1].trim().toLowerCase();
      continue;
    }
    if (ANY_H2.test(line)) {
      inPlan = false;
      continue;
    }
    if (!inPlan) continue;
    const m = line.match(STEP_LINE);
    if (!m) continue;
    const text = m[4];
    const anchor = text.match(ANCHOR)?.[1];
    const key = anchor ? `#${anchor}` : `${planKey}#${normalizeTitle(text)}`;
    const state = (m[2] === "X" ? "x" : m[2]) as PlanStep["state"];
    out.set(key, { key, anchor, state, text: text.trim() });
  }
  return out;
}

/**
 * Steps that arrived at `- [x]` from some other state between two versions of
 * the notebook.
 *
 * The claim being adjudicated is "this step is verified complete", so every way
 * of arriving at it counts: `- [ ]` -> `- [x]` and `- [!]` -> `- [x]` alike.
 * Keying only on the pending state, as the first cut did, left a two-edit
 * bypass that never has to touch the invocation block at all -- mark the step
 * failed, then mark it complete, and neither edit is a flip the gate can see.
 *
 * Gating the failed->complete transition costs nothing on the honest path.
 * Recovering from a failure means rerunning, and a rerun that finished leaves a
 * `completed` block for the anchor, which `findContradictions` already fails
 * open on. What is left is the flip made while the rerun is still in flight,
 * which is the contradiction this gate exists for.
 *
 * The reverse directions stay silent. `- [ ]` -> `- [!]` records a failure,
 * which is the honest behaviour the discipline asks for and must never be
 * gated, and `- [x]` -> `- [ ]` is reopening. A step that is `[x]` in the new
 * content with no counterpart in the old is not a flip either -- that rule is
 * what keeps a first write, or a wholesale plan regeneration, from reading as a
 * pile of unevidenced completions.
 */
export function detectCompletions(before: string, after: string): PlanStep[] {
  const pre = parsePlanSteps(before);
  const post = parsePlanSteps(after);
  const flips: PlanStep[] = [];
  for (const [key, step] of post) {
    if (step.state !== "x") continue;
    const prior = pre.get(key);
    if (prior && prior.state !== "x") flips.push(step);
  }
  return flips;
}

/** A flip the step's own `loom-invocation` block contradicts (the legacy path). */
export interface BlockContradiction {
  source: "block";
  step: PlanStep;
  invocation: InvocationYaml;
}

/**
 * A write the registry contradicts: the step has a recorded run, and the
 * record says that run is not eligible to hand off. `flip` is the step arriving
 * at `- [x]`; `vanished` is the write removing the step's checkbox altogether,
 * which is how a rename would otherwise carry the completion past the check.
 */
export interface RegistryContradiction {
  source: "registry";
  step: PlanStep;
  kind: "flip" | "vanished";
  hold: RegistryHold;
}

export type Contradiction = BlockContradiction | RegistryContradiction;

/**
 * Flips that contradict machine-owned state: the step's own `loom-invocation`
 * block still says the run is in progress.
 *
 * Three properties this depends on, all verified against the code rather than
 * assumed, because each one is a way to get this badly wrong:
 *
 * 1. **Read the PRE-image, never the post-image.** The block is ordinary
 *    plaintext in the same file, so an edit that flips the checkbox *and*
 *    rewrites `status: in_progress` to `completed` in one hunk would clear a
 *    post-image check by construction -- the sole deny path defeating itself in
 *    one call. The pre-image is what Galaxy's poller last wrote, before the
 *    edit under adjudication. (A two-edit split -- rewrite status, then flip --
 *    still evades this; see the module note on the out-of-band record.)
 *
 * 2. **`in_progress` only, never `failed`.** `failed` is a rolled-up
 *    any-job-errored verdict, it is sticky, and `checkInvocations` polls only
 *    `in_progress` blocks (`tools.ts:650`) so it can never be re-polled back
 *    out. Denying on it would block the legitimate flip after a successful
 *    rerun, with no remediation the agent could actually execute.
 *
 * 3. **Anchors are not unique.** `upsertInvocationBlock` keys on
 *    `invocation_id` (`notebook-writer.ts:283`), so a rerun leaves a second
 *    block with the same `notebook_anchor`. If ANY block for the anchor reads
 *    `completed`, the step is not contradicted -- the common retry shape is a
 *    stale `failed`/`in_progress` block beside the fresh `completed` one, and
 *    failing open there is the difference between a gate people keep and a
 *    gate people switch off.
 */
export function findContradictions(before: string, flips: PlanStep[]): BlockContradiction[] {
  const blocks = findInvocationBlocks(before);
  if (blocks.length === 0) return [];
  const byAnchor = new Map<string, InvocationYaml[]>();
  for (const b of blocks) {
    if (!b.notebookAnchor) continue;
    const list = byAnchor.get(b.notebookAnchor) ?? [];
    list.push(b);
    byAnchor.set(b.notebookAnchor, list);
  }
  const out: BlockContradiction[] = [];
  for (const step of flips) {
    if (!step.anchor) continue;
    const list = byAnchor.get(step.anchor);
    if (!list || list.length === 0) continue;
    if (list.some((b) => b.status === "completed")) continue; // a run for this step did finish
    const pending = list.find((b) => b.status === "in_progress");
    if (pending) out.push({ source: "block", step, invocation: pending });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The registry path
// ─────────────────────────────────────────────────────────────────────────────

/** A step the registry holds: it has a recorded run, and nothing lets it through. */
export interface RegistryHold {
  anchor: string;
  /** Attempts bound to the step that have a submission. */
  attemptIds: string[];
  /** What the record says is missing, for the reason and the activity row. */
  missing: string[];
}

/** The user's `/override`, recorded as an evidence-gate exception on the attempt. */
export function gateExcepted(attempt: Attempt, exceptions: Registry["exceptions"]): boolean {
  const revision = attempt.approval?.spec_revision ?? NO_APPROVAL_REVISION;
  return exceptions.some(
    (x) =>
      x.attempt_id === attempt.attempt_id &&
      x.by === "user" &&
      x.scope === "evidence_gate" &&
      x.assertion_id === undefined &&
      x.spec_revision === revision,
  );
}

function missingFacts(a: Attempt): string[] {
  const ev = a.evaluation;
  if (!ev) return ["not evaluated yet"];
  const out: string[] = [];
  if (ev.authority !== "established" || a.provenance?.authority !== "established") {
    out.push("not re-verified against Galaxy in this session");
  }
  if (ev.execution !== "success") out.push(`execution ${ev.execution}`);
  if (ev.conformity !== "conformant" && ev.conformity !== "excepted") {
    out.push(`conformity ${ev.conformity}`);
  }
  if (ev.predicate_result !== "pass" && ev.predicate_result !== "attested") {
    out.push(`predicate ${ev.predicate_result}`);
  }
  if (ev.integrity !== "ok") out.push(`integrity ${ev.integrity}`);
  return out.length > 0 ? out : ["the record's checks don't line up"];
}

/**
 * Which steps the registry has an opinion on, and which of those it holds.
 *
 * A step has an opinion when an attempt bound to it has a submission -- a run
 * the registry knows about. An approval nothing has been submitted for yet is
 * not a run, so it leaves the step to the legacy path. A step is held when
 * none of its runs is eligible and the user hasn't overridden any of them; one
 * eligible run is enough, the same fail-open the legacy path gives a step with
 * one completed block beside stale ones.
 *
 * `handoff_eligible` is recomputed here rather than read off the attempt, so a
 * revocation the session holds in memory (`sessionView`) counts at once.
 */
export function registryHolds(registry: Registry | null | undefined): {
  bound: Set<string>;
  held: Map<string, RegistryHold>;
} {
  const bound = new Set<string>();
  const held = new Map<string, RegistryHold>();
  if (!registry) return { bound, held };
  const byAnchor = new Map<string, Attempt[]>();
  for (const a of Object.values(registry.attempts)) {
    if (!a.submission || a.binding.step_anchor === "unattributed") continue;
    const list = byAnchor.get(a.binding.step_anchor) ?? [];
    list.push(a);
    byAnchor.set(a.binding.step_anchor, list);
  }
  for (const [anchor, attempts] of byAnchor) {
    bound.add(anchor);
    const through = attempts.some(
      (a) => computeHandoffEligible(a, registry.exceptions) || gateExcepted(a, registry.exceptions),
    );
    if (through) continue;
    held.set(anchor, {
      anchor,
      attemptIds: attempts.map((a) => a.attempt_id),
      missing: [...new Set(attempts.flatMap(missingFacts))],
    });
  }
  return { bound, held };
}

/** Checkbox states by anchor; a step written twice is complete if either copy says so. */
function checkboxesByAnchor(content: string): Map<string, PlanStep & { positional?: true }> {
  const out = new Map<string, PlanStep & { positional?: true }>();
  for (const box of collectCheckboxSteps(content)) {
    const prior = out.get(box.anchor);
    if (prior?.state === "x") continue;
    out.set(box.anchor, {
      key: `#${box.anchor}`,
      anchor: box.anchor,
      state: box.state,
      text: box.text,
      ...(box.explicit ? {} : { positional: true as const }),
    });
  }
  return out;
}

/** A step's text with the ordinal, the state and the spacing taken out. */
function stepIdentity(text: string): string {
  return text
    .replace(/^\d+\.\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Writes the registry contradicts. Reads only checkbox states from the
 * notebook -- the verdict is the registry's -- so rewriting a block's
 * `status:` first changes nothing (gap 1), and because steps are found by
 * anchor anywhere in the file, renaming the plan heading doesn't hide one
 * (gap 3). Removing a held step's checkbox is refused outright, which is what
 * keeps a rename from carrying a completion past the check in one edit or two
 * (gap 2): mark it `- [!]` instead, or ask for `/override`.
 */
export function findRegistryContradictions(
  before: string,
  after: string,
  registry: Registry | null | undefined,
  opts: { newStepsCount?: boolean } = {},
): RegistryContradiction[] {
  const newStepsCount = opts.newStepsCount ?? true;
  const { held } = registryHolds(registry);
  if (held.size === 0) return [];
  const pre = checkboxesByAnchor(before);
  const post = checkboxesByAnchor(after);
  const out: RegistryContradiction[] = [];
  for (const [anchor, hold] of held) {
    const was = pre.get(anchor);
    const now = post.get(anchor);
    // A step the notebook never had arriving complete counts for an edit (the
    // model wrote it). A pull or resume replacing the notebook wholesale --
    // a fresh container resuming its Page -- brings steps in whatever state
    // they were left, and judging those before reconcile has re-checked them
    // would refuse the honest resume.
    if (now?.state === "x" && was?.state !== "x" && (was || newStepsCount)) {
      out.push({ source: "registry", step: now, kind: "flip", hold });
    } else if (was && !now) {
      out.push({ source: "registry", step: was, kind: "vanished", hold });
    } else if (was?.positional && now && stepIdentity(was.text) !== stepIdentity(now.text)) {
      // A step with no `{#id}` is addressed by position, so a line inserted
      // above it moves its address onto another step -- and the original could
      // then be completed under an address nothing holds. Different text at a
      // held positional address is that move, and is refused like a removal.
      out.push({ source: "registry", step: was, kind: "vanished", hold });
    }
  }
  return out;
}

/** The registry as this session reads it, or null when there is none. */
export function currentRegistryView(): Registry | null {
  const session = getSessionRegistry();
  if (!session || session.unavailable) return null;
  return sessionView(session);
}

/**
 * Every plan step the gate would currently fire on, regardless of what its
 * checkbox says right now. The gate itself only adjudicates flips, but the
 * user asking "what is blocked, and under what key?" is asking about the
 * standing state -- and after a deny the step is still `- [ ]`, so keying the
 * answer off the checkbox would report nothing. Same predicate, applied to
 * every step in the file.
 */
export function outstandingContradictions(
  content: string,
  registry: Registry | null = null,
): Contradiction[] {
  const { bound, held } = registryHolds(registry);
  const steps = [...parsePlanSteps(content).values()].filter(
    (s) => !s.anchor || !bound.has(s.anchor),
  );
  const out: Contradiction[] = findContradictions(content, steps);
  const boxes = checkboxesByAnchor(content);
  for (const [anchor, hold] of held) {
    const step = boxes.get(anchor) ?? {
      key: `#${anchor}`,
      anchor,
      state: " " as const,
      text: anchor,
    };
    out.push({ source: "registry", step, kind: "flip", hold });
  }
  return out;
}

/**
 * Resolve a user-typed step key against the notebook. Accepts the gate's own
 * key (`#plan-a-step-2`), the bare anchor as it appears in the markdown
 * (`plan-a-step-2`), and either spelled with different case -- anchors are
 * copied out of the notebook by hand, and a gate whose override is hard to
 * address is a gate people work around.
 */
export function resolveStepKey(
  content: string,
  input: string,
  registry: Registry | null = null,
): PlanStep | null {
  const raw = input.trim();
  if (!raw) return null;
  // Plan steps first, then any anchored checkbox (a step whose heading was
  // renamed is still that step to the registry), then a step the registry holds
  // that the notebook no longer shows at all.
  const boxes = checkboxesByAnchor(content);
  const held = registryHolds(registry).held;
  const sources: Map<string, PlanStep>[] = [
    parsePlanSteps(content),
    boxes,
    new Map(
      [...held.keys()]
        .filter((a) => !boxes.has(a))
        .map((a) => [`#${a}`, { key: `#${a}`, anchor: a, state: " " as const, text: a }]),
    ),
  ];
  for (const steps of sources) {
    for (const candidate of [raw, `#${raw}`]) {
      const hit = steps.get(candidate);
      if (hit) return hit;
    }
    const lowered = raw.toLowerCase();
    for (const [key, step] of steps) {
      if (key.toLowerCase() === lowered || key.toLowerCase() === `#${lowered}`) return step;
    }
  }
  return null;
}

/**
 * Mirror of pi's fuzzy-match normalization (`core/tools/edit-diff.ts`,
 * `normalizeForFuzzyMatch`), reimplemented rather than imported because
 * reaching into pi's `dist/core/**` from here is exactly the deep-path
 * coupling that has broken loom on an upstream repackage before.
 *
 * It has to exist. pi's `edit` does not require `oldText` to match byte for
 * byte: it tries an exact `indexOf` first and then retries in this normalized
 * space, so an `oldText` whose em-dash arrived as a hyphen, or whose line lost
 * its trailing space, still lands on disk. A gate that only did the exact
 * match would silently abstain on those -- and models normalize punctuation
 * when echoing text back all the time, so that is a hole a model falls through
 * by accident as often as on purpose, under-counting the warn-mode audit as
 * well as letting a deny-mode flip past.
 */
function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

/** pi normalizes both the file and every edit to LF before matching. */
function toLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

interface Span {
  start: number;
  end: number;
  newText: string;
}

/**
 * Locate every edit the way pi does, or null if pi would refuse the call.
 *
 * Three things here are pi's behaviour rather than the obvious behaviour, and
 * each of them was a way past the gate when this simulated the obvious one:
 *
 * 1. **Every edit matches against the ORIGINAL file, not against the running
 *    result.** pi resolves all matches up front and only then applies them.
 *    Folding them in sequence let one edit manufacture the text a later edit
 *    matched: insert a `[ ]` into a prose line, then "flip" that, and the
 *    simulator saw a checkbox appear in prose while pi -- matching the second
 *    edit against the original -- flipped the real plan step.
 * 2. **A non-unique `oldText` is refused outright** (`getDuplicateError`), and
 *    so is an overlapping pair. Abstaining on those is not a gap: the call
 *    errors and nothing reaches the disk.
 * 3. **Line endings are normalized to LF first.** A `newText` ending `\r\n`
 *    left a stray CR in the simulated line, which `STEP_LINE` then failed to
 *    parse, so the completion disappeared from the post-image while pi wrote
 *    it happily.
 */
function locateEdits(
  content: string,
  edits: { oldText: string; newText: string }[],
): Span[] | null {
  const spans: Span[] = [];
  for (const edit of edits) {
    const oldText = toLF(edit.oldText);
    const newText = toLF(edit.newText);
    if (oldText.length === 0) return null; // pi throws on an empty oldText
    const first = content.indexOf(oldText);
    if (first === -1) return null; // caller retries in pi's fuzzy space
    if (content.indexOf(oldText, first + 1) !== -1) return null; // pi: duplicate, refused
    spans.push({ start: first, end: first + oldText.length, newText });
  }
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i - 1].end > ordered[i].start) return null; // pi: overlapping, refused
  }
  return ordered;
}

/** Apply located spans right to left so earlier offsets stay valid. */
function applySpans(content: string, spans: Span[]): string {
  let out = content;
  for (let i = spans.length - 1; i >= 0; i--) {
    out = out.slice(0, spans[i].start) + spans[i].newText + out.slice(spans[i].end);
  }
  return out;
}

/**
 * Reconstruct what the file will contain after this call, or null when we
 * can't tell. Null always means "no opinion" -- an unreadable file or an edit
 * pi itself would not land is not ours to adjudicate, and guessing would
 * manufacture exactly the false positives that get gates disabled.
 */
export function computeAfterContent(
  before: string,
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (toolName === "write") {
    return typeof input.content === "string" ? input.content : null;
  }
  if (toolName === "update_page") return pageAfterContent(before, input);
  if (toolName !== "edit") return null;
  const raw = input.edits;
  if (!Array.isArray(raw)) return null;
  const edits: { oldText: string; newText: string }[] = [];
  for (const entry of raw) {
    const e = entry as { oldText?: unknown; newText?: unknown };
    if (typeof e.oldText !== "string" || typeof e.newText !== "string") return null;
    edits.push({ oldText: e.oldText, newText: e.newText });
  }
  if (edits.length === 0) return null;

  const content = toLF(before);
  const exact = locateEdits(content, edits);
  if (exact) return applySpans(content, exact);

  // Nothing matched exactly, so pi is in its fuzzy pass, where it rewrites the
  // whole file in normalized space. Simulate on the same footing.
  const fuzzyContent = normalizeForMatch(content);
  const fuzzyEdits = edits.map((e) => ({
    oldText: normalizeForMatch(toLF(e.oldText)),
    newText: toLF(e.newText),
  }));
  const fuzzy = locateEdits(fuzzyContent, fuzzyEdits);
  if (!fuzzy) return null;
  return applySpans(fuzzyContent, fuzzy);
}

/**
 * The record page after an update_page call, as the page bridge would write it: whole content,
 * or one section rewritten. A title-only call, or a combination the bridge refuses, writes no
 * body we can judge.
 */
function pageAfterContent(before: string, input: Record<string, unknown>): string | null {
  const { content, section_heading: heading, section_content: section } = input;
  const sectioned = heading != null || section != null;
  if (typeof content === "string") return sectioned ? null : content;
  if (typeof heading === "string" && typeof section === "string") {
    return applySectionEdit(before, heading, section);
  }
  return null;
}

export function contradictionReason(c: Contradiction): string {
  if (c.source === "registry") return registryReason(c);
  return (
    `Marking "${c.step.text}" complete contradicts its own Galaxy invocation ` +
    `block, which reads \`status: ${c.invocation.status}\`. That status is written ` +
    `by Loom's poller from Galaxy job state, not by you. A \`- [x]\` means the ` +
    `result was verified, so it cannot precede the run succeeding.\n` +
    `If the run is still going, leave the step pending. If it failed, mark it ` +
    `\`- [!]\` and record what failed. If Galaxy has actually finished and the ` +
    `block is stale, call \`galaxy_invocation_check_all\` to refresh it, inspect ` +
    `the outputs, record that evidence, and then flip the checkbox.\n` +
    `Do not retry this write unchanged -- it will be refused again. If the run ` +
    `was abandoned and the work was done another way, that block is the thing ` +
    `to reconcile first: it still says a run for this step is in flight. If you ` +
    `believe the gate is wrong, say so and ask the user to run ` +
    `\`/override ${c.step.anchor ?? c.step.key} <reason>\`; only they can clear it, ` +
    `and the reason is recorded.`
  );
}

function registryReason(c: RegistryContradiction): string {
  const address = c.step.anchor ?? c.step.key;
  const record =
    `The approval registry holds a recorded run for this step that is not eligible to ` +
    `hand off (${c.hold.missing.join("; ")}). Loom writes that record from Galaxy's own ` +
    `answers; nothing in the notebook changes it.`;
  const head =
    c.kind === "flip"
      ? `Marking "${c.step.text}" complete contradicts the registry. ${record}`
      : `This edit removes the step "${c.step.text}" ({#${address}}) from the notebook while ` +
        `its recorded run isn't eligible. ${record} A step with a recorded run can't be ` +
        `renamed or removed until it is; if the step failed or was abandoned, mark it ` +
        `\`- [!]\` and say why instead.`;
  return (
    `${head}\n` +
    `If the run is still going, leave the step pending. If it failed, mark it \`- [!]\` and ` +
    `record what failed. If Galaxy has finished, the next poll or \`/reconcile\` re-checks ` +
    `it against Galaxy; inspect the outputs and record that evidence meanwhile.\n` +
    `Do not retry this write unchanged -- it will be refused again. If you believe the ` +
    `record is wrong, say so and ask the user to run \`/override ${address} <reason>\`; only ` +
    `they can clear it, and it is recorded in the registry.`
  );
}

/** The reason shown to the agent for the contradictions actually blocking it. */
export function renderBlockReason(contradictions: Contradiction[]): string {
  return contradictions.map(contradictionReason).join("\n\n");
}

export interface GateDecision {
  gated: boolean;
  mode: EvidenceGateMode;
  completions: PlanStep[];
  contradictions: Contradiction[];
  reason?: string;
}

/** Pure decision for one notebook write. Exported for tests. */
export function decideNotebookWrite(
  before: string,
  toolName: string,
  input: Record<string, unknown>,
  mode: EvidenceGateMode,
  registry: Registry | null = null,
): GateDecision {
  const none: GateDecision = { gated: false, mode, completions: [], contradictions: [] };
  if (mode === "off") return none;
  const after = computeAfterContent(before, toolName, input);
  if (after === null) return none;
  return decideTransition(before, after, mode, registry);
}

/**
 * The decision for a notebook going from `before` to `after`, whatever wrote
 * it: a file tool, or a Page pull replacing the body.
 */
export function decideTransition(
  before: string,
  after: string,
  mode: EvidenceGateMode,
  registry: Registry | null = null,
  opts: { newStepsCount?: boolean } = {},
): GateDecision {
  const none: GateDecision = { gated: false, mode, completions: [], contradictions: [] };
  if (mode === "off") return none;
  const { bound } = registryHolds(registry);
  const fromRegistry = findRegistryContradictions(before, after, registry, opts);
  // A step the registry has an opinion on is the registry's to judge; the
  // block text beside it is not consulted.
  const flips = detectCompletions(before, after);
  const completions = [...flips];
  for (const c of fromRegistry) {
    if (!completions.some((s) => s.key === c.step.key)) completions.push(c.step);
  }
  if (completions.length === 0) return none;
  // Pre-image, deliberately: see findContradictions.
  const contradictions: Contradiction[] = [
    ...fromRegistry,
    ...findContradictions(
      before,
      flips.filter((s) => !s.anchor || !bound.has(s.anchor)),
    ),
  ];
  if (contradictions.length === 0) return { ...none, completions };
  return {
    gated: mode === "deny",
    mode,
    completions,
    contradictions,
    reason: renderBlockReason(contradictions),
  };
}

export interface EnrichmentWarning {
  step: string;
  blockKind: "invocation" | "job";
  id: string;
  attemptId?: string;
  reasons: string[];
}

/**
 * Flips whose evidence run is not fully on the record yet: its enrichment is
 * not `complete`, a job has no tool version, or the block says complete and
 * the provenance file behind it is missing.
 *
 * Warn only, in every mode. The rate is the thing to learn before this can
 * deny -- a built-in tool never has a version to give, a details fetch fails
 * for reasons nobody can fix from a notebook -- and a gate that blocks a
 * verified result over a metadata gap is the gate people switch off.
 *
 * Read from the pre-image, as `findContradictions` is. The provenance check is
 * the one part the agent cannot write its way past: `enrichment: complete` is
 * text in a block it can edit, the attempt file is not.
 *
 * Only completed runs are judged when the step has one: an old failed attempt
 * whose details never came is not the evidence the flip rests on.
 */
export function findEnrichmentWarnings(
  before: string,
  flips: PlanStep[],
  analysisDir: string,
): EnrichmentWarning[] {
  const blocks: ({ kind: "invocation"; b: InvocationYaml } | { kind: "job"; b: JobYaml })[] = [
    ...findInvocationBlocks(before).map((b) => ({ kind: "invocation" as const, b })),
    ...findJobBlocks(before).map((b) => ({ kind: "job" as const, b })),
  ];
  const out: EnrichmentWarning[] = [];
  for (const step of flips) {
    if (!step.anchor) continue;
    const bound = blocks.filter((x) => x.b.notebookAnchor === step.anchor);
    if (bound.length === 0) continue;
    const completed = bound.filter((x) => x.b.status === "completed");
    for (const x of completed.length > 0 ? completed : bound) {
      const id = x.kind === "invocation" ? x.b.invocationId : x.b.jobId;
      const reasons: string[] = [];
      if (x.b.enrichment !== "complete") reasons.push(`enrichment_${x.b.enrichment ?? "absent"}`);
      // The block's word is notebook text; the protected record is what the
      // check rests on whenever the block claims to be complete.
      const record = x.b.attemptId ? readAttemptRecordSync(analysisDir, x.b.attemptId) : null;
      const owned = record && attemptOwns(record, x.kind, id) ? record : null;
      const recordJobs = owned
        ? x.kind === "job"
          ? [owned.jobs[id]].filter(Boolean)
          : Object.values(owned.jobs)
        : [];
      if (x.b.enrichment === "complete") {
        if (!owned) reasons.push("provenance_missing");
        else {
          // Made from notebook text, or from fixture answers: neither is a
          // server's word about this run.
          if (owned.origin === "notebook" || owned.fixture) reasons.push("provenance_untrusted");
          const incomplete =
            recordJobs.length === 0 ||
            recordJobs.some((j) => j.unavailable) ||
            (x.kind === "invocation" && owned.enrichment.state !== "complete");
          if (incomplete) reasons.push("provenance_incomplete");
        }
      }
      const versionMissing = owned
        ? recordJobs.length === 0 || recordJobs.some((j) => j.tool_version === "unknown")
        : x.kind === "job"
          ? !(x.b.jobs ?? []).some((j) => j.jobId === id && j.toolVersion)
          : !x.b.jobs || x.b.jobs.length === 0 || x.b.jobs.some((j) => !j.toolVersion);
      if (versionMissing) reasons.push("tool_version_missing");
      if (reasons.length > 0) {
        out.push({
          step: step.key,
          blockKind: x.kind,
          id,
          ...(x.b.attemptId ? { attemptId: x.b.attemptId } : {}),
          reasons,
        });
      }
    }
  }
  return out;
}

/**
 * Session-scoped, user-granted clearances, keyed by plan-step key.
 *
 * Deliberately not a "the model asked twice" escape. The gate used to keep a
 * `denied` set and let the second attempt through on the theory that an
 * unwinnable retry loop is worse than an unevidenced claim; that made the
 * decision advisory, because a model that disagrees only has to ask again. A
 * repeated model request is not an exception. An exception is a person saying
 * so, with a reason, on one named step -- which is what `/override` grants and
 * what lands in `activity.jsonl` as `evidence.override`.
 *
 * One token per step *and invocation*, consumed by the first write it actually
 * clears. Keying on the step alone let a clearance outlive the thing it was
 * granted for: override while run one is in flight, watch the poller fail it,
 * submit run two for the same anchor, and the stale token cleared a
 * contradiction the user never saw. The user approved a specific run being
 * ahead of its checkbox, not the step forever. A contradiction that recurs on
 * the step, from a different invocation or after the step is reopened, is
 * denied again.
 *
 * Module-level, and cleared on `session_start`, which is the same one-session-
 * per-process assumption `state.ts` already makes -- the notebook path itself
 * is a module-level singleton reset in that same hook, so two concurrent
 * sessions in one brain process is not a shape that exists. It does mean a
 * clearance does not survive a restart: granting one in the CLI and resuming
 * in Orbit means granting it again. Deliberate while the token is one-shot; a
 * clearance that outlives the process is a durable record, and durable records
 * are the registry's job.
 */
const overrides = new Set<string>();

/** The clearance is for this run of this step, not for the step in general. */
export function overrideToken(stepKey: string, invocationId: string): string {
  return `${stepKey}\u0000${invocationId}`;
}

/** Grant one clearance for `stepKey` while `invocationId` is the run in flight. */
export function grantEvidenceOverride(stepKey: string, invocationId: string): void {
  overrides.add(overrideToken(stepKey, invocationId));
}

/** The standing clearances, for a write path the tool_call hook doesn't see (a Page pull). */
export function evidenceOverrides(): ReadonlySet<string> {
  return overrides;
}

/** Spend the tokens a write actually used -- only when it went through. */
export function spendClearances(adjudication: GateAdjudication): void {
  if (adjudication.block) return;
  for (const c of adjudication.cleared) {
    if (c.source === "block")
      overrides.delete(overrideToken(c.step.key, c.invocation.invocationId));
  }
}

/** Session boundary / test reset. */
export function resetEvidenceOverrides(): void {
  overrides.clear();
}

export type GateOutcome = "recorded" | "warned" | "overridden" | "blocked";

export interface GateAdjudication {
  decision: GateDecision;
  /** Contradictions a standing user override would clear on this write. */
  cleared: Contradiction[];
  /** Contradictions with no override behind them. */
  unresolved: Contradiction[];
  block: boolean;
  outcome: GateOutcome;
}

export interface EvidenceDecisionInfo {
  outcome: GateOutcome;
  toolName: string;
  /** Plan-step keys the decision was about. */
  steps: string[];
  mode: EvidenceGateMode;
}

export type EvidenceDecisionListener = (info: EvidenceDecisionInfo) => void;

// The gate already records every decision to activity.jsonl; this is the
// in-process twin of that row, so another subsystem can react to a block
// without re-deriving an adjudication that depends on this module's private
// override set. Listeners are registered once at startup and are not cleared
// at a session boundary -- the override set is session state, a subscription
// is not.
const decisionListeners = new Set<EvidenceDecisionListener>();

export function onEvidenceDecision(listener: EvidenceDecisionListener): () => void {
  decisionListeners.add(listener);
  return () => {
    decisionListeners.delete(listener);
  };
}

/** Exported for tests; the hook below is the only production caller. */
export function notifyEvidenceDecision(info: EvidenceDecisionInfo): void {
  for (const listener of decisionListeners) {
    try {
      listener(info);
    } catch (err) {
      // Isolate subscribers: a throwing listener must never turn the gate's
      // decision into an exception out of the tool_call hook.
      console.error("evidence decision listener failed:", err);
    }
  }
}

/**
 * The full decision for one write, overrides included. Split out from the hook
 * so the interesting half is testable without a session: the hook's only job
 * on top of this is to consume the tokens, log, and return the block.
 *
 * Tokens are only spent when the write actually proceeds. A write carrying
 * contradictions on two steps where only one is overridden is still blocked,
 * and burning the granted token there would make the user grant it twice for
 * one flip. In `warn` the decision was never going to block, so nothing is
 * spent and nothing about the recorded outcome changes.
 */
export function adjudicateNotebookWrite(
  before: string,
  toolName: string,
  input: Record<string, unknown>,
  mode: EvidenceGateMode,
  granted: ReadonlySet<string>,
  registry: Registry | null = null,
): GateAdjudication {
  return adjudicate(decideNotebookWrite(before, toolName, input, mode, registry), granted);
}

/**
 * Apply the user's standing clearances to a decision. A block contradiction is
 * cleared by its one-shot token; a registry contradiction only by the
 * evidence-gate exception `/override` writes into the registry, which the
 * decision has already taken into account.
 */
export function adjudicate(decision: GateDecision, granted: ReadonlySet<string>): GateAdjudication {
  const cleared = decision.gated
    ? decision.contradictions.filter(
        (c) =>
          c.source === "block" && granted.has(overrideToken(c.step.key, c.invocation.invocationId)),
      )
    : [];
  const unresolved = decision.contradictions.filter((c) => !cleared.includes(c));
  const block = decision.gated && unresolved.length > 0;
  const outcome: GateOutcome = block
    ? "blocked"
    : cleared.length > 0
      ? "overridden"
      : decision.contradictions.length > 0
        ? "warned"
        : "recorded";
  return { decision, cleared, unresolved, block, outcome };
}

function sameFile(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/** Unicode spaces pi folds to a plain space before resolving (utils/paths.ts). */
const UNICODE_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Does this tool argument name the notebook, once pi is done with it?
 *
 * `path.resolve` is not what pi does. `resolveToCwd` runs the argument through
 * `normalizePath` with `stripAtPrefix` and `normalizeUnicodeSpaces` on and
 * tilde expansion defaulted on, so `@notebook.md`, `~/work/x/notebook.md` and
 * a path carrying a non-breaking space all land on the real file while a
 * literal `path.resolve` sends them somewhere else entirely -- and the gate
 * that resolved them literally would abstain on a write pi was about to make.
 *
 * Every plausible spelling is tested rather than one canonical form, because
 * the question here is only "is this call about the notebook". Over-including
 * costs an adjudication of a write that was never going to touch it; under-
 * including is a silent bypass.
 */
function resolvesToNotebook(raw: string, cwd: string, nbPath: string): boolean {
  const candidates = new Set<string>();
  const add = (value: string) => {
    if (!value) return;
    candidates.add(value);
    if (value.startsWith("@")) candidates.add(value.slice(1));
  };
  add(raw);
  add(raw.replace(UNICODE_SPACES, " "));
  for (const candidate of [...candidates]) {
    if (candidate === "~") candidates.add(os.homedir());
    else if (candidate.startsWith("~/"))
      candidates.add(path.join(os.homedir(), candidate.slice(2)));
  }
  for (const candidate of candidates) {
    const abs = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
    if (sameFile(abs, nbPath)) return true;
  }
  return false;
}

/** One `evidence.decision` row: what was claimed, what contradicted it, and the outcome. */
export function recordDecision(
  analysisDir: string,
  toolName: string,
  adjudication: GateAdjudication,
): void {
  const { decision } = adjudication;
  appendActivityEvent(analysisDir, {
    timestamp: new Date().toISOString(),
    kind: "evidence.decision",
    source: "evidence-gate",
    payload: {
      mode: decision.mode,
      toolName,
      completions: decision.completions.map((s) => s.key),
      contradictions: decision.contradictions.map((c) =>
        c.source === "block"
          ? {
              source: "block",
              step: c.step.key,
              status: c.invocation.status,
              // The id is what makes a row adjudicable: warn mode records the
              // would-block decision, and deciding later whether it was a false
              // positive means going and looking at this invocation in Galaxy.
              invocationId: c.invocation.invocationId,
            }
          : {
              source: "registry",
              step: c.step.key,
              kind: c.kind,
              attempts: c.hold.attemptIds,
              missing: c.hold.missing,
            },
      ),
      overridden: adjudication.block ? [] : adjudication.cleared.map((c) => c.step.key),
      outcome: adjudication.outcome,
    },
  });
}

export function registerEvidenceGate(
  pi: ExtensionAPI,
  family: GalaxyToolFamily = MCP_FAMILY,
): void {
  // A clearance the user granted and the gate never spent must not outlive the
  // session it was granted in. Registered here rather than in
  // session-lifecycle.ts so the gate owns the whole lifetime of its own state.
  pi.on("session_start", async () => {
    resetEvidenceOverrides();
  });

  pi.on("tool_call", async (event, ctx) => {
    const mode = resolveMode();
    if (mode === "off") return;
    // Under a page record the model completes steps by editing the page, not a file.
    const pageWrite = family.toolName(event.toolName) === "update_page";
    if (!WRITE_TOOLS.has(event.toolName) && !pageWrite) return;

    const nbPath = getNotebookPath();
    if (!nbPath) return;
    const input = event.input as Record<string, unknown>;
    let adjudicateAs = event.toolName;
    if (pageWrite) {
      const store = recordStore(nbPath);
      if (store.kind !== "page" || store.pageId === undefined || store.pageId !== input.page_id) {
        return;
      }
      adjudicateAs = "update_page";
    } else {
      // `file_path` is read as well as `path`, defensively. In the pinned pi it
      // is not actually an execution alias: `editSchema`/`writeSchema` require
      // `path`, `validateToolArguments` throws when it is missing, and both
      // `execute` bodies destructure `path`, so a call naming only `file_path`
      // never reaches the filesystem. Only pi's *render* helpers read the alias
      // (`getRenderablePreviewInput`, `formatEditCall`). Kept because it costs
      // one ternary and covers pi adding the alias, or another shell forwarding
      // a tool call in that shape. (exec-guard/policy.ts reads only `path` too;
      // tracked separately as P0.3.)
      // Adjudicate if ANY spelling of the target names the notebook, rather than
      // picking one and trusting the precedence to match pi's. Precedence is a
      // thing to get wrong later; "does this call mention the notebook at all"
      // is not. A call naming some other file under the other key is adversarial
      // or malformed, and pi refuses it, so there is no honest write to misjudge.
      const targets = [input.path, input.file_path].filter(
        (t): t is string => typeof t === "string" && t.length > 0,
      );
      const touchesNotebook = targets.some((t) => resolvesToNotebook(t, ctx.cwd, nbPath));
      if (!touchesNotebook) return;
    }

    const registry = currentRegistryView();
    let before: string;
    try {
      before = (await recordStore(nbPath).read()).content;
    } catch {
      // No notebook on disk yet. Nothing to compare against -- unless the
      // registry holds a step, in which case a notebook written from scratch
      // with that step complete is still a completion.
      if (registryHolds(registry).held.size === 0) return;
      before = "";
    }

    const adjudication = adjudicateNotebookWrite(
      before,
      adjudicateAs,
      input,
      mode,
      overrides,
      registry,
    );
    const { decision } = adjudication;
    if (decision.completions.length === 0) return;

    spendClearances(adjudication);

    recordDecision(path.dirname(nbPath), event.toolName, adjudication);

    const warnings = findEnrichmentWarnings(before, decision.completions, path.dirname(nbPath));
    if (warnings.length > 0) {
      appendActivityEvent(path.dirname(nbPath), {
        timestamp: new Date().toISOString(),
        kind: "evidence.enrichment_warning",
        source: "evidence-gate",
        payload: {
          mode: decision.mode,
          toolName: event.toolName,
          decision: "warn",
          warnings: warnings.map((w) => ({
            step: w.step,
            block_kind: w.blockKind,
            id: w.id,
            attempt_id: w.attemptId ?? null,
            reasons: w.reasons,
          })),
        },
      });
    }

    notifyEvidenceDecision({
      outcome: adjudication.outcome,
      toolName: event.toolName,
      steps: decision.completions.map((s) => s.key),
      mode: decision.mode,
    });

    if (!adjudication.block) return;
    return { block: true, reason: renderBlockReason(adjudication.unresolved) };
  });
}
