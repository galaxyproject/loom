/**
 * The deterministic triggers that raise an observation, and the one path that
 * delivers one.
 *
 * Every trigger ENQUEUES; nothing is built, shown or sent from inside the hook
 * that noticed it. That is not bookkeeping -- in `ask` mode delivery blocks on
 * ctx.ui.confirm, and awaiting a human inside a tool_result handler would stall
 * the agent loop mid-turn. The queue drains on agent_settled, when the turn is
 * over and the user is reading anyway.
 *
 * Three triggers, all deterministic, none of them a model judgement:
 *   - a galaxy_* tool result with isError
 *   - the same tool and the same normalized signature RETRY_LOOP_THRESHOLD times
 *   - the evidence gate blocking a plan-step completion
 * A fourth, the user's own `/observe`, lives in observations-command.ts and
 * delivers immediately because the user is standing right there.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { normalizeSignature } from "../../shared/observation-contract.js";
import type {
  Observation,
  ObservationKind,
  ObservationTrigger,
} from "../../shared/observation-contract.js";
import {
  appendSentLog,
  appendToObservationOutbox,
  buildCheckedObservation,
  collectObservationEnvelope,
  drainObservationOutbox,
  extractDatatypes,
  extractToolIds,
  recordGalaxyVersionFromConnect,
  resetGalaxyVersion,
  saveRetractToken,
  sentLogEntryFor,
  shapeForMode,
  submitObservation,
  withheldReason,
} from "./observations.js";
import type {
  ObservationFacts,
  ObservationProblems,
  ObservationShape,
  SubmitObservationResult,
} from "./observations.js";
import { getOrCreateInstallToken, resolveObservationsMode } from "./observations-config.js";
import type { ObservationsMode } from "./observations-config.js";
import { onEvidenceDecision } from "./evidence-gate.js";
import { galaxyCall } from "./mcp-recovery.js";
import { appendActivityEvent } from "./activity.js";
import { getNotebookPath } from "./state.js";
import { confirmObservation, describeObservation } from "./observation-ui.js";

export const RETRY_LOOP_THRESHOLD = 3;
/**
 * A local ceiling on top of the Worker's 200-per-24h. One pathological session
 * should not be able to spend a day's budget, and 20 reports from one session
 * is already more signal than triage can use.
 */
export const OBSERVATIONS_SESSION_CAP = 20;

export interface TriggerState {
  /** `${tool}|${signature}` -> how many times it has failed this session. */
  counts: Map<string, number>;
  /** `${kind}|${tool}|${signature}` already reported, so nothing repeats. */
  emitted: Set<string>;
  /** Observations actually sent or queued this session. */
  delivered: number;
}

export function newTriggerState(): TriggerState {
  return { counts: new Map(), emitted: new Set(), delivered: 0 };
}

/**
 * Pure. One failure of one tool with one signature in, at most one report out.
 *
 * A loop therefore yields two observations, not three or ten: the first
 * failure is reported as a tool-error, and the third is reported as a
 * retry-loop (which is the more informative one -- it says the agent could not
 * get past it). Everything in between, and everything after, is silent.
 */
export function decideToolResultObservation(
  state: TriggerState,
  key: { mcpTool: string; signature: string; toolIds?: string[] },
): { kind: ObservationKind; trigger: ObservationTrigger } | null {
  if (!key.mcpTool || !key.signature) return null;
  // The Galaxy tool is part of "the same tool": three different tools failing
  // galaxy_run_tool with one message are three failures, not a loop.
  const tools = [...(key.toolIds ?? [])].sort().join(",");
  const k = `${key.mcpTool}|${tools}|${key.signature}`;
  const count = (state.counts.get(k) ?? 0) + 1;
  state.counts.set(k, count);

  const once = (kind: ObservationKind, trigger: ObservationTrigger) => {
    const marker = `${kind}|${k}`;
    if (state.emitted.has(marker)) return null;
    state.emitted.add(marker);
    return { kind, trigger };
  };

  if (count === 1) return once("tool-error", "tool_error");
  if (count === RETRY_LOOP_THRESHOLD) return once("retry-loop", "retry_loop");
  return null;
}

// -----------------------------------------------------------------------------
// Session state
// -----------------------------------------------------------------------------

let state = newTriggerState();
const pending: ObservationFacts[] = [];

let lastFacts: ObservationFacts | null = null;

/** The most recent thing a trigger saw, so `mode auto` can show a real sample. */
export function lastObservationFacts(): ObservationFacts | null {
  return lastFacts;
}

export function resetObservationTriggers(): void {
  state = newTriggerState();
  pending.length = 0;
  lastFacts = null;
  resetGalaxyVersion();
}

