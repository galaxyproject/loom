/**
 * `/override <step-key> <reason>` -- the user-originated exception to the
 * evidence gate.
 *
 * The gate (`evidence-gate.ts`) denies a plan-step completion that contradicts
 * the step's own `loom-invocation` block. It used to let the model's second
 * attempt through, which made the deny advisory. Removing that leaves the gate
 * with no escape hatch at all, and a gate with no escape hatch is one people
 * turn off -- the residual `in_progress` pin (credentials dropping mid-session
 * leaves an invocation that no agent action can advance) is a real way to be
 * stuck behind a correct-looking check.
 *
 * So the exception exists, and it belongs to the person, not the model. It is
 * addressed to one named step, it carries a reason, it is recorded to
 * `activity.jsonl` as `evidence.override` alongside the invocation status at
 * the time, and it is spent by the first write it clears. That is what makes
 * the warn-mode audit readable later: an override is a row someone chose to
 * write, not a retry the model discovered.
 *
 * Bare `/override` prints what the gate is currently holding, because after a
 * deny the step is still `- [ ]` and the user has no other way to learn the key
 * to pass back.
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendActivityEvent } from "./activity.js";
import { getNotebookPath } from "./state.js";
import {
  grantEvidenceOverride,
  outstandingContradictions,
  resolveMode,
  resolveStepKey,
  type PlanStep,
} from "./evidence-gate.js";

const USAGE =
  "Usage: /override <step-key> <reason>  (e.g. /override plan-a-step-2 job finished, block is stale)";

export type OverrideResult =
  { ok: true; message: string; event: Record<string, unknown> } | { ok: false; message: string };

/**
 * Decide what `/override` does for one set of arguments against one notebook.
 * Pure: the caller grants the token, writes the activity row, and notifies.
 */
export function planOverride(content: string, args: string): OverrideResult {
  const raw = args.trim();
  if (!raw) return { ok: false, message: renderStatus(content) };

  // Split on the LONGEST leading token that names a real step, not on the first
  // space. `ANCHOR` is `\{#([^}]+)\}`, so an anchor may legitimately contain
  // spaces, and splitting at the first one would lock the user out of
  // overriding exactly those steps -- the gate failing closed with no way
  // through, which is the failure mode this command exists to prevent.
  const split = splitKeyAndReason(content, raw);
  if (split.kind === "none") {
    return {
      ok: false,
      message: `No plan step matches '${raw.split(/\s/)[0]}'.\n${renderStatus(content)}`,
    };
  }
  if (split.kind === "ambiguous") {
    const names = split.candidates.map((c) => `"${c.anchor ?? c.key}"`).join(" and ");
    return {
      ok: false,
      message:
        `That could mean ${names}, and this is not a thing to guess at. ` +
        `Quote the one you mean: /override "<step-key>" <reason>`,
    };
  }
  const { step, reason } = split;
  if (!reason) {
    return { ok: false, message: `A reason is required, so the record says why.\n${USAGE}` };
  }

  // Only a standing contradiction can be overridden. Pre-authorizing one that
  // does not exist yet would hand out a token the gate might spend on a
  // different contradiction later, which is not what the user agreed to.
  const outstanding = outstandingContradictions(content).find((c) => c.step.key === step.key);
  if (!outstanding) {
    return {
      ok: false,
      message:
        `Nothing to override on "${step.text}": no in-flight Galaxy invocation is bound to it. ` +
        `The evidence gate is not holding this step.`,
    };
  }

  return {
    ok: true,
    message:
      `Override recorded for "${step.text}" (${outstanding.invocation.status}). ` +
      `The next completion flip on this step goes through; a later contradiction on ` +
      `it is denied again.`,
    event: {
      step: step.key,
      stepState: step.state,
      invocationId: outstanding.invocation.invocationId,
      invocationStatus: outstanding.invocation.status,
      mode: resolveMode(),
      reason,
    },
  };
}

