// Decision helper for the slash-command autocomplete popup's keyboard flow.

/** Pure decision: when the slash popup is open and Enter is pressed, should we
 *  accept the highlighted command (complete + run, like Tab+Enter) instead of
 *  submitting the raw typed text? Yes whenever a real row is highlighted
 *  (issue #287) -- the normal case, since opening the popup always highlights
 *  row 0 (and a fully-typed command is itself that highlighted row, so it still
 *  runs). Returns false only defensively (no items, or active index out of
 *  range); Enter then falls back to the normal submit path. */
export function shouldAcceptSlashCommandOnEnter(activeIndex: number, itemCount: number): boolean {
  return activeIndex >= 0 && activeIndex < itemCount;
}
