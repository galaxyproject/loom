/**
 * Analysis log widget -- a readable running log of what the agent has done.
 *
 * The source is `activity.jsonl`, which the brain appends to from six places
 * (`extensions/loom/activity-hooks.ts`, `galaxy-poller.ts`, `evidence-gate.ts`,
 * `evidence-override-command.ts`, `exec-guard/gate.ts`, `state.ts`). Every row
 * is the same envelope, so the only thing this file really does is turn a
 * `{kind, payload}` into one sentence a biologist can read, and stay honest
 * about the kinds it does not recognise.
 *
 * Two things are load-bearing and easy to lose in a refactor:
 *
 *  - **Nothing from a payload reaches the DOM except through `textContent`.**
 *    A payload carries tool arguments and tool output, which is to say text a
 *    model wrote and text a command printed.
 *  - **A key whose NAME looks like a credential keeps its name and loses its
 *    value.** That is most of the fence, and the rest of it is a credential
 *    *option* inside a token list hiding what it introduces, because a command
 *    line recorded as argv would have no keys to read -- no producer writes
 *    one today, so that half is a guard rather than a fix. It is worth being
 *    precise
 *    about what still walks through: it does not scan values, so a key pasted
 *    into the middle of a command string leaks, and a payload that uses a
 *    whole secret as a KEY shows that key by name -- a Galaxy job id has the
 *    same shape, so hiding it would cost more than it buys. The brain redacts
 *    before it writes (`redactArgs`, `redactSecrets`) and has the same shape,
 *    so this is a second fence on the same axis, not a wider one. Second
 *    fences are worth having anyway when the first one lives in a different
 *    process.
 */

import type { ActivityEvent, WidgetDefinition, WidgetDispose } from "../widget-api.js";
import { safeName, UNSAFE_BLOCK } from "./text-safety.js";

export type ActivityConfig = {
  /** Kinds to show. `"all"`, or a list; an empty or unusable list means "all". */
  kinds: string[] | "all";
  /** Hard ceiling on rows in the DOM, so a long session cannot grow it forever. */
  maxEntries: number;
  /** Expandable raw detail under each entry. */
  showDetail: boolean;
};

/** The source hands over at most 200 events, so this is the whole tail. */
const DEFAULT_MAX_ENTRIES = 200;
const MAX_ENTRIES_CEILING = 500;
/** One entry is one line of prose, not a transcript. */
const SUMMARY_MAX = 200;
const REASON_MAX = 120;
const DETAIL_STRING_MAX = 400;
const DETAIL_TOTAL_MAX = 2000;
const DETAIL_DEPTH_MAX = 6;
const DETAIL_KEYS_MAX = 40;
/**
 * How many nodes one payload may expand to.
 *
 * The cycle guard is a *path* set -- an object is added on the way down and
 * removed on the way back up -- which cuts cycles correctly and puts no bound
 * at all on sharing: a node reachable by N paths is materialised N times, so a
 * six-deep graph over seven distinct objects blocked the main thread for
 * twenty seconds and then threw out of `JSON.stringify`. Every activity event
 * this build can see comes from `JSON.parse`, which only ever yields a tree, so
 * nothing on the wire today can reach it -- but `redactForDisplay` is exported,
 * `ActivityEvent.payload` is a plain record in the contract, and the dashboard
 * already has one source the brain pushes in process. The bound costs one
 * comparison; the assumption costs a frozen window.
 */
const DETAIL_NODES_MAX = 5000;
/** Within this many pixels of the bottom still counts as "following". */
const STICK_THRESHOLD_PX = 24;
/** How many opened entries the widget remembers across a rebuild. */
const EXPANDED_MAX = 500;

/**
 * Deliberately broader than it needs to be, and broader than the brain's own
 * list in `activity-hooks.ts`. Over-redacting a field name costs a reader one
 * click into Galaxy; under-redacting one puts a key in a file people share.
 *
 * `auth` and `cred` rather than `authorization` and `credential`: the two
 * commonest abbreviations are what a payload actually spells, and the long
 * forms are stems of them anyway. The cost is that `author` is hidden too,
 * which is the trade above taken deliberately rather than by accident.
 */
const CREDENTIAL_KEY =
  /key|token|secret|passw|pwd|auth|bearer|cred|cookie|session|signature|security/i;
const HIDDEN = "[hidden]";

/** A key is a name. Anything longer than this is a value being used as one. */
const DETAIL_KEY_MAX = 80;

/**
 * `--api-key`, `-H`: an option, and nothing a filename could be mistaken for.
 * The leading dash is the whole of the discrimination. Without it the stem
 * match is far too eager on ordinary data -- `monkey.png` contains "key" and
 * `session1.dat` contains "session", and either of those blanking the file
 * listed after it is worse than the leak this guards against.
 */
