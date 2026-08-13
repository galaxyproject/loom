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
 * Known gap, recorded rather than papered over: a model can still split the
 * forgery across two edits -- rewrite `status:` in one, flip the checkbox in
 * the next -- and the pre-image check will not see it. Closing that needs the
 * poller's status kept out of band, where the model cannot author it.
 */

import fs from "node:fs";
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
  let planKey = "";
  for (const line of content.split("\n")) {
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
 * Steps that went `- [ ]` -> `- [x]` between two versions of the notebook.
 *
 * Only that transition counts. `- [ ]` -> `- [!]` records a failure, which is
 * the honest behaviour the discipline asks for and must never be gated, and
 * `- [x]` -> `- [ ]` is reopening. A step that is `[x]` in the new content with
 * no `[ ]` counterpart in the old is not a flip either -- that rule is what
 * keeps a first write, or a wholesale plan regeneration, from reading as a
 * pile of unevidenced completions.
 */
export function detectCompletions(before: string, after: string): PlanStep[] {
  const pre = parsePlanSteps(before);
  const post = parsePlanSteps(after);
  const flips: PlanStep[] = [];
  for (const [key, step] of post) {
    if (step.state !== "x") continue;
    const prior = pre.get(key);
    if (prior && prior.state === " ") flips.push(step);
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
 * Reconstruct what the file will contain after this call, or null when we
 * can't tell. Null always means "no opinion" -- an unreadable file or an edit
 * whose oldText doesn't match is not ours to adjudicate, and guessing would
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
  const edits = input.edits;
  if (!Array.isArray(edits)) return null;
  let out = before;
  for (const raw of edits) {
    const e = raw as { oldText?: unknown; newText?: unknown };
    if (typeof e.oldText !== "string" || typeof e.newText !== "string") return null;
    const idx = out.indexOf(e.oldText);
    if (idx === -1) return null; // pi will reject this edit anyway
    out = out.slice(0, idx) + e.newText + out.slice(idx + e.oldText.length);
  }
  return out;
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
    `the outputs, record that evidence, and then flip the checkbox.`
  );
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
    reason: contradictions.map(contradictionReason).join("\n\n"),
  };
}

function sameFile(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

export function registerEvidenceGate(pi: ExtensionAPI): void {
  // One deny per step per session. A model that disagrees with the gate must be
  // able to proceed on the second attempt -- an unwinnable retry loop is worse
  // than the unevidenced claim, and the user retains the right to override.
  const denied = new Set<string>();

  pi.on("tool_call", async (event, ctx) => {
    const mode = resolveMode();
    if (mode === "off") return;
    if (!WRITE_TOOLS.has(event.toolName)) return;

    const nbPath = getNotebookPath();
    if (!nbPath) return;
    const input = event.input as Record<string, unknown>;
    // pi's edit and write both accept `file_path` as an alias for `path`
    // (dist/core/tools/edit.js:82, write.js:94). Reading only `path` leaves a
    // one-key bypass. (exec-guard/policy.ts has the same gap -- tracked
    // separately; it is a safety gate, so it matters more there than here.)
    const target =
      typeof input.path === "string"
        ? input.path
        : typeof input.file_path === "string"
          ? input.file_path
          : undefined;
    if (!target) return;
    const abs = path.isAbsolute(target) ? target : path.resolve(ctx.cwd, target);
    if (!sameFile(abs, nbPath)) return;

    let before: string;
    try {
      before = fs.readFileSync(nbPath, "utf-8");
    } catch {
      return; // no notebook on disk yet -- nothing to compare against
    }

    const decision = decideNotebookWrite(before, event.toolName, input, mode);
    if (decision.completions.length === 0) return;

    const fresh = decision.contradictions.filter((c) => !denied.has(c.step.key));
    const willBlock = decision.gated && fresh.length > 0;

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
        })),
        outcome: willBlock ? "blocked" : decision.contradictions.length ? "warned" : "recorded",
      },
    });

    if (!willBlock) return;
    for (const c of fresh) denied.add(c.step.key);
    return { block: true, reason: decision.reason };
  });
}
