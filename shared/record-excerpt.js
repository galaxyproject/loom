// Shared head + tail excerpt of a record (Orbit's notebook.md, the browser's Galaxy Page) for
// per-turn context. Head gives project intent and early plans; tail gives the latest activity.

export const HEAD_MAX_CHARS = 2000;
export const TAIL_MAX_CHARS = 4000;
export const ELISION_MARKER = "_(... middle elided ...)_";

/** @param {string} content @returns {{ text: string, elided: boolean }} */
export function excerptHeadTail(content) {
  if (content.length <= HEAD_MAX_CHARS + TAIL_MAX_CHARS + 100) {
    return { text: content, elided: false };
  }
  const head = content.slice(0, HEAD_MAX_CHARS);
  const tail = content.slice(-TAIL_MAX_CHARS);
  return { text: `${head}\n\n${ELISION_MARKER}\n\n${tail}`, elided: true };
}