export function enqueueObservation(facts: ObservationFacts): void {
  lastFacts = facts;
  pending.push(facts);
}

export function pendingObservationCount(): number {
  return pending.length;
}

// -----------------------------------------------------------------------------
// Facts from a tool result
// -----------------------------------------------------------------------------

/**
 * galaxyCall normalises both surfaces -- a direct `galaxy_*` call and the
 * `mcp` proxy shape -- so a proxied failure is not silently invisible.
 */
export function factsForToolResult(
  toolName: string,
  input: Record<string, unknown>,
  text: string,
): ObservationFacts | null {
  const call = galaxyCall(toolName, input ?? {});
  if (!call) return null;
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  return {
    kind: "tool-error",
    trigger: "tool_error",
    mcpTool: call.name,
    toolIds: extractToolIds(call.args),
    datatypes: extractDatatypes(call.args),
    rawSignature: raw,
  };
}

// -----------------------------------------------------------------------------
// Delivery
// -----------------------------------------------------------------------------

/**
 * `unsaved`: the send failed in a way worth retrying, but the outbox could not
 * be written, so nothing is kept. `sent-unretractable`: it went, but its
 * retract token could not be saved. Both are local-write failures the user has
 * to hear about, since the usual message ("saved locally", "retract it any
 * time") would be untrue.
 */
export type DeliveryOutcome =
  "sent" | "sent-unretractable" | "queued" | "unsaved" | "declined" | "invalid" | "skipped";

/**
 * Everything impure, injected. The privacy-relevant decisions -- does this
 * send, does the user see it first, is it legal to send at all -- are then
 * testable with no pi session, no filesystem and no network.
 */
export interface DeliverDeps {
  /** The mode this delivery started under; it decides the payload shape. */
  mode: ObservationsMode;
  /**
   * The mode right now. Read again immediately before the POST, because the
   * confirm can sit open for minutes and another session (or the user, in
   * another window) can turn collection off in the meantime.
   */
  currentMode(): ObservationsMode;
  state: TriggerState;
  installToken(): string;
  /** Gets the built observation, never the raw facts. */
  describe(obs: Observation, ctx: ExtensionContext): Promise<string>;
  /** `note` is a one-line reason shown above the payload, e.g. why text was withheld. */
  confirm(obs: Observation, ctx: ExtensionContext, note?: string): Promise<boolean>;
  submit(obs: Observation): Promise<SubmitObservationResult>;
  record(kind: string, payload: Record<string, unknown>): void;
}

export interface BuiltObservation {
  obs: Observation;
  valid: boolean;
  errors: string[];
  leaks: string[];
  /** Patterns that got the signature withheld (ask only); empty otherwise. */
  withheld: string[];
}

/**
 * Build, check, and record -- and nothing else. Split out of
 * deliverObservation so the eval replay can exercise exactly the half that
 * matters for privacy with no transport anywhere in its call graph: a dry run
 * that cannot send because there is nothing to send with, not because a stub
 * refused.
 */
export function buildAndRecordObservation(
  facts: ObservationFacts,
  description: string,
  deps: Pick<DeliverDeps, "installToken" | "record">,
  shape: ObservationShape,
): BuiltObservation {
  const { obs, errors, leaks, withheld } = buildCheckedObservation(
    { ...facts, description },
    collectObservationEnvelope(deps.installToken()),
    shape,
  );
  const valid = errors.length === 0;
  // No free text in this row, ever. It is written before anyone has agreed to
  // anything -- before the ask confirm, and for /observe the signature is the
  // user's own sentence -- and a refused payload's text is exactly the text
  // that may carry the leak. The structured fields are safe to show: they are
  // admitted from allowlists by the builder. A withheld signature is named by
  // the patterns it tripped, never by its text.
  deps.record("observation.built", {
    kind: obs.kind,
    trigger: obs.trigger,
    stage: obs.stage,
    shape,
    mcpTool: obs.mcpTool ?? "",
    toolIds: obs.tools.map((t) => t.id).join(","),
    datatypes: obs.datatypes.join(","),
    server: obs.galaxy.server,
    descriptionLength: obs.description.length,
    signatureWithheld: withheld.join(","),
    valid,
    leakScan: leaks.length === 0 ? "clean" : "dirty",
  });
  return { obs, valid, errors, leaks, withheld };
}

function isClean(p: ObservationProblems): boolean {
  return p.errors.length === 0 && p.leaks.length === 0;
}

