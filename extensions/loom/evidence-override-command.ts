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

import { randomBytes } from "node:crypto";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendActivityEvent } from "./activity.js";
import { getNotebookPath } from "./state.js";
import { recordStore } from "./record-store.js";
import {
  currentRegistryView,
  grantEvidenceOverride,
  outstandingContradictions,
  resolveMode,
  resolveStepKey,
  type PlanStep,
} from "./evidence-gate.js";
import type { Registry } from "./registry.js";
import { NO_APPROVAL_REVISION } from "./registry-evaluation.js";
import { getSessionRegistry, type SessionRegistry } from "./registry-runtime.js";

const USAGE =
  "Usage: /override <step-key> <reason>  (e.g. /override plan-a-step-2 job finished, block is stale)";

export type OverrideResult =
  { ok: true; message: string; event: Record<string, unknown> } | { ok: false; message: string };

/**
 * Decide what `/override` does for one set of arguments against one notebook.
 * Pure: the caller grants the token, writes the activity row, and notifies.
 */
export function planOverride(
  content: string,
  args: string,
  registry: Registry | null = null,
): OverrideResult {
  const raw = args.trim();
  if (!raw) return { ok: false, message: renderStatus(content, registry) };

  // Split on the LONGEST leading token that names a real step, not on the first
  // space. `ANCHOR` is `\{#([^}]+)\}`, so an anchor may legitimately contain
  // spaces, and splitting at the first one would lock the user out of
  // overriding exactly those steps -- the gate failing closed with no way
  // through, which is the failure mode this command exists to prevent.
  const split = splitKeyAndReason(content, raw, registry);
  if (split.kind === "none") {
    return {
      ok: false,
      message: `No plan step matches '${raw.split(/\s/)[0]}'.\n${renderStatus(content, registry)}`,
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
  const outstanding = outstandingContradictions(content, registry).find(
    (c) => c.step.key === step.key || (!!step.anchor && c.step.anchor === step.anchor),
  );
  if (!outstanding) {
    return {
      ok: false,
      message:
        `Nothing to override on "${step.text}": no in-flight Galaxy invocation is bound to it, ` +
        `and the registry isn't holding it. The evidence gate is not holding this step.`,
    };
  }

  if (outstanding.source === "registry") {
    // Written into the registry as an evidence-gate exception on each run it
    // holds the step for: the user's call, on the record, for these runs only.
    // A later run on the step is a new attempt and is held again.
    return {
      ok: true,
      message:
        `Override recorded for "${step.text}" in the registry (${outstanding.hold.missing.join("; ")}). ` +
        `Completing this step goes through for the run(s) it was held for; a new run on it is ` +
        `held again until it's eligible.`,
      event: {
        source: "registry",
        step: outstanding.step.key,
        anchor: outstanding.hold.anchor,
        stepState: step.state,
        attempts: outstanding.hold.attemptIds,
        missing: outstanding.hold.missing,
        mode: resolveMode(),
        reason,
      },
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
export function splitKeyAndReason(
  content: string,
  raw: string,
  registry: Registry | null = null,
): KeySplit {
  const quoted = raw.match(/^(["'])([^"']*)\1\s*([\s\S]*)$/);
  if (quoted) {
    const step = resolveStepKey(content, quoted[2], registry);
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
    const step = resolveStepKey(content, raw.slice(0, end), registry);
    if (!step || seen.has(step.key)) continue;
    seen.add(step.key);
    hits.push({ step, end });
  }

  if (hits.length === 0) return { kind: "none" };
  if (hits.length > 1) return { kind: "ambiguous", candidates: hits.map((h) => h.step) };
  return { kind: "ok", step: hits[0].step, reason: raw.slice(hits[0].end).trim() };
}

/** What the gate is holding right now, and how to address it. */
export function renderStatus(content: string, registry: Registry | null = null): string {
  const outstanding = outstandingContradictions(content, registry);
  const mode = resolveMode();
  if (outstanding.length === 0) {
    return `Evidence gate: ${mode}. No plan step is currently held, by the registry or by an in-flight invocation.\n${USAGE}`;
  }
  const lines = outstanding.map((c) =>
    c.source === "block"
      ? `  ${c.step.anchor ?? c.step.key}  ${c.invocation.status}  ${c.step.text}`
      : `  ${c.step.anchor ?? c.step.key}  registry: ${c.hold.missing.join("; ")}  ${c.step.text}`,
  );
  return `Evidence gate: ${mode}. Steps the gate is holding:\n` + lines.join("\n") + `\n${USAGE}`;
}

/**
 * Record a registry override: one evidence-gate exception per held run, in
 * one signed write. Returns why it couldn't, or null.
 */
export function writeRegistryOverride(
  session: SessionRegistry | null,
  attemptIds: readonly string[],
  reason: string,
  now: string,
): string | null {
  if (!session || session.unavailable) return "the approval registry isn't open in this session";
  if (session.store.mode !== "writer") return "the approval registry is read-only in this session";
  try {
    session.store.update((draft) => {
      for (const id of attemptIds) {
        const attempt = draft.attempts[id];
        if (!attempt) continue;
        draft.exceptions.push({
          id: `override-${randomBytes(8).toString("hex")}`,
          attempt_id: id,
          spec_revision: attempt.approval?.spec_revision ?? NO_APPROVAL_REVISION,
          scope: "evidence_gate",
          by: "user",
          at: now,
          reason,
        });
      }
    });
  } catch (err) {
    return (err as Error).message;
  }
  return null;
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
        ({ content } = await recordStore(nbPath).read());
      } catch {
        ctx.ui.notify(`Couldn't read ${nbPath}.`, "error");
        return;
      }

      const registry = currentRegistryView();
      const result = planOverride(content, args ?? "", registry);
      if (!result.ok) {
        ctx.ui.notify(result.message, "info");
        return;
      }

      if (result.event.source === "registry") {
        const failed = writeRegistryOverride(
          getSessionRegistry(),
          result.event.attempts as string[],
          String(result.event.reason),
          new Date().toISOString(),
        );
        if (failed) {
          ctx.ui.notify(`Override not recorded: ${failed}.`, "warning");
          return;
        }
      } else {
        grantEvidenceOverride(String(result.event.step), String(result.event.invocationId));
      }
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
