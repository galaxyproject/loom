/**
 * The submission ledger: one entry per Galaxy submission and one per terminal event, kept by
 * record key, so neither a lost response nor a crash between persisting a transition and
 * announcing it costs the record anything.
 *
 * Capture's in-flight map and the poller's follow-up list live only as long as the process and
 * the bound conversation do. The ledger is written before the request goes out and as soon as
 * the response is in hand, from inside the tool's own execute, so a submission whose
 * `tool_execution_end` never fires (the conversation was left, the worker reloaded) can still be
 * captured from it, and one whose response never arrived gives reconcile a history and a window
 * to look in. A terminal event is reserved before the block moves and confirmed only once it has,
 * so an event is never announced for a transition nothing wrote.
 *
 * The default ledger is in memory: the desktop, CLI and web keep today's behaviour and gain only
 * the in-process fixes. The browser worker installs a durable one (slice 3, commit 13). No Node
 * imports: the Galaxy tools' execute writes it, and that path runs in the browser worker.
 */

import { getGalaxyConfig } from "./galaxy-api";
import {
  UNATTRIBUTED,
  parseSubmission,
  type ParsedSubmission,
  type ResolvedResult,
} from "./galaxy-submission";
import { ulid } from "./ulid";

export interface DispatchedSubmission {
  callId: string;
  attemptId: string;
  toolName: string;
  /** The record the submission belongs to, pinned when the call started (`pinnedDispatch`). */
  recordKey: string;
  /** The plan step the call was made for, so a recovered block keeps its attribution. */
  stepAnchor: string;
  historyId?: string;
  server: string;
  dispatchedAt: string;
}

export type SubmissionState = "dispatched" | "responded" | "captured" | "reconciled" | "abandoned";

export interface SubmissionEntry extends DispatchedSubmission {
  state: SubmissionState;
  /** Galaxy's answer as `parseSubmission` read it, once it arrived. */
  submission?: ParsedSubmission;
  /** Why capture gave up, or what reconcile found. */
  note?: string;
}

export type TerminalEventState = "reserved" | "confirmed" | "voided" | "delivered";

export interface TerminalEventInput {
  recordKey: string;
  kind: "job" | "invocation";
  id: string;
  from: string;
  /** The block status the write moves it to. */
  to: string;
  /** What the follow-up reports: the status, or "failing" for a mid-flight invocation failure. */
  outcome: string;
  label: string;
  notebookAnchor?: string;
  detail?: string;
  key: string;
}

export interface TerminalEvent extends TerminalEventInput {
  state: TerminalEventState;
}

export interface LedgerHistory {
  historyId: string;
  server: string;
}

export interface SubmissionLedger {
  /** Awaited before the request is sent; a throw stops the submission. */
  dispatched(entry: DispatchedSubmission): Promise<void>;
  responded(callId: string, submission: ParsedSubmission): Promise<void>;
  captured(callId: string): Promise<void>;
  reconciled(callId: string, note: string): Promise<void>;
  abandoned(callId: string, reason: string): Promise<void>;
  /** A repeat reservation of a live key reuses it. */
  reserve(event: TerminalEventInput): Promise<void>;
  confirm(recordKey: string, key: string): Promise<void>;
  void(recordKey: string, key: string): Promise<void>;
  delivered(recordKey: string, keys: readonly string[]): Promise<void>;
  /** Entries for this record not yet captured, reconciled or abandoned, oldest first. */
  open(recordKey: string): Promise<SubmissionEntry[]>;
  /** Events reserved and neither confirmed nor voided, for the next tick to settle. */
  reserved(recordKey: string): Promise<TerminalEvent[]>;
  /** Confirmed events not yet delivered, oldest first. */
  undelivered(recordKey: string): Promise<TerminalEvent[]>;
  /**
   * The history Galaxy last confirmed a submission of this record went to; kept after its entries
   * are pruned. A call that was never answered isn't counted: its history is on its entry.
   */
  lastHistory(recordKey: string): Promise<LedgerHistory | undefined>;
  /** Drop what is closed. The memory ledger has nothing to do: it drops at close. */
  prune(recordKey: string): Promise<void>;
}

/** The key a terminal event is reserved, confirmed and delivered under. */
export function terminalEventKey(kind: TerminalEventInput["kind"], id: string, outcome: string) {
  return `${kind}:${id}:${outcome}`;
}

const CLOSED: ReadonlySet<SubmissionState> = new Set(["captured", "reconciled", "abandoned"]);

export function isClosedSubmission(entry: SubmissionEntry): boolean {
  return CLOSED.has(entry.state);
}

/**
 * A delivered "failing" event is kept: the invocation's block stays in flight, so every tick
 * sees the failure again, and the kept key is what stops a second announcement.
 */
function keepsAfterDelivery(event: TerminalEvent): boolean {
  return event.state === "delivered" && event.outcome === "failing";
}

