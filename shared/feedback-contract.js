// Shared feedback wire contract. Dual-file (.js runtime + .d.ts types) to match
// team-dispatch-contract: the brain resolves a real .js at runtime, so a single
// .ts would risk a missing runtime file. No Node imports here -- this file is
// renderer-safe and shared by the brain, Orbit main, and (by copy) the worker.

export const SCHEMA_VERSION = 1;
export const FEEDBACK_ROUTE = "/feedback";
export const FEEDBACK_KEY_HEADER = "X-Orbit-Feedback-Key";

// Production endpoint base (no trailing slash). Set after `wrangler deploy` of
// the orbit-feedback worker. Clients may override via the LOOM_FEEDBACK_URL env
// var for local dev.
export const FEEDBACK_ENDPOINT_URL = "https://orbit-feedback.dannon-baker.workers.dev";

const SOURCES = new Set(["orbit", "loom-cli"]);

export function validateFeedbackPayload(obj) {
  if (typeof obj !== "object" || obj === null) return false;
  const p = obj;
  if (p.schemaVersion !== SCHEMA_VERSION) return false;
  if (typeof p.source !== "string" || !SOURCES.has(p.source)) return false;
  if (typeof p.title !== "string" || p.title.trim().length === 0) return false;
  if (typeof p.body !== "string") return false;
  if (typeof p.clientTs !== "string") return false;
  // testerId is optional; when present it must be a string (opaque tester code).
  if (p.testerId !== undefined && typeof p.testerId !== "string") return false;
  return true;
}

const ACTIVITY_TAIL_MAX_BYTES = 64 * 1024;
// Per-field character limits (not bytes) for readability; the wire byte budget
// is enforced separately by trimLinesToBytes.
const ARGS_MAX = 200;
const RESULT_MAX = 500;
const PROMPT_MAX = 200;

const textEncoder = new TextEncoder();

function byteLen(s) {
  return textEncoder.encode(s).length;
}

function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function compactArgs(args) {
  if (args == null) return "";
  let s;
  try {
    s = JSON.stringify(args);
  } catch {
    s = String(args);
  }
  return s ? "args=" + truncate(s, ARGS_MAX) : "";
}

// One line per event. Renders the already-redacted/truncated payload fields the
// upstream activity hooks produced -- this function adds no redaction of its own.
// Embedded line breaks (LF, CRLF, or bare CR from progress-style output) are
// flattened to spaces so each event stays exactly one line, which keeps the
// byte-budget trimmer from orphaning a fragment of a multi-line event.
function formatActivityEvent(e) {
  const ts = e && e.timestamp ? e.timestamp : "?";
  const p = (e && e.payload) || {};
  let rawLine;
  switch (e && e.kind) {
    case "user.prompt":
      rawLine = `${ts} user.prompt ${truncate(String(p.text ?? ""), PROMPT_MAX)}`;
      break;
    case "tool.start":
      rawLine = `${ts} tool.start ${p.toolName ?? "?"} ${compactArgs(p.args)}`;
      break;
    case "tool.end": {
      const flag = p.isError ? "✗" : "✓";
      rawLine = `${ts} tool.end ${p.toolName ?? "?"} ${flag} ${truncate(String(p.resultSummary ?? ""), RESULT_MAX)}`;
      break;
    }
    default:
      rawLine = `${ts} ${(e && e.kind) ?? "?"}${e && e.source ? " (" + e.source + ")" : ""}`;
      break;
  }
  return rawLine.trimEnd().replace(/[\r\n]+/g, " ");
}

// Drop oldest (leading) lines until the text fits maxBytes; hard-slice a lone
// over-budget line as a floor.
function trimLinesToBytes(text, maxBytes) {
  if (byteLen(text) <= maxBytes) return text;
  const lines = text.split("\n");
  while (lines.length > 1 && byteLen(lines.join("\n")) > maxBytes) {
    lines.shift();
  }
  let out = lines.join("\n");
  if (byteLen(out) > maxBytes) {
    // Binary search for the maximum prefix of 'out' that fits in maxBytes
    // using character offsets to avoid splitting Unicode surrogate pairs.
    const arr = Array.from(out);
    let low = 0;
    let high = arr.length;
    let best = "";
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = arr.slice(0, mid).join("");
      if (byteLen(candidate) <= maxBytes) {
        best = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    out = best;
  }
  return out;
}

export function formatActivityTail(events, opts = {}) {
  const maxBytes = opts.maxBytes ?? ACTIVITY_TAIL_MAX_BYTES;
  const text = (events || []).map(formatActivityEvent).join("\n");
  return trimLinesToBytes(text, maxBytes);
}

const FEEDBACK_MAX_TOTAL_BYTES = 200 * 1024;

// Final guard so an assembled payload never bounces off the worker's 256 KB cap.
// Trim activityTail before shellTail -- the shell tail is closest to what the user
// actually saw, so it's the last diagnostic we shed. Title/body always stay intact.
export function capFeedbackPayload(payload, opts = {}) {
  const maxTotalBytes = opts.maxTotalBytes ?? FEEDBACK_MAX_TOTAL_BYTES;
  const totalBytes = (p) => byteLen(JSON.stringify(p));
  let p = { ...payload };
  for (const field of ["activityTail", "shellTail"]) {
    const total = totalBytes(p);
    if (total <= maxTotalBytes) break;
    if (typeof p[field] !== "string" || p[field].length === 0) continue;
    const over = total - maxTotalBytes;
    const target = Math.max(0, byteLen(p[field]) - over);
    p = { ...p, [field]: trimLinesToBytes(p[field], target) };
  }
  return p;
}
