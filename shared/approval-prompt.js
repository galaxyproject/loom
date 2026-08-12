// Shell-neutral formatting for the exec-guard approval prompt.
//
// pi's `ctx.ui.select` carries one title string and a list of options -- there
// is no detail/body field to thread the thing being approved through -- so the
// command (or path) rides in the title, below a blank line. The CLI selector
// wraps the whole string verbatim; Orbit splits it back apart and renders the
// detail in its scrollable modal body. A shell that knows nothing about the
// convention still shows the full text, just less prettily. #399

/** How much of the approved command a prompt shows before cutting it out. */
export const APPROVAL_DETAIL_LIMIT = 2000;

/** Characters of the cut-out region's tail to keep, so a suffix can't hide. */
const TAIL_SHARE = 0.2;

/**
 * @param {string} detail
 * @param {number} [limit]
 * @returns {string}
 */
export function truncateApprovalDetail(detail, limit = APPROVAL_DETAIL_LIMIT) {
  // No trimming: what's shown has to be byte-for-byte what gets approved.
  const text = String(detail ?? "");
  const max = Math.max(0, limit);
  if (text.length <= max) return text;
  // Cut the middle, not the tail -- a head-only cut is exactly where you'd
  // hide the destructive half of a long command. Never truncate silently:
  // approving what you can't see is the whole bug.
  const tail = Math.floor(max * TAIL_SHARE);
  const head = max - tail;
  const hidden = text.length - max;
  const marker = `\n... (truncated -- ${hidden} of ${text.length} characters not shown) ...\n`;
  return tail > 0
    ? `${text.slice(0, head)}${marker}${text.slice(-tail)}`
    : `${text.slice(0, head)}${marker.trimEnd()}`;
}

/**
 * @param {string} heading
 * @param {string} detail
 * @param {number} [limit]
 * @returns {string}
 */
export function buildApprovalPrompt(heading, detail, limit = APPROVAL_DETAIL_LIMIT) {
  const body = truncateApprovalDetail(detail, limit);
  return body ? `${String(heading)}\n\n${body}` : String(heading);
}

/**
 * @param {string} title
 * @returns {{ heading: string, detail: string }}
 */
export function splitApprovalPrompt(title) {
  const text = String(title ?? "");
  const sep = text.match(/\r?\n[ \t]*\r?\n/);
  if (!sep || sep.index === undefined) return { heading: text, detail: "" };
  return {
    heading: text.slice(0, sep.index),
    detail: text.slice(sep.index + sep[0].length),
  };
}