/** Closed entries and settled events go; what is still open, reserved or undelivered stays. */
export function pruneClosed<E extends SubmissionEntry, T extends TerminalEvent>(
  entries: readonly E[],
  events: readonly T[],
): { entries: E[]; events: T[] } {
  return {
    entries: entries.filter((e) => !isClosedSubmission(e)),
    events: events.filter(
      (e) => e.state === "reserved" || e.state === "confirmed" || keepsAfterDelivery(e),
    ),
  };
}

/** Everything a ledger holds, as plain data: what a durable ledger writes down and reads back. */
export interface LedgerState {
  entries: SubmissionEntry[];
  /** By record key. */
  events: Record<string, TerminalEvent[]>;
  histories: Record<string, LedgerHistory>;
}

/**
 * The in-memory ledger. Entries and events are pruned the moment they close, so a long desktop
 * session holds only what is actually open.
 *
 * A durable ledger is this one with a starting `state` and a `persist` that writes each change
 * down before the call returns: the rules live in one place, and only where they're kept differs.
 */
export function createMemoryLedger(
  opts: { state?: LedgerState; persist?: (state: LedgerState) => Promise<void> } = {},
): SubmissionLedger {
  const entries = new Map<string, SubmissionEntry>(
    (opts.state?.entries ?? []).map((e) => [e.callId, { ...e }]),
  );
  // Events by record key, then event key.
  const events = new Map<string, Map<string, TerminalEvent>>(
    Object.entries(opts.state?.events ?? {}).map(([recordKey, list]) => [
      recordKey,
      new Map(list.map((e) => [e.key, { ...e }])),
    ]),
  );
  const histories = new Map<string, LedgerHistory>(Object.entries(opts.state?.histories ?? {}));

  const snapshot = (): LedgerState => ({
    entries: [...entries.values()].map((e) => ({ ...e })),
    events: Object.fromEntries(
      [...events]
        .filter(([, keyed]) => keyed.size > 0)
        .map(([recordKey, keyed]) => [recordKey, [...keyed.values()].map((e) => ({ ...e }))]),
    ),
    histories: Object.fromEntries([...histories].map(([k, h]) => [k, { ...h }])),
  });
  // Writes go down in the order the changes were made, and each change returns only once its own
  // write has landed, so a dispatched entry is on disk before its request goes out.
  let writing: Promise<void> = Promise.resolve();
  const persisted = async () => {
    if (!opts.persist) return;
    const state = snapshot();
    const write = writing.then(() => opts.persist!(state));
    writing = write.catch(() => {});
    await write;
  };

  const noteHistory = (entry: SubmissionEntry, historyId: string | undefined) => {
    if (historyId) histories.set(entry.recordKey, { historyId, server: entry.server });
  };
  // Closed means gone: the reason was already logged by whoever closed it.
  const close = (callId: string) => {
    entries.delete(callId);
  };
  const eventsOf = (recordKey: string) => {
    let found = events.get(recordKey);
    if (!found) events.set(recordKey, (found = new Map()));
    return found;
  };
  const settle = (recordKey: string, key: string, state: "confirmed" | "voided") => {
    const keyed = eventsOf(recordKey);
    const event = keyed.get(key);
    if (!event || event.state !== "reserved") return;
    if (state === "voided") keyed.delete(key);
    else event.state = state;
  };
  const listed = (recordKey: string, state: TerminalEventState) =>
    [...eventsOf(recordKey).values()].filter((e) => e.state === state).map((e) => ({ ...e }));

  return {
    async dispatched(entry) {
      const opened: SubmissionEntry = { ...entry, state: "dispatched" };
      // The history is noted only once Galaxy answers: a call it refused names a history that
      // may not exist, and reconcile would go looking in it.
      entries.set(entry.callId, opened);
      try {
        await persisted();
      } catch (error) {
        // Not on disk means not sent: an entry left here would keep the record "open" and pin
        // reconcile's window to a request that never went out.
        entries.delete(entry.callId);
        throw error;
      }
    },
    async responded(callId, submission) {
      const entry = entries.get(callId);
      if (!entry || entry.state !== "dispatched") return;
      entry.state = "responded";
      entry.submission = submission;
      noteHistory(
        entry,
        submission.historyId ?? submission.jobs?.find((j) => j.historyId)?.historyId,
      );
      await persisted();
    },
    async captured(callId) {
      close(callId);
      await persisted();
    },
    async reconciled(callId) {
      close(callId);
      await persisted();
    },
    async abandoned(callId) {
      close(callId);
      await persisted();
    },
    async reserve(event) {
      const keyed = eventsOf(event.recordKey);
      if (keyed.has(event.key)) return;
      keyed.set(event.key, { ...event, state: "reserved" });
      await persisted();
    },
    async confirm(recordKey, key) {
      settle(recordKey, key, "confirmed");
      await persisted();
    },
    async void(recordKey, key) {
      settle(recordKey, key, "voided");
      await persisted();
    },
    async delivered(recordKey, keys) {
      const keyed = eventsOf(recordKey);
      for (const key of keys) {
        const event = keyed.get(key);
        if (event?.state !== "confirmed") continue;
        event.state = "delivered";
        if (keepsAfterDelivery(event)) continue;
        keyed.delete(key);
        // The run ended, so its failure can't be seen again: the kept key has done its job.
        for (const [kept, other] of keyed) {
          if (other.id === event.id && other.kind === event.kind && keepsAfterDelivery(other)) {
            keyed.delete(kept);
          }
        }
      }
      await persisted();
    },
    async open(recordKey) {
      return [...entries.values()].filter((e) => e.recordKey === recordKey).map((e) => ({ ...e }));
    },
    async reserved(recordKey) {
      return listed(recordKey, "reserved");
    },
    async undelivered(recordKey) {
      return listed(recordKey, "confirmed");
    },
    async lastHistory(recordKey) {
      const found = histories.get(recordKey);
      return found ? { ...found } : undefined;
    },
    async prune() {},
  };
}