const OPTION_FLAG = /^-{1,2}[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

/** `Authorization`, `api_key`: a bare header or variable name, no spaces. */
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/**
 * Hide what a credential-shaped name introduces inside a token list.
 *
 * A command line recorded as `["--api-key", "abc123"]` hands the fence no key
 * to read, so the same secret that `{api_key: "abc123"}` would have lost would
 * walk straight through. Every half of the pair is covered: `--api-key abc123`
 * as two elements, `--api-key=abc123` as one, and `Authorization:` introducing
 * `Bearer abc123` as the element after it.
 *
 * **Nothing in this build writes a payload of that shape** -- `activity-hooks`
 * and `exec-guard/gate` both record `redactArgs(toolName, args)`, which is the
 * tool's JSON argument object -- so this is a guard against a shape the log may
 * grow, not one it has. That is exactly why it has to be narrow: over-redaction
 * on a field name costs a click, but silently blanking one filename in a list
 * of results because the one before it was called `monkey.png` is a reader
 * losing data with no way to work out why.
 */
function redactToken(token: string): { text: string; hideNext: boolean } {
  const capped = truncate(token, DETAIL_STRING_MAX);
  const at = token.search(/[=:]/);
  if (at > 0) {
    const name = token.slice(0, at);
    const introduces = OPTION_FLAG.test(name) || HEADER_NAME.test(name);
    if (introduces && CREDENTIAL_KEY.test(name)) {
      // `Authorization:` with nothing after it introduces the NEXT element.
      // Writing "[hidden]" here would claim to have hidden something and then
      // print the value in the element after it.
      return token.length > at + 1
        ? { text: `${token.slice(0, at + 1)}${HIDDEN}`, hideNext: false }
        : { text: capped, hideNext: true };
    }
  } else if (at < 0 && OPTION_FLAG.test(token) && CREDENTIAL_KEY.test(token)) {
    return { text: capped, hideNext: true };
  }
  return { text: capped, hideNext: false };
}

/**
 * Split a command line into shell tokens, keeping the whitespace between them
 * so a rejoin is byte-exact.
 *
 * Splitting on whitespace alone would cut `'Authorization: Bearer t0ken'` into
 * three, and the fence would then hide the word `Bearer` and print the secret
 * in the token after it. The shell reads that as one argument and so does this.
 */
function shellTokens(text: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let quote: string | null = null;
  for (const ch of text) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      parts.push(buf, ch);
      buf = "";
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts;
}

/** `redactToken`'s discrimination, for a token that may carry shell quotes. */
function redactShellToken(token: string): { text: string; hideNext: boolean } {
  const quoted =
    token.length > 1 && (token[0] === "'" || token[0] === '"') && token.at(-1) === token[0];
  const q = quoted ? token[0] : "";
  const inner = quoted ? token.slice(1, -1) : token;
  const at = inner.search(/[=:]/);
  if (at > 0) {
    const name = inner.slice(0, at);
    const introduces = OPTION_FLAG.test(name) || HEADER_NAME.test(name);
    // Everything after the separator is the value, however many words it is:
    // `Authorization: Bearer t0ken` is one argument, not three.
    if (introduces && CREDENTIAL_KEY.test(name) && inner.length > at + 1) {
      return { text: `${q}${inner.slice(0, at + 1)}${HIDDEN}${q}`, hideNext: false };
    }
    // A separator with nothing after it deliberately does NOT reach across the
    // whitespace here, though it does between array elements. An array element
    // is an argv token; a word in a string is just a word, and "Authorization:
    // failed" in a sentence must not blank the next one. The shapes a shell
    // actually produces -- a quoted header, `NAME=value` -- are same-token and
    // are caught above.
    return { text: token, hideNext: false };
  }
  if (at < 0 && OPTION_FLAG.test(inner) && CREDENTIAL_KEY.test(inner)) {
    return { text: token, hideNext: true };
  }
  return { text: token, hideNext: false };
}

/**
 * Hide credentials inside a string that is a command line.
 *
 * The array fence below guards `["--api-key", "abc123"]`, a shape nothing in
 * this build writes. The shape it does write is this one: `bash` is not in
 * `activity-hooks`' `NOISY_TOOLS`, its args are `{command: "<the whole command
 * line>"}`, and `redactArgs` there redacts by key name only -- so `command` is
 * not a credential key and the entire line, secret included, reaches the log
 * and this panel.
 *
 * Same discrimination as the array path and no wider: a leading dash, or a
 * credential-stemmed name before an `=` or a `:`. A bare word never introduces
 * anything, so a results listing or a sentence is left alone -- which is the
 * regression this fence has already had once.
 */
export function redactCommandText(text: string): string {
  // Nothing credential-shaped anywhere in it: the common case, and tokenizing
  // every log line to discover that is not worth it.
  if (!CREDENTIAL_KEY.test(text)) return text;
  let hideNext = false;
  return shellTokens(text)
    .map((part) => {
      if (part === "" || /^\s$/.test(part)) return part;
      if (hideNext) {
        hideNext = false;
        return HIDDEN;
      }
      const token = redactShellToken(part);
      hideNext = token.hideNext;
      return token.text;
    })
    .join("");
}

const EMPTY_TEXT =
  "Nothing yet. Every step the agent takes -- a command, a Galaxy run finishing, a decision it " +
  "had to make -- lands here as it happens.";
/**
 * `available: false` means three things at once -- the shell has no file read,
 * the read failed, and activity.jsonl does not exist yet -- and the third is
 * what every brand-new analysis looks like. Naming the first was a false claim
 * about the window on the common path, made in the same window whose File pane
 * was reading files at that moment. Until the source separates them this says
 * only what is true of all three.
 */
const UNAVAILABLE_TEXT =
  "Nothing to show from the analysis log yet -- either nothing has been written, or this window " +
  "cannot read it. It is being written to activity.jsonl next to the notebook either way.";
const NO_MATCH_TEXT = "Nothing in the log matches that filter.";

export type ActivityTone = "info" | "ok" | "failed" | "running" | "blocked" | "unknown";

const GLYPHS: Record<ActivityTone, string> = {
  info: "·",
  ok: "✓",
  failed: "✕",
  running: "●",
  blocked: "⊘",
  unknown: "?",
};

export interface ActivityRow {
  key: string;
  time: string;
  /** Day label when this row starts a new day, else null. */
  day: string | null;
  tone: ActivityTone;
  text: string;
  detail: string;
}

// -- Text hygiene ------------------------------------------------------------

/**
 * Control characters would break a one-line row, and the bidi overrides would
 * let a tool argument render in an order it was not written in -- a log that
 * shows `rm -rf /` as something else is worse than no log. Shared, because the
 * results gallery has untrusted names to draw for the same reason.
 */
function flatten(value: string): string {
  // The collapse and trim are this panel's own: a log row is one line of prose,
  // and a run of stripped controls should not leave a gutter in the middle of
  // it. A filename gets `safeName` without them.
  return safeName(value).replace(/ {2,}/g, " ").trim();
}

/**
 * Truncates on code points, so a cap never lands inside a surrogate pair. The
 * code-unit slice first is not an optimisation detail: one line of the log can
 * be megabytes of tool output, and expanding all of it into an array of
 * characters to keep 400 of them costs real time on every redraw. A code point
 * is at most two code units, so `max * 2` always contains at least `max` of them.
 */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const head = Array.from(value.slice(0, max * 2));
  // `head` is the whole string only when the slice could not have cut it short.
  if (value.length <= max * 2 && head.length <= max) return value;
  return head.slice(0, max).join("") + "…";
}

function strOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function isTrue(value: unknown): boolean {
  return value === true || value === "true";
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

// -- Config coercion ---------------------------------------------------------

/**
 * Config arrives from the layout document, which can be hand-edited or written
 * by a model, so none of these three can be trusted to be the declared type.
 */
export function normalizeMaxEntries(value: unknown): number {
  // Only a number, or a string that is one. `Number(null)`, `Number([])` and
  // `Number(false)` are all a finite 0, which the clamp below would turn into a
  // one-row panel -- and `"maxEntries": null` is an ordinary thing for a model
  // to write.
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n)) return DEFAULT_MAX_ENTRIES;
  return Math.min(MAX_ENTRIES_CEILING, Math.max(1, Math.floor(n)));
}

/**
 * `null` means no filter. An empty list means no filter too: `kinds: []` is far
 * more likely to be someone reaching for "no filter" than a deliberate request
 * for a panel that can never draw anything.
 */
export function normalizeKinds(value: unknown): Set<string> | null {
  if (!Array.isArray(value)) return null;
  const kinds = new Set(value.filter((k): k is string => typeof k === "string" && k.length > 0));
  return kinds.size > 0 ? kinds : null;
}

export function normalizeBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

// -- Time --------------------------------------------------------------------

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function parseTimestamp(iso: string): Date | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export function formatEventTime(iso: string): string {
  const date = parseTimestamp(iso);
  if (!date) return "--:--:--";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** `Thu 18 Sep`, or null when the timestamp is unusable. */
export function formatEventDay(iso: string): string | null {
  const date = parseTimestamp(iso);
  if (!date) return null;
  return `${DAY_NAMES[date.getDay()]} ${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`;
}

// -- Plain language ----------------------------------------------------------

/**
 * Galaxy's own words, in the user's. `deleting` / `deleted` / `stop` are
 * transitional and are NOT a failure -- calling them one is how a cancelled run
 * turns into a panic.
 */
export function statusWord(raw: string): string {
  switch (raw.toLowerCase()) {
    case "new":
    case "queued":
    case "waiting":
      return "waiting for Galaxy";
    case "running":
    case "in_progress":
      return "running";
    case "ok":
    case "complete":
    case "completed":
      return "finished";
    case "error":
    case "failed":
      return "failed";
    case "paused":
      return "paused";
    case "deleting":
    case "deleted":
    case "stop":
    case "stopped":
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "skipped":
      return "skipped";
    default:
      return raw ? raw : "in a state Galaxy did not name";
  }
}

/** `(11 ok, 1 failed)` from the poller's counters, skipping anything at zero. */
function countsPhrase(counters: unknown): string {
  if (counters === null || typeof counters !== "object" || Array.isArray(counters)) return "";
  const c = counters as Record<string, unknown>;
  const parts: string[] = [];
  const add = (key: string, word: string): void => {
    const n = c[key];
    if (typeof n === "number" && Number.isFinite(n) && n > 0) parts.push(`${n} ${word}`);
  };
  add("ok", "ok");
  add("running", "running");
  add("queued", "queued");
  add("error", "failed");
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function stepsPhrase(steps: string[]): string {
  if (steps.length === 0) return "a step";
  if (steps.length === 1) return `"${steps[0]}"`;
  return `${steps.length} steps`;
}

/**
 * One sentence per event kind. An unrecognised kind falls through to the raw
 * kind and source, which is honest and cannot throw -- new kinds get added to
 * the brain without this file knowing, and a widget that threw on one would
 * take the whole panel down for something that is not an error.
 */
export function summarizeEvent(event: ActivityEvent): { text: string; tone: ActivityTone } {
  let out: { text: string; tone: ActivityTone };
  try {
    out = describe(event, event.payload ?? {});
  } catch {
    // Nothing a `JSON.parse` produces can throw on a property read, so this is
    // for the next caller rather than this one -- but the panel's contract is
    // that one bad row does not take the log down, and it should hold for
    // whatever a future source hands over.
    out = { text: strOf(event.kind) || "event", tone: "unknown" };
  }
  return { text: truncate(flatten(out.text), SUMMARY_MAX), tone: out.tone };
}

function describe(
  event: ActivityEvent,
  p: Record<string, unknown>,
): { text: string; tone: ActivityTone } {
  switch (event.kind) {
    case "session.started": {
      const cwd = strOf(p.cwd);
      const folder = cwd.split(/[\\/]/).filter(Boolean).pop() ?? "";
      return {
        tone: "info",
        text: folder ? `Opened this analysis in ${folder}` : "Opened this analysis",
      };
    }

    case "user.prompt": {
      // `source` is pi's `InputSource`, which is `interactive` (a terminal),
      // `rpc` (Orbit) or `extension` (the brain prompting itself, e.g. the
      // Galaxy poller's resume). There is no "user": guessing one here told
      // every Orbit user that their own message came from somewhere else.
      const who =
        event.source === "interactive" || event.source === "rpc" || event.source === ""
          ? "You asked"
          : event.source === "extension"
            ? "Loom followed up"
            : "A prompt arrived";
      const text = strOf(p.text);
      return { tone: "info", text: text ? `${who}: ${text}` : `${who}, with no text recorded` };
    }

    case "tool.start":
      return { tone: "running", text: `Started ${strOf(p.toolName) || "a tool"}` };

    case "tool.end": {
      const tool = strOf(p.toolName) || "a tool";
      return isTrue(p.isError)
        ? { tone: "failed", text: `${tool} failed` }
        : { tone: "ok", text: `Finished ${tool}` };
    }

    case "poll.transition": {
      const thing = p.blockKind === "job" ? "job" : "workflow run";
      const label = strOf(p.label) || strOf(p.id) || "a run";
      const to = strOf(p.to).toLowerCase();
      const counts = countsPhrase(p.counters);
      const subject = `Galaxy ${thing} "${label}"`;
      if (to === "completed" || to === "ok") {
        return { tone: "ok", text: `${subject} finished${counts}` };
      }
      if (to === "failed" || to === "error") {
        return { tone: "failed", text: `${subject} failed${counts}` };
      }
      const word = statusWord(to);
      if (word === "cancelled") return { tone: "info", text: `${subject} was cancelled` };
      if (word === "skipped") return { tone: "info", text: `${subject} was skipped` };
      // Not "running": a paused run is waiting on the person, not on Galaxy.
      if (word === "paused") return { tone: "blocked", text: `${subject} is paused and needs you` };
      return { tone: "running", text: `${subject} is now ${word}${counts}` };
    }

    case "poll.block_missing": {
      const label = strOf(p.label) || strOf(p.id) || "a run";
      const state = strOf(p.galaxyState);
      const tail = state ? `, and Galaxy still says it is ${statusWord(state)}` : "";
      return {
        tone: "blocked",
        text: `Stopped following "${label}" -- its record is gone from the notebook${tail}`,
      };
    }

    case "evidence.decision": {
      const steps = stepsPhrase(strList(p.completions));
      const clashes = Array.isArray(p.contradictions) ? p.contradictions.length : 0;
      const runs = clashes === 1 ? "that Galaxy run" : "those Galaxy runs";
      switch (strOf(p.outcome)) {
        case "blocked":
          return {
            tone: "blocked",
            text: `Refused to mark ${steps} done -- ${runs} did not succeed`,
          };
        case "warned":
          return {
            tone: "blocked",
            text: `Marked ${steps} done even though ${runs} did not succeed`,
          };
        case "overridden":
          return { tone: "info", text: `Marked ${steps} done, using the override you granted` };
        case "recorded":
          return { tone: "ok", text: `Marked ${steps} done -- nothing on Galaxy contradicts it` };
        default:
          return { tone: "info", text: `Checked the Galaxy evidence for ${steps}` };
      }
    }

    case "evidence.override": {
      const step = strOf(p.step) || "a step";
      return {
        tone: "info",
        text: `You allowed "${step}" to be marked done without Galaxy confirming it`,
      };
    }

    case "guard.decision": {
      const tool = strOf(p.toolName) || "a command";
      const outcome = strOf(p.outcome);
      const head = outcome.split(":")[0];
      if (head === "blocked") {
        if (/user|declined/.test(outcome)) {
          return { tone: "blocked", text: `You declined ${tool}` };
        }
        const reason = truncate(strOf(p.reason), REASON_MAX);
        return { tone: "blocked", text: `Blocked ${tool}${reason ? ` -- ${reason}` : ""}` };
      }
      if (head === "allowed") {
        if (outcome === "allowed") return { tone: "info", text: `Allowed ${tool}` };
        if (outcome === "allowed:session") {
          return { tone: "info", text: `Allowed ${tool} -- you approved it earlier this session` };
        }
        return { tone: "info", text: `You approved ${tool}` };
      }
      return { tone: "info", text: `Checked ${tool} before running it` };
    }

    default: {
      const kind = strOf(event.kind) || "event";
      const source = strOf(event.source);
      return { tone: "unknown", text: source ? `${kind} (${source})` : kind };
    }
  }
}

// -- The credential fence ----------------------------------------------------

/**
 * Copy a payload for display: credential-shaped keys keep their name and lose
 * their value, strings are capped, cycles are cut, and anything JSON cannot
 * carry is dropped. Bounded in depth, in breadth and in total nodes, because
 * the input is a file on disk that the user or a model can write -- and
 * because cutting a cycle is not the same as bounding a shared subtree, which
 * is what `DETAIL_NODES_MAX` is for.
 */
export function redactForDisplay(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
  budget: { left: number } = { left: DETAIL_NODES_MAX },
): unknown {
  if (value === null) return null;
  const t = typeof value;
  // Redact the text that will be shown, not the text that arrived: truncating
  // first bounds the work on a huge string, and anything the cut removed was
  // never going to be on screen.
  if (t === "string") return redactCommandText(truncate(value as string, DETAIL_STRING_MAX));
  if (t === "number") return Number.isFinite(value) ? value : String(value);
  if (t === "boolean") return value;
  if (t === "bigint") return String(value);
  if (t !== "object") return undefined;

  const obj = value as object;
  if (seen.has(obj)) return "[circular]";
  if (depth >= DETAIL_DEPTH_MAX) return "[…]";
  if (budget.left <= 0) return "[…]";
  budget.left--;
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const items: unknown[] = [];
      let hideNext = false;
      for (const v of obj.slice(0, DETAIL_KEYS_MAX)) {
        // Whatever the name introduces, of whatever type. An argv value is a
        // string, but blanking a structured element here costs a reader one
        // click and showing one could cost them a key.
        if (hideNext) {
          hideNext = false;
          items.push(HIDDEN);
          continue;
        }
        if (typeof v !== "string") {
          items.push(redactForDisplay(v, depth + 1, seen, budget));
          continue;
        }
        // The element first as a command line -- an argv array can hold one,
        // `["bash", "-c", "curl -H '...'"]` -- then as a single argv token,
        // which is what carries `hideNext` to the element after it.
        const token = redactToken(redactCommandText(v));
        hideNext = token.hideNext;
        items.push(token.text);
      }
      return items;
    }
    const out: Record<string, unknown> = {};
    // defineProperty rather than assignment: `JSON.parse` makes `__proto__` an
    // own property, and plain assignment would hand an attacker-chosen object
    // to the accumulator's prototype and drop the key from the display.
    const put = (key: string, value: unknown): void => {
      Object.defineProperty(out, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    };
    let n = 0;
    for (const [key, v] of Object.entries(obj as Record<string, unknown>)) {
      if (n++ >= DETAIL_KEYS_MAX) {
        put("[truncated]", "more keys not shown");
        break;
      }
      // The key is capped as well as the value: a payload can use a whole
      // secret as a key name, and while the fence cannot hide one -- a Galaxy
      // job id has the same shape, and blanking those would cost the reader
      // the most useful line in the block -- it can stop one filling the row.
      put(
        truncate(key, DETAIL_KEY_MAX),
        CREDENTIAL_KEY.test(key) ? HIDDEN : redactForDisplay(v, depth + 1, seen, budget),
      );
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/** The raw event, redacted and capped, for the disclosure under a row. */
export function formatDetail(event: ActivityEvent): string {
  const head = [`kind: ${strOf(event.kind)}`, `source: ${strOf(event.source)}`];
  if (event.timestamp) head.push(`time: ${strOf(event.timestamp)}`);
  let body: string;
  try {
    body = JSON.stringify(redactForDisplay(event.payload ?? {}), null, 2) ?? "{}";
  } catch {
    body = "(this entry's raw record could not be read)";
  }
  return truncate(`${head.join("\n")}\n${body}`.replace(UNSAFE_BLOCK, " "), DETAIL_TOTAL_MAX);
}

// -- Row building ------------------------------------------------------------

/**
 * The field that actually tells two events written in the same millisecond
 * apart. Without one, the occurrence counter is all there is, and the counter
 * is renumbered when an older twin falls out of the 200-event tail -- the
 * survivor inherits the departed row's place in the expanded set and opens a
 * disclosure nobody asked for.
 */
function discriminator(payload: Record<string, unknown>): string {
  for (const field of ["toolCallId", "id", "invocationId", "step"]) {
    const value = payload[field];
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

/**
 * Keys are assigned over the list before the text filter runs, so a row keeps
 * its identity while the filter hides its neighbours -- that is what lets an
 * entry the user opened still be open after they clear the filter. (The `kinds`
 * filter could not renumber anything either way, since the kind is part of the
 * key.)
 */
export function buildRows(
  events: readonly ActivityEvent[],
  config: Partial<ActivityConfig>,
  filterText = "",
): ActivityRow[] {
  const kinds = normalizeKinds(config.kinds);
  const max = normalizeMaxEntries(config.maxEntries);
  const withDetail = normalizeBool(config.showDetail, true);
  const needle = flatten(filterText).toLowerCase();

  const seen = new Map<string, number>();
  const kept: Array<{ event: ActivityEvent; key: string }> = [];
  for (const event of events) {
    const base = `${event.timestamp}|${event.kind}|${event.source}|${discriminator(event.payload ?? {})}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    if (kinds && !kinds.has(event.kind)) continue;
    kept.push({ event, key: `${base}|${n}` });
  }

  const matched: Array<{ event: ActivityEvent; key: string; text: string; tone: ActivityTone }> =
    [];
  for (const { event, key } of kept) {
    const { text, tone } = summarizeEvent(event);
    if (needle && !`${text} ${event.kind} ${event.source}`.toLowerCase().includes(needle)) continue;
    matched.push({ event, key, text, tone });
  }

  // Cap before formatting the detail, not after: serialising 200 payloads to
  // throw 195 of them away is work done on every redraw for nothing.
  const capped: ActivityRow[] = matched.slice(-max).map(({ event, key, text, tone }) => ({
    key,
    time: formatEventTime(event.timestamp),
    day: formatEventDay(event.timestamp),
    tone,
    text,
    detail: withDetail ? formatDetail(event) : "",
  }));

  // Day labels are decided after the cap, so the first visible row always
  // carries one -- a log whose newest entry is from last Thursday should say so.
  let previousDay: string | null = null;
  for (const row of capped) {
    const day = row.day;
    row.day = day && day !== previousDay ? day : null;
    if (day) previousDay = day;
  }
  return capped;
}

// -- Auto-scroll -------------------------------------------------------------

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Is the view close enough to the bottom to keep following? A panel on a hidden
 * tab measures 0/0/0, which comes out as "yes" -- the right answer, because it
 * has not been scrolled away from anything.
 */
export function isAtBottom(m: ScrollMetrics, threshold = STICK_THRESHOLD_PX): boolean {
  const distance = m.scrollHeight - m.clientHeight - m.scrollTop;
  if (!Number.isFinite(distance)) return true;
  return distance <= threshold;
}

// -- The widget --------------------------------------------------------------

/**
 * What a panel has to remember across a remount.
 *
 * `ctx.setConfig` goes through the host's `setDocument`, which re-renders the
 * whole dashboard and remounts every widget. So one click on `detail` used to
 * throw away the filter the user had typed, every entry they had opened and
 * where they were reading -- none of which is in the document, and none of
 * which they asked to lose. Keyed by panel id, which is unique within a
 * dashboard; two dashboards that both name a panel `p-activity` share an entry,
 * which is worth a great deal less than losing the filter on every click.
 */
interface PanelMemory {
  filter: string;
  expanded: Set<string>;
  following: boolean;
  scrollTop: number;
}

const panelMemory = new Map<string, PanelMemory>();
/** A document holds at most 40 panels; this is only here so nothing is unbounded. */
const PANEL_MEMORY_MAX = 64;

function memoryFor(panelId: string): PanelMemory {
  const existing = panelMemory.get(panelId);
  if (existing) return existing;
  const fresh: PanelMemory = { filter: "", expanded: new Set(), following: true, scrollTop: 0 };
  panelMemory.set(panelId, fresh);
  while (panelMemory.size > PANEL_MEMORY_MAX) {
    const oldest = panelMemory.keys().next().value;
    if (oldest === undefined) break;
    panelMemory.delete(oldest);
  }
  return fresh;
}

function span(className: string, text: string): HTMLSpanElement {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
}

export const activityWidget: WidgetDefinition<ActivityConfig> = {
  type: "activity",
  label: "Analysis log",
  description: "What the agent has done in this analysis, in order.",
  defaultConfig: { kinds: "all", maxEntries: DEFAULT_MAX_ENTRIES, showDetail: true },

  mount(el, ctx): WidgetDispose {
    el.classList.add("dash-activity");

    const trim = document.createElement("p");
    trim.className = "dash-activity-trim";
    trim.hidden = true;

    const scroller = document.createElement("div");
    scroller.className = "dash-activity-scroll";
    const list = document.createElement("div");
    list.className = "dash-activity-list";
    // Not role="log": that is an implicit polite live region, and this list is
    // rebuilt whole on every update, so a screen reader would re-read the
    // entire log each time anything happened.
    list.setAttribute("role", "region");
    list.setAttribute("aria-label", "Analysis log");
    scroller.append(list);

    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "dash-panel-btn dash-activity-jump";
    jump.textContent = "Jump to latest";
    jump.hidden = true;
    el.append(trim, scroller, jump);

    // Held outside the mount, not in the panel config: a config write re-renders
    // the whole dashboard, so persisting the filter would remount the widget on
    // every keystroke -- and a remount must not lose it either.
    const memory = memoryFor(ctx.panelId);
    let filterText = memory.filter;
    // Which rows the user has opened, by the stable key `buildRows` assigns, so
    // an open disclosure survives the rebuild that the next event causes.
    const expanded = memory.expanded;
    let following = memory.following;
    let firstDraw = true;
    let latest: readonly ActivityEvent[] = [];
    let latestAvailable = false;

    const filter = document.createElement("input");
    filter.type = "search";
    filter.className = "dash-activity-filter";
    filter.placeholder = "filter";
    filter.setAttribute("aria-label", "Filter the analysis log");

    // Through the same coercion the rows use, or a document saying
    // `"showDetail": "false"` gets a button that reads "on" over rows that are
    // off, and one click that appears to do nothing.
    const showingDetail = normalizeBool(ctx.config.showDetail, true);
    const detailBtn = document.createElement("button");
    detailBtn.type = "button";
    detailBtn.className = "dash-panel-btn";
    detailBtn.textContent = "detail";
    detailBtn.classList.toggle("active", showingDetail);
    detailBtn.title = showingDetail
      ? "Hide the raw record under each entry"
      : "Show the raw record under each entry";
    detailBtn.setAttribute("aria-pressed", showingDetail ? "true" : "false");
    detailBtn.addEventListener("click", () => ctx.setConfig({ showDetail: !showingDetail }));
    ctx.header.append(filter, detailBtn);

    const scrollToLatest = (): void => {
      scroller.scrollTop = scroller.scrollHeight;
    };

    const paintJump = (): void => {
      jump.hidden = following;
    };

    const note = (text: string): HTMLElement => {
      const p = document.createElement("p");
      p.className = "dash-activity-note";
      p.textContent = text;
      return p;
    };

    const rowNode = (row: ActivityRow): HTMLElement => {
      const parts = [
        span("dash-activity-time", row.time),
        span("dash-activity-glyph", GLYPHS[row.tone]),
        span("dash-activity-text", row.text),
      ];
      const classes = `dash-activity-row dash-activity-tone-${row.tone}`;
      if (!row.detail) {
        const plain = document.createElement("div");
        plain.className = `${classes} dash-activity-row-plain`;
        plain.append(...parts);
        return plain;
      }
      const details = document.createElement("details");
      details.className = classes;
      if (expanded.has(row.key)) details.open = true;
      const summary = document.createElement("summary");
      summary.append(...parts);
      const pre = document.createElement("pre");
      pre.className = "dash-activity-detail";
      pre.textContent = row.detail;
      details.append(summary, pre);
      details.addEventListener("toggle", () => {
        if (!details.open) {
          expanded.delete(row.key);
          return;
        }
        expanded.add(row.key);
        // Bounded rather than pruned to what is on screen: a filter hides rows
        // for a moment and the user expects them still open when it is cleared.
        // A Set keeps insertion order, so the oldest one opened goes first.
        while (expanded.size > EXPANDED_MAX) {
          const oldest = expanded.values().next().value;
          if (oldest === undefined) break;
          expanded.delete(oldest);
        }
      });
      return details;
    };

    const setTrim = (text: string): void => {
      trim.textContent = text;
      trim.hidden = text === "";
    };

    const draw = (): void => {
      // Emptying the list collapses the scroll height, and the browser clamps
      // scrollTop to 0 for us. Put the reader back where they were, or this
      // rebuilds them to the bottom every time the log grows. On the first draw
      // after a remount there is nothing on screen to read the position from,
      // so it comes out of the panel's memory instead.
      const wasAt = firstDraw ? memory.scrollTop : scroller.scrollTop;
      list.textContent = "";
      const finish = (): void => {
        firstDraw = false;
        if (following) scrollToLatest();
        else scroller.scrollTop = wasAt;
        // Re-read rather than trust the last scroll event: the content may have
        // shrunk to fit, in which case there is no bottom to be away from and
        // no scroll event is coming to say so. A panel with no height yet knows
        // nothing, so it keeps whatever it had.
        if (scroller.clientHeight > 0) following = isAtBottom(scroller);
        memory.following = following;
        memory.scrollTop = scroller.scrollTop;
        paintJump();
      };

      if (!latestAvailable) {
        setTrim("");
        list.append(note(UNAVAILABLE_TEXT));
        finish();
        return;
      }
      if (latest.length === 0) {
        setTrim("");
        list.append(note(EMPTY_TEXT));
        finish();
        return;
      }
      const rows = buildRows(latest, ctx.config, filterText);
      if (rows.length === 0) {
        setTrim("");
        list.append(note(NO_MATCH_TEXT));
        finish();
        return;
      }
      setTrim(
        rows.length < latest.length ? `Showing ${rows.length} of ${latest.length} entries.` : "",
      );
      for (const row of rows) {
        if (row.day) {
          const day = document.createElement("div");
          day.className = "dash-activity-day";
          day.textContent = row.day;
          list.append(day);
        }
        list.append(rowNode(row));
      }
      finish();
    };

    filter.value = filterText;
    filter.addEventListener("input", () => {
      filterText = filter.value;
      memory.filter = filterText;
      // A new filter is a new list, and the user asked for it: go back to the end.
      following = true;
      draw();
    });

    const onScroll = (): void => {
      following = isAtBottom(scroller);
      memory.following = following;
      memory.scrollTop = scroller.scrollTop;
      paintJump();
    };
    scroller.addEventListener("scroll", onScroll);
    ctx.onDispose(() => scroller.removeEventListener("scroll", onScroll));

    jump.addEventListener("click", () => {
      following = true;
      memory.following = true;
      scrollToLatest();
      paintJump();
    });

    ctx.subscribe(ctx.sources.activity, (snapshot) => {
      latest = snapshot.events;
      latestAvailable = snapshot.available;
      draw();
    });

    if (typeof ResizeObserver !== "undefined") {
      let lastHeight = 0;
      const observer = new ResizeObserver(() => {
        const height = scroller.clientHeight;
        if (height === 0) return;
        // The panel has no height while its tab is hidden, so the scroll in
        // `draw` landed on a scrollHeight of 0 and the newest entry is not what
        // the user sees when they switch to the Dashboard tab.
        if (lastHeight === 0) {
          if (following) scrollToLatest();
          else scroller.scrollTop = memory.scrollTop;
        }
        // Growing the panel can make the whole list fit, and no scroll event
        // will arrive to say the reader is no longer away from the bottom --
        // which would leave "Jump to latest" on screen with nothing to do.
        following = isAtBottom(scroller);
        memory.following = following;
        lastHeight = height;
        paintJump();
      });
      observer.observe(scroller);
      ctx.onDispose(() => observer.disconnect());
    }

    return () => {
      el.classList.remove("dash-activity");
      el.textContent = "";
    };
  },
};
