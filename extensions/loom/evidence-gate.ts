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
 * What *is* decidable is **contradiction** -- two claims in the same file that
 * disagree, where one of them is machine-owned. When a plan step flips to
 * `- [x]` while the `loom-invocation` block bound to that step still reads
 * `in_progress` or `failed`, the agent is claiming a verified result for a run
 * Galaxy says has not succeeded. That status is written by the poller
 * (`galaxy-poller.ts` / `checkInvocations`), not by the model, so the check
 * cannot be satisfied by writing a convincing sentence -- which is the failure
 * mode that makes an evidence gate theater.
 *
 * Everything else is recorded, not blocked. A flip with no invocation binding
 * (a local step, say) gets no opinion at all: guessing there produces the false
 * positives that get gates switched off.
 *
 * ## Modes
 *
 * Default is `warn`: allow, record to `activity.jsonl`, so the real-world rate
 * can be measured before anyone makes this a hard failure. `deny` exists but is
 * **not validated** and must not become the default until that data exists --
 * adversarial review found one residual case where a deny would be
 * unactionable: an invocation can be pinned at `in_progress` forever, because
 * the `completed` transition requires `summary.ok > 0` and the poller
 * early-returns when Galaxy credentials disappear mid-session. There is no
 * agent action that clears that, and a gate whose remediation cannot be
 * executed is the gate people switch off.
 *
 * ## The exception is the user's, not the model's
 *
 * The first cut of this gate kept a `denied` set and let the second attempt on
 * a step through, reasoning that an unwinnable retry loop is worse than an
 * unevidenced claim. That is true of a loop and false of this: it made the
 * decision advisory, since a model that disagrees only has to ask twice. So the
 * deny now persists for as long as the contradiction does, and the escape hatch
 * is `/override <step-key> <reason>` (`evidence-override-command.ts`) -- a
 * person, a named step, a recorded reason, one write. A contradiction that
 * recurs on the same step is denied again.
 *
 * ## Known gaps, recorded rather than papered over
 *
 * All of these share one root: step identity and the poller's status both live
 * in text the model is allowed to rewrite. They close together, when the
 * poller's verdict is held out of band in a record the model cannot author --
 * the approval/attempt registry, not here. Each has a test pinning current
 * behaviour so it stays visible rather than forgotten.
 *
 * 1. **The two-edit split.** Rewrite `status:` in one edit, flip the checkbox
 *    in the next. The pre-image of the second edit already says `completed`.
 * 2. **Anchor rename plus flip, in one edit.** The post-image step key is no
 *    longer the pre-image's, so it does not read as a flip at all.
 * 3. **Plan-heading rename plus flip, in one edit.** The step leaves the
 *    `## Plan X:` section and stops parsing as a plan step.
 * 4. **Anything that is not a file tool.** `WRITE_TOOLS` is `write` and `edit`;
 *    a `bash` heredoc or `sed -i` against `notebook.md` never reaches this
 *    hook. Same class as the `.loom/` bash hole tracked separately; the right
 *    home for it is the exec-guard's write policy, not a second gate here.
 * 5. **`activity.jsonl` is writable by the model.** The audit trail this gate
 *    appends to is an ordinary file in the workspace, so a sufficiently
 *    motivated model can forge an `evidence.override` row or rewrite a past
 *    decision. Also an exec-guard deny-floor question rather than one this
 *    module can answer, and the reason the durable record has to be the
 *    registry rather than the sidecar.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config";
import { getNotebookPath } from "./state";
import { appendActivityEvent } from "./activity";
import { findInvocationBlocks, type InvocationYaml } from "./notebook-writer";

/** pi emits its built-in file tools lowercase; mirrors exec-guard's FILE_WRITE_TOOLS. */
const WRITE_TOOLS = new Set(["write", "edit"]);

export type EvidenceGateMode = "off" | "warn" | "deny";