let installed: SubmissionLedger | null = null;
let fallback: SubmissionLedger | null = null;

/** The shell seam. Null restores the memory default (a fresh one). */
export function setSubmissionLedger(ledger: SubmissionLedger | null): void {
  installed = ledger;
  if (ledger === null) fallback = null;
}

export function submissionLedger(): SubmissionLedger {
  if (installed) return installed;
  fallback ??= createMemoryLedger();
  return fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing it from inside the tool's execute
// ─────────────────────────────────────────────────────────────────────────────

/** What capture pinned when the call started (galaxy-submission-capture.ts). */
export interface PinnedDispatch {
  recordKey: string | null;
  attemptId: string;
  stepAnchor: string;
  submittedAt: string;
}

let pinsOf: (callId: string) => PinnedDispatch | undefined = () => undefined;
let boundRecordKey: () => string | null = () => null;

/**
 * Capture installs its pins here: capture pins the record key, the ledger reads it, so a switch
 * between the call starting and its request going out can't give the two different records. The
 * bound record is the fallback for a call that had no start event.
 */
export function setDispatchPins(
  pins: (callId: string) => PinnedDispatch | undefined,
  bound: () => string | null,
): void {
  pinsOf = pins;
  boundRecordKey = bound;
}

/** Calls whose request is out and whose answer has not come back, in this process. */
const awaitingAnswer = new Set<string>();

/**
 * Whether this process is still waiting on the call's answer. Reconcile leaves such an entry
 * alone: it is not lost, just slow, and counting it would move the desktop's window for nothing.
 */
export function isAwaitingAnswer(callId: string): boolean {
  return awaitingAnswer.has(callId);
}

/** What came back from a submission request, as the ledger needs it. */
export type SubmissionAnswer =
  | { kind: "answered"; resolved: ResolvedResult }
  /** Galaxy said no: nothing was created. */
  | { kind: "refused"; reason: string }
  /** No answer worth trusting -- a deadline, a dropped connection. It may have landed. */
  | { kind: "unknown" };

/**
 * Send a submission with the ledger written around it: an entry before the request goes out
 * (a failure to write it stops the request), the parsed answer as soon as it is in hand. This runs
 * inside the tool's own execute, so it holds whether or not anyone is still listening for the
 * tool's end event. A throw leaves the entry open: the request may have landed.
 */
export async function sendSubmission<R>(
  callId: string,
  toolName: string,
  args: Record<string, unknown>,
  send: () => Promise<R>,
  answerOf: (result: R) => SubmissionAnswer,
  notSent: (message: string) => R,
): Promise<R> {
  const ledger = submissionLedger();
  const pinned = pinsOf(callId);
  const recordKey = pinned ? pinned.recordKey : boundRecordKey();
  const historyId = typeof args.history_id === "string" ? args.history_id : undefined;
  try {
    if (recordKey) {
      await ledger.dispatched({
        callId,
        attemptId: pinned?.attemptId ?? ulid(),
        toolName,
        recordKey,
        // A call with no start event was made for no step we saw.
        stepAnchor: pinned?.stepAnchor ?? UNATTRIBUTED,
        ...(historyId ? { historyId } : {}),
        server: getGalaxyConfig()?.url ?? "",
        dispatchedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return notSent(
      `Not sent to Galaxy: the submission could not be recorded first (${why}). Nothing was submitted; it is safe to try again.`,
    );
  }

  awaitingAnswer.add(callId);
  let result: R;
  try {
    result = await send();
  } finally {
    awaitingAnswer.delete(callId);
  }
  if (!recordKey) return result;

  try {
    const answer = answerOf(result);
    if (answer.kind === "refused") await ledger.abandoned(callId, answer.reason);
    else if (answer.kind === "answered") {
      const parsed = parseSubmission(toolName, args, answer.resolved);
      if (parsed.ok) await ledger.responded(callId, parsed.submission);
      else await ledger.abandoned(callId, parsed.reason);
    }
  } catch (err) {
    // The answer is real; capture still has it from the end event.
    console.error("[submission-ledger] response not written:", err);
  }
  return result;
}