export async function deliverObservation(
  facts: ObservationFacts,
  ctx: ExtensionContext,
  deps: DeliverDeps,
): Promise<DeliveryOutcome> {
  if (deps.mode === "off") {
    deps.record("observation.skipped", { reason: "mode-off" });
    return "skipped";
  }
  if (deps.state.delivered >= OBSERVATIONS_SESSION_CAP) {
    deps.record("observation.skipped", { reason: "session-cap" });
    return "skipped";
  }
  // `ask` without a dialog surface is not "send it anyway", it is "don't".
  if (deps.mode === "ask" && !ctx.hasUI) {
    deps.record("observation.skipped", { reason: "no-ui" });
    return "skipped";
  }

  const shape = shapeForMode(deps.mode);

  // Check the rest of the payload before asking anyone for a description: if
  // it can't be sent, prompting the user for one is wasted, and the build
  // below records the refusal either way. `auto` never asks -- it carries no
  // free text.
  let description = "";
  const precheck =
    shape === "full"
      ? buildCheckedObservation(
          { ...facts, description: "" },
          collectObservationEnvelope(deps.installToken()),
          shape,
        )
      : undefined;
  if (precheck && isClean(precheck)) {
    try {
      description = await deps.describe(precheck.obs, ctx);
    } catch {
      // A description is a nice-to-have; the structured observation is the point.
      description = "";
    }
  }

  // The install token is written to config here, before any confirm, because a
  // valid payload needs one and the confirm has to show the real payload. It
  // is local state until the user says send.
  const { obs, valid, errors, leaks, withheld } = buildAndRecordObservation(
    facts,
    description,
    deps,
    shape,
  );

  if (!valid || leaks.length > 0) {
    // Fail closed. Nothing is sent, and only field and pattern names are
    // recorded -- the offending value stays out of the log too.
    deps.record("observation.invalid", {
      kind: obs.kind,
      errors: errors.join(","),
      leaks: leaks.join(","),
    });
    return "invalid";
  }

  const note = withheld.length > 0 ? withheldReason(withheld) : undefined;
  if (deps.mode === "ask" && !(await deps.confirm(obs, ctx, note))) {
    // No signature: the user said no, and for /observe it is their own words.
    deps.record("observation.declined", { kind: obs.kind });
    return "declined";
  }

  // Consent is checked where it is spent. Off means off, even mid-confirm; and
  // an auto delivery no longer goes once the user has stepped back to ask,
  // since they never saw this one. An ask that was confirmed still goes under
  // auto: the user has already seen it and said yes.
  const now = deps.currentMode();
  if (now === "off" || (deps.mode === "auto" && now !== "auto")) {
    deps.record("observation.skipped", { reason: "mode-changed" });
    return "skipped";
  }

  const res = await deps.submit(obs);
  if (res.ok) {
    const tokenLost = Boolean(res.retractToken) && !saveRetractToken(obs.id, res.retractToken!);
    appendSentLog(sentLogEntryFor(obs, "sent"));
    deps.state.delivered += 1;
    deps.record("observation.sent", {
      id: obs.id,
      kind: obs.kind,
      // After consent, so the normalized signature may be logged -- except the
      // user's own /observe sentence, which stays in the sent log only.
      ...(obs.trigger === "explicit" ? {} : { signature: obs.signature }),
      ...(tokenLost ? { tokenWrite: "failed" } : {}),
    });
    return tokenLost ? "sent-unretractable" : "sent";
  }
  if (res.queueable) {
    if (!appendToObservationOutbox(obs)) {
      deps.record("observation.unsaved", {
        id: obs.id,
        kind: obs.kind,
        status: res.status ?? 0,
        reason: "outbox-write-failed",
      });
      return "unsaved";
    }
    appendSentLog(sentLogEntryFor(obs, "queued"));
    deps.state.delivered += 1;
    deps.record("observation.queued", {
      id: obs.id,
      kind: obs.kind,
      status: res.status ?? 0,
      // Never the error text: it comes from the transport or the Worker.
      reason: res.status ? `status ${res.status}` : "unreachable",
    });
    return "queued";
  }
  deps.record("observation.invalid", {
    kind: obs.kind,
    status: res.status ?? 0,
    // The Worker's error list is endpoint-controlled text, and the endpoint
    // can be repointed; only `field:reason` names are kept.
    errors: (res.errors ?? []).filter(isFieldReason).join(","),
    leaks: "",
  });
  return "invalid";
}

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

const FIELD_REASON_RE = /^[A-Za-z0-9_.<>[\]]{1,60}:[a-z0-9-]{1,40}$/;

function isFieldReason(v: unknown): boolean {
  return typeof v === "string" && FIELD_REASON_RE.test(v);
}

// A filesystem error message carries the path, and the path carries the
// username; only the error's code or name is printed.
function errorTag(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string") return code;
  return err instanceof Error ? err.name : "error";
}

