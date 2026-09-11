/**
 * Telling a deterministic startup failure apart from a crash, and turning the
 * brain's own stderr into something a shell can show.
 *
 * #439: every nonzero exit looked identical to Orbit, so a missing credential
 * got three silent restarts and a generic "crashed repeatedly" box while the
 * brain's perfectly clear explanation sat unread in a stderr buffer. Retrying a
 * config problem cannot fix it -- it only buries the reason under two more
 * attempts.
 */

/**
 * sysexits.h EX_CONFIG. The brain exits with this when it has diagnosed the
 * problem and knows another attempt will reach the same conclusion: no usable
 * credential, a key it can't decrypt, a provider that needs a sign-in nobody
 * has done. Distinct from 1, which stays "something went wrong" and is what an
 * unhandled throw or a pi-side failure still produces.
 */
export const EX_CONFIG = 78;

/** Should a shell suppress its retry budget for this exit code? */
export function isConfigFailure(code) {
  return code === EX_CONFIG;
}

/**
 * How much of the brain's stderr a shell keeps. The buffer exists to explain a
 * failure, and only the end of it does that, so it holds a window rather than
 * the whole stream -- a long session logs to stderr indefinitely, and a shell
 * that concatenates without a bound is just a slow leak.
 */
export const STDERR_BUFFER_LIMIT = 64 * 1024;

/** Append to a rolling stderr buffer, discarding from the front past the limit. */
export function appendStderr(buffer, text, limit = STDERR_BUFFER_LIMIT) {
  const next = `${buffer ?? ""}${text ?? ""}`;
  return next.length <= limit ? next : next.slice(next.length - limit);
}

// Escape-anchored on purpose: matching a bare "[0m"-shaped run would eat
// ordinary bracketed prose out of an error message.
const ANSI_PATTERN = /\[[0-9;]*[A-Za-z]/g;

/**
 * The tail of a stderr buffer, shaped for a chat pane.
 *
 * Tail rather than head because the fatal message is the last thing written
 * before the process exits -- anything earlier is startup noise. Generous
 * enough (40 lines) to keep the headline of the brain's longest credential
 * message attached to the fix hint under it, since a hint whose first line has
 * been cut off explains nothing.
 */
export function stderrTail(stderr, { maxLines = 40, maxChars = 2000 } = {}) {
  if (typeof stderr !== "string") return "";
  const lines = stderr
    .replace(ANSI_PATTERN, "")
    .split("\n")
    .map((line) => line.trimEnd());
  // Blank lines inside the message are load-bearing (they separate the headline
  // from the hint block); only the padding at either end goes.
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return "";

  let kept = lines.slice(-maxLines);
  let truncated = kept.length < lines.length;
  let text = kept.join("\n");
  while (text.length > maxChars && kept.length > 1) {
    kept = kept.slice(1);
    truncated = true;
    text = kept.join("\n");
  }
  // A single line longer than the cap still has to fit somewhere.
  if (text.length > maxChars) {
    text = text.slice(text.length - maxChars);
    truncated = true;
  }
  return truncated ? `[...]\n${text}` : text;
}

/**
 * Squeeze a failure down to one line for the footer status pill.
 *
 * The pill is width-capped and renders as a single run of text, so a multi-line
 * message arrives there as an unreadable marquee -- and for an "error" status
 * Orbit overrides the hover tooltip with "Click to open Preferences", so the
 * long form has nowhere to hide either. The brain hard-wraps its messages for a
 * terminal, so this unwraps the first paragraph rather than taking line one and
 * cutting mid-sentence.
 */
function badgeSummary(detail, maxChars = 160) {
  const paragraph = [];
  for (const line of detail.split("\n")) {
    if (!line.trim()) {
      if (paragraph.length) break; // end of the first paragraph
      continue; // padding before it
    }
    paragraph.push(line.trim());
  }
  let text = stripCliPrefix(
    paragraph
      .join(" ")
      .replace(/^\[\.\.\.\]\s*/, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}...` : text;
}

/**
 * Drop the brain's "loom:" argv0 prefix and re-capitalize what follows.
 *
 * Essential in a terminal, where it says which program is talking; noise in a
 * GUI, where the message is already inside a labelled error card. Applied to
 * both the pill and the chat text so one sentence doesn't appear two ways in
 * the same window.
 */
function stripCliPrefix(text) {
  const stripped = text.replace(/^loom:\s*/i, "");
  if (!stripped) return "";
  return stripped[0].toUpperCase() + stripped.slice(1);
}

/**
 * What a shell shows when the brain fails to start, split by where it goes.
 *
 * `detail` is the brain's own words -- it already knows which of the four
 * credential situations it hit and printed the fix for that one, so a generic
 * shell message would be strictly worse. It belongs in the chat pane, which
 * renders multi-line text. `summary` is the same failure at pill length.
 *
 * The fallbacks only cover a child that died saying nothing at all.
 */
export function summarizeStartupFailure(code, stderr) {
  const raw = stderrTail(stderr);
  // Only the first line carries the prefix; the wrapped continuation and the
  // fix hint below it are left exactly as the brain wrote them.
  const [head, ...rest] = raw.split("\n");
  const detail = raw ? [stripCliPrefix(head), ...rest].join("\n") : raw;
  if (!detail) {
    const fallback = isConfigFailure(code)
      ? "The agent couldn't start: it found no usable LLM credential. Open Preferences to set one."
      : `The agent exited with code ${code} without reporting a reason.`;
    return { summary: fallback, detail: fallback };
  }
  return { summary: badgeSummary(detail) || `The agent exited with code ${code}.`, detail };
}
