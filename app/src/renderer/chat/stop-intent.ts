/**
 * Plain-text "stop the current response" intent detection (issue #225).
 *
 * With a slow model, users try to halt a long "thinking" turn by typing
 * "stop"/"abort thinking"/"stop what you are doing" into chat. While a turn is
 * streaming those just queue as the next prompt and nothing stops. We detect a
 * bare stop command shell-side and treat it as an abort instead.
 *
 * The hard part is precision: this runs in a bioinformatics tool where "stop"
 * (a stop codon), "cancel" (cancel a Galaxy workflow invocation), and "abort"
 * (abort a running job) are real instructions the agent should act on, not
 * meta-commands to halt the turn. So we only fire on a *bare* stop imperative:
 * the whole message is a stop word, optionally wrapped in politeness and one of
 * a small fixed set of objects ("it", "now", "thinking", "the response", ...).
 * Anything with a real object ("stop the FastQC tool") falls through. False
 * negatives are cheap -- the labeled Stop button is still right there -- so we
 * err quiet.
 */

// A bare stop imperative, in three segments: an optional politeness lead-in
// ("please ", "can you "...), a stop verb, then only turn-referring objects
// ("it", "thinking", "the response"...). The object list is the precision
// knob -- "stop the response" matches, but "stop the FastQC tool" has no
// matching object and falls through to a normal prompt. Deictic objects
// ("this"/"that") are deliberately excluded: "cancel that" can mean a Galaxy
// job, not the turn, and we'd rather miss it than abort something wanted.
const STOP_INTENT =
  /^(please\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+|just\s+|ok,?\s+|okay,?\s+|hey,?\s+)*(stop|abort|halt|cancel)(\s+(it|now|please|thinking|responding|generating|the\s+response|what\s+you'?re\s+doing|what\s+you\s+are\s+doing))*[\s.!?]*$/;

export function detectStopIntent(text: string): boolean {
  // Normalize curly apostrophes (macOS smart-quotes mangle "you're") to ASCII
  // so the typed phrase still matches the regex.
  const t = text.trim().toLowerCase().replace(/[‘’]/g, "'");
  if (!t) return false;
  // Slash commands are dispatched, never read as a chat intent.
  if (t.startsWith("/")) return false;
  return STOP_INTENT.test(t);
}