/** What to tell the user when a delivery's local write failed, if anything. */
export function localWriteWarning(outcome: DeliveryOutcome): string | undefined {
  if (outcome === "unsaved") {
    return "An observation couldn't be sent right now, and it couldn't be saved locally to retry either (check that the Loom state directory is writable). Nothing was kept.";
  }
  if (outcome === "sent-unretractable") {
    return "An observation was sent, but its retract token couldn't be saved locally, so /observations retract won't be able to delete it.";
  }
  return undefined;
}

/** Activity rows land beside the session's notebook, like every other row. */
export function recordObservationActivity(
  kind: string,
  payload: Record<string, unknown>,
  source = "observations",
): void {
  const notebook = getNotebookPath();
  if (!notebook) return;
  appendActivityEvent(path.dirname(notebook), {
    timestamp: new Date().toISOString(),
    kind,
    source,
    payload,
  });
}

/** The production dep set. */
export function liveDeliverDeps(
  ctxMode: ObservationsMode = resolveObservationsMode(),
): DeliverDeps {
  return {
    mode: ctxMode,
    currentMode: resolveObservationsMode,
    state,
    installToken: getOrCreateInstallToken,
    describe: (obs, ctx) => describeObservation(ctxMode, obs, ctx),
    confirm: confirmObservation,
    submit: submitObservation,
    record: (kind, payload) => recordObservationActivity(kind, payload),
  };
}

function errorTextOf(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

const EVIDENCE_MARKER = "assertion-failed|evidence-gate";

export function registerObservationTriggers(pi: ExtensionAPI): void {
  pi.on("session_start", async () => {
    resetObservationTriggers();
  });

  pi.on("tool_result", async (event) => {
    // Registered AFTER secret redaction in index.ts, so `content` here is the
    // already-scrubbed text the model sees. Reading the raw result would put
    // an API key one normalization away from the wire.
    if (
      galaxyCall(event.toolName, event.input ?? {})?.name === "galaxy_connect" &&
      !event.isError
    ) {
      recordGalaxyVersionFromConnect(errorTextOf(event.content));
    }
    if (resolveObservationsMode() === "off") return;

    const failed = event.isError || Boolean((event.details as { error?: unknown })?.error);
    if (!failed) return;
    const facts = factsForToolResult(event.toolName, event.input, errorTextOf(event.content));
    if (!facts) return;

    const decision = decideToolResultObservation(state, {
      mcpTool: facts.mcpTool ?? "",
      toolIds: facts.toolIds,
      signature: normalizeSignature(facts.rawSignature),
    });
    if (!decision) return;
    enqueueObservation({ ...facts, kind: decision.kind, trigger: decision.trigger });
  });

  onEvidenceDecision((info) => {
    if (info.outcome !== "blocked") return;
    if (resolveObservationsMode() === "off") return;
    // Once per session. The agent usually retries a blocked write, and each
    // block would otherwise cost the user another prompt for the same report.
    if (state.emitted.has(EVIDENCE_MARKER)) return;
    state.emitted.add(EVIDENCE_MARKER);
    enqueueObservation({
      kind: "assertion-failed",
      trigger: "assertion",
      stage: "result-interpretation",
      toolIds: [],
      datatypes: [],
      // No step text, no anchor, no invocation id: the signal is the shape of
      // the mistake, and the shape is the whole message.
      rawSignature:
        "the evidence gate refused a plan-step completion claimed over an unfinished Galaxy invocation",
    });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    // Earlier sends that hit a transport failure, a 429 or a 5xx. They were
    // already consented to (confirmed, or sent in auto), so they go without a
    // prompt -- but never while collection is off.
    if (resolveObservationsMode() !== "off") {
      try {
        const drained = await drainObservationOutbox(
          submitObservation,
          () => resolveObservationsMode() !== "off",
        );
        if (drained.sent + drained.dropped > 0) {
          recordObservationActivity("observation.outbox", { ...drained });
        }
        if (drained.unretractable && ctx.hasUI) {
          ctx.ui.notify(localWriteWarning("sent-unretractable") ?? "", "warning");
        }
      } catch (err) {
        console.error("observation outbox drain failed:", errorTag(err));
      }
    }
    while (pending.length > 0) {
      const facts = pending.shift();
      if (!facts) break;
      try {
        const outcome = await deliverObservation(facts, ctx, liveDeliverDeps());
        const warning = localWriteWarning(outcome);
        if (warning && ctx.hasUI) ctx.ui.notify(warning, "warning");
      } catch (err) {
        // A failed delivery must never take the settle handler down with it.
        console.error("observation delivery failed:", errorTag(err));
      }
    }
  });
}