export function resolveMode(): EvidenceGateMode {
  const env = process.env.LOOM_EVIDENCE_GATE?.trim().toLowerCase();
  if (env === "off" || env === "warn" || env === "deny") return env;
  const cfg = loadConfig() as { evidenceGate?: { mode?: string } };
  const mode = cfg.evidenceGate?.mode?.trim().toLowerCase();
  if (mode === "off" || mode === "warn" || mode === "deny") return mode;
  return "warn";
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

export interface Contradiction {
  step: PlanStep;
  invocation: InvocationYaml;
}

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
export function findContradictions(before: string, flips: PlanStep[]): Contradiction[] {
  const blocks = findInvocationBlocks(before);
  if (blocks.length === 0) return [];
  const byAnchor = new Map<string, InvocationYaml[]>();
  for (const b of blocks) {
    if (!b.notebookAnchor) continue;
    const list = byAnchor.get(b.notebookAnchor) ?? [];
    list.push(b);
    byAnchor.set(b.notebookAnchor, list);
  }
  const out: Contradiction[] = [];
  for (const step of flips) {
    if (!step.anchor) continue;
    const list = byAnchor.get(step.anchor);
    if (!list || list.length === 0) continue;
    if (list.some((b) => b.status === "completed")) continue; // a run for this step did finish
    const pending = list.find((b) => b.status === "in_progress");
    if (pending) out.push({ step, invocation: pending });
  }
  return out;
}

/**
 * Every plan step the gate would currently fire on, regardless of what its
 * checkbox says right now. The gate itself only adjudicates flips, but the
 * user asking "what is blocked, and under what key?" is asking about the
 * standing state -- and after a deny the step is still `- [ ]`, so keying the
 * answer off the checkbox would report nothing. Same predicate, applied to
 * every step in the file.
 */
export function outstandingContradictions(content: string): Contradiction[] {
  return findContradictions(content, [...parsePlanSteps(content).values()]);
}

/**
 * Resolve a user-typed step key against the notebook. Accepts the gate's own
 * key (`#plan-a-step-2`), the bare anchor as it appears in the markdown
 * (`plan-a-step-2`), and either spelled with different case -- anchors are
 * copied out of the notebook by hand, and a gate whose override is hard to
 * address is a gate people work around.
 */
export function resolveStepKey(content: string, input: string): PlanStep | null {
  const steps = parsePlanSteps(content);
  const raw = input.trim();
  if (!raw) return null;
  for (const candidate of [raw, `#${raw}`]) {
    const hit = steps.get(candidate);
    if (hit) return hit;
  }
  const lowered = raw.toLowerCase();
  for (const [key, step] of steps) {
    if (key.toLowerCase() === lowered || key.toLowerCase() === `#${lowered}`) return step;
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

export function contradictionReason(c: Contradiction): string {
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
): GateDecision {
  const none: GateDecision = { gated: false, mode, completions: [], contradictions: [] };
  if (mode === "off") return none;
  const after = computeAfterContent(before, toolName, input);
  if (after === null) return none;
  const completions = detectCompletions(before, after);
  if (completions.length === 0) return none;
  // Pre-image, deliberately: see findContradictions.
  const contradictions = findContradictions(before, completions);
  if (contradictions.length === 0) return { ...none, completions };
  return {
    gated: mode === "deny",
    mode,
    completions,
    contradictions,
    reason: renderBlockReason(contradictions),
  };
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
): GateAdjudication {
  const decision = decideNotebookWrite(before, toolName, input, mode);
  const cleared = decision.gated
    ? decision.contradictions.filter((c) =>
        granted.has(overrideToken(c.step.key, c.invocation.invocationId)),
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

export function registerEvidenceGate(pi: ExtensionAPI): void {
  // A clearance the user granted and the gate never spent must not outlive the
  // session it was granted in. Registered here rather than in
  // session-lifecycle.ts so the gate owns the whole lifetime of its own state.
  pi.on("session_start", async () => {
    resetEvidenceOverrides();
  });

  pi.on("tool_call", async (event, ctx) => {
    const mode = resolveMode();
    if (mode === "off") return;
    if (!WRITE_TOOLS.has(event.toolName)) return;

    const nbPath = getNotebookPath();
    if (!nbPath) return;
    const input = event.input as Record<string, unknown>;
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

    let before: string;
    try {
      before = fs.readFileSync(nbPath, "utf-8");
    } catch {
      return; // no notebook on disk yet -- nothing to compare against
    }

    const adjudication = adjudicateNotebookWrite(before, event.toolName, input, mode, overrides);
    const { decision } = adjudication;
    if (decision.completions.length === 0) return;

    // Spend the tokens only on the write they actually let through.
    if (!adjudication.block) {
      for (const c of adjudication.cleared) {
        overrides.delete(overrideToken(c.step.key, c.invocation.invocationId));
      }
    }

    appendActivityEvent(path.dirname(nbPath), {
      timestamp: new Date().toISOString(),
      kind: "evidence.decision",
      source: "evidence-gate",
      payload: {
        mode: decision.mode,
        toolName: event.toolName,
        completions: decision.completions.map((s) => s.key),
        contradictions: decision.contradictions.map((c) => ({
          step: c.step.key,
          status: c.invocation.status,
          // The id is what makes a row adjudicable: warn mode records the
          // would-block decision, and deciding later whether it was a false
          // positive means going and looking at this invocation in Galaxy.
          invocationId: c.invocation.invocationId,
        })),
        overridden: adjudication.block ? [] : adjudication.cleared.map((c) => c.step.key),
        outcome: adjudication.outcome,
      },
    });

    if (!adjudication.block) return;
    return { block: true, reason: renderBlockReason(adjudication.unresolved) };
  });
}
