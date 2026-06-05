/**
 * Unicode-confusables fold for tool-name lookups. STOPGAP -- see #100.
 *
 * Some open-weights LLMs (gpt-oss, smaller frontier models) sample
 * Cyrillic/Greek lookalikes for Latin letters when generating identifiers
 * -- most often `с` (U+0441) where Latin `c` belongs. pi-agent-core's
 * tool dispatch does an exact-string match (prepareToolCall in
 * node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js), so one
 * Cyrillic char in `brс_analytics_*` is enough to surface "Tool not
 * found" to the agent.
 *
 * Why this is a stopgap and not a proper fix: the right place to
 * normalize is at the lookup layer in pi-agent-core (or pi-mcp-adapter
 * for the proxy path). Upstream's stance on input normalization is in
 * earendil-works/pi#638 (case-mismatch case): "this is not something pi
 * will 'normalize', and the suggested fix is just plain wrong." So
 * landing this upstream is unlikely. Meanwhile we can't intercept
 * before pi-agent-core's find() from inside Loom either -- the
 * message_end extension event is queued async by agent-session.js and
 * races the synchronous tool dispatch.
 *
 * What this does: hook the tool-result message_end (which fires AFTER
 * the not-found failure), fold confusables, and append a "Did you mean
 * X?" hint to the error. The agent recovers in one turn instead of
 * two or three. Drop this when upstream lookup becomes fold-aware or
 * when models stop sampling lookalikes -- whichever comes first.
 */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic lowercase that look like Latin
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  х: "x",
  у: "y",
  // Cyrillic uppercase
  А: "A",
  Е: "E",
  О: "O",
  Р: "P",
  С: "C",
  Х: "X",
  У: "Y",
  // Greek lowercase
  ν: "v",
  τ: "t",
};

export function foldConfusables(s: string): string {
  let changed = false;
  let out = "";
  for (const ch of s) {
    const mapped = CONFUSABLES[ch];
    if (mapped !== undefined) {
      out += mapped;
      changed = true;
    } else {
      out += ch;
    }
  }
  return changed ? out : s;
}

export function hasConfusables(s: string): boolean {
  for (const ch of s) {
    if (CONFUSABLES[ch] !== undefined) return true;
  }
  return false;
}

/**
 * Look up a folded match for `badName` against `candidateNames`. Returns
 * the canonical name iff `badName` actually contains a confusable AND its
 * folded form equals one of the candidates' folded forms. Returns
 * undefined when there's nothing to suggest — including the case where
 * `badName` is already pure ASCII and doesn't match anything (a real
 * hallucination, not a confusables issue).
 */
export function findConfusablesMatch(
  badName: string,
  candidateNames: string[],
): string | undefined {
  if (!hasConfusables(badName)) return undefined;
  const folded = foldConfusables(badName);
  for (const name of candidateNames) {
    if (foldConfusables(name) === folded) return name;
  }
  return undefined;
}
