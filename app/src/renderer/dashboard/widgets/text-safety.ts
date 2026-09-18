/**
 * One answer, for every panel, to control characters in a name nobody wrote on
 * purpose.
 *
 * Filenames, plan titles, step titles, run labels and the brain's own summaries
 * all arrive from the notebook, from a tool's output or from the workspace, so
 * all of them are text a model wrote or a command printed. Two classes of
 * character matter:
 *
 *  - The **bidi overrides** U+202A-U+202E and the isolates U+2066-U+2069
 *    reorder what follows them, so a right-to-left override in front of
 *    `gnp.exe` renders it as `exe.png`. `textContent` does not save anyone from
 *    this -- the browser applies the override to text, not to markup -- and a
 *    panel whose selling point is that it tells the truth must not show a name
 *    in an order it was not written in.
 *  - The **C0 and C1 controls** break a one-line row: a carriage return redraws
 *    over what is already there in some renderers, and a NUL or a vertical tab
 *    is a gap in a name that reads as a space.
 *
 * The log panel already did this and the results gallery did not, which is one
 * surface with two answers. This is that one answer, in one place, so the next
 * widget inherits it rather than deciding again.
 */

/** Controls and bidi overrides. Newlines included: a name is one line. */
export const UNSAFE_INLINE = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+/g;

/** Same, but newlines survive, for a block that is deliberately multi-line. */
export const UNSAFE_BLOCK = /[\u0000-\u0009\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]+/g;

/**
 * A name, safe to put in `textContent`, a `title` or an `aria-label`. A run of
 * unsafe characters becomes one space rather than vanishing, so a name that was
 * hiding a word does not silently close up around it.
 *
 * Nothing else is touched. Doubled spaces and leading or trailing space are
 * part of a filename, and a `title` a reader hovers to copy has to be the path
 * that is actually on disk -- tidying those was the log panel's own concern
 * about fitting prose on one row, not a safety property, and it does not belong
 * in a filename.
 */
export function safeName(value: string): string {
  return value.replace(UNSAFE_INLINE, " ");
}

/**
 * `safeName`, with a literal for the case where nothing readable survives.
 *
 * `safeName(x) || x` looks like the same thing and is the opposite: a name made
 * entirely of overrides strips to blank, the `||` then reaches for the raw
 * input, and the one string the fence exists for is the one that gets through.
 */
export function safeNameOr(value: string, fallback: string): string {
  const safe = safeName(value);
  return safe.trim() ? safe : fallback;
}