export type KeySplit =
  | { kind: "ok"; step: PlanStep; reason: string }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: PlanStep[] };

/**
 * Split `<step-key> <reason>` without ever guessing which step was meant.
 *
 * An anchor is `\{#([^}]+)\}`, so it may contain spaces, which rules out
 * splitting at the first one -- a step anchored `align step 2` would be
 * unaddressable, the gate failing closed with no way through. Taking the
 * longest matching prefix instead is worse: with steps anchored `align` and
 * `align checked` in the same notebook, `/override align checked the BAM by
 * hand` silently authorises `align checked` and eats the first three words of
 * the user's reason. Anchors are model-authored, so that is a way for the
 * model to aim a user's clearance at a step they did not name.
 *
 * So: a quoted key is taken literally, and an unquoted one is only accepted
 * when exactly one prefix resolves. Two or more and the command refuses and
 * says which, rather than picking. Offsets come from the original string, so
 * an anchor with a double space or a tab survives the round trip.
 */
export function splitKeyAndReason(content: string, raw: string): KeySplit {
  const quoted = raw.match(/^(["'])([^"']*)\1\s*([\s\S]*)$/);
  if (quoted) {
    const step = resolveStepKey(content, quoted[2]);
    return step ? { kind: "ok", step, reason: quoted[3].trim() } : { kind: "none" };
  }

  // Every offset at which a prefix of `raw` ends on a whitespace boundary.
  const boundaries: number[] = [];
  for (let i = 1; i <= raw.length; i++) {
    if (i === raw.length || /\s/.test(raw[i])) boundaries.push(i);
  }

  const hits: { step: PlanStep; end: number }[] = [];
  const seen = new Set<string>();
  for (const end of boundaries) {
    const step = resolveStepKey(content, raw.slice(0, end));
    if (!step || seen.has(step.key)) continue;
    seen.add(step.key);
    hits.push({ step, end });
  }

  if (hits.length === 0) return { kind: "none" };
  if (hits.length > 1) return { kind: "ambiguous", candidates: hits.map((h) => h.step) };
  return { kind: "ok", step: hits[0].step, reason: raw.slice(hits[0].end).trim() };
}

/** What the gate is holding right now, and how to address it. */
export function renderStatus(content: string): string {
  const outstanding = outstandingContradictions(content);
  const mode = resolveMode();
  if (outstanding.length === 0) {
    return `Evidence gate: ${mode}. No plan step is currently contradicted by an in-flight invocation.\n${USAGE}`;
  }
  const lines = outstanding.map(
    (c) => `  ${c.step.anchor ?? c.step.key}  ${c.invocation.status}  ${c.step.text}`,
  );
  return (
    `Evidence gate: ${mode}. Steps an in-flight invocation contradicts:\n` +
    lines.join("\n") +
    `\n${USAGE}`
  );
}

export function registerEvidenceOverrideCommand(pi: ExtensionAPI): void {
  pi.registerCommand("override", {
    description: "Override the evidence gate for one plan step, with a recorded reason",
    handler: async (args: string | undefined, ctx: ExtensionContext) => {
      const nbPath = getNotebookPath();
      if (!nbPath) {
        ctx.ui.notify(
          "No notebook in this session, so the evidence gate has nothing to hold.",
          "info",
        );
        return;
      }
      let content: string;
      try {
        content = fs.readFileSync(nbPath, "utf-8");
      } catch {
        ctx.ui.notify(`Couldn't read ${nbPath}.`, "error");
        return;
      }

      const result = planOverride(content, args ?? "");
      if (!result.ok) {
        ctx.ui.notify(result.message, "info");
        return;
      }

      grantEvidenceOverride(String(result.event.step), String(result.event.invocationId));
      appendActivityEvent(path.dirname(nbPath), {
        timestamp: new Date().toISOString(),
        kind: "evidence.override",
        source: "user",
        payload: result.event,
      });
      ctx.ui.notify(result.message, "info");
    },
  });
}
