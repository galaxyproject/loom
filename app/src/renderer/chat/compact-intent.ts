/**
 * Plain-text "compact the conversation" intent detection (issue #171).
 *
 * Users type things like "compact" or "reduce the context" into chat
 * expecting the live context window to shrink. It won't -- compaction is the
 * `/compact` command (a harness action), not a chat message the agent can
 * act on. We detect that intent shell-side and nudge them to `/compact`.
 *
 * The hard part is precision: this runs in a bioinformatics tool where
 * "compact" (a compact genome), "reduce", and "history" (a Galaxy history)
 * carry unrelated meanings. So we only fire when a compaction verb is paired
 * with a conversation-referring noun, or when the message is a bare "compact"
 * imperative. False negatives are cheap (the agent's own guardrail still
 * routes them to `/compact`); false positives are annoying, so we err quiet.
 */

const COMPACT_VERB = /\bcompact(s|ed|ing)?\b/;
const REDUCE_VERB = /\b(reduce|shrink|trim)\b/;
// Nouns that clearly refer to the chat/LLM context, not Galaxy/genomic data.
const CONVERSATION_NOUN = /\b(context|conversation|chat)\b/;
// A bare imperative: "compact", "compact it", "please compact now", etc.
// Deliberately does NOT accept "compact the <anything>" -- that path goes
// through the verb+noun rule so "compact the genome" can't slip in.
const BARE_COMPACT =
  /^(please\s+|can\s+you\s+|could\s+you\s+|hey,?\s+)*compact(\s+(it|this|that|everything|now|please))*[\s.!?]*$/;

export function detectCompactIntent(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  // Already a slash command, or already referencing the real command.
  if (t.startsWith("/")) return false;
  if (t.includes("/compact")) return false;

  if (BARE_COMPACT.test(t)) return true;
  if (COMPACT_VERB.test(t) && CONVERSATION_NOUN.test(t)) return true;
  if (REDUCE_VERB.test(t) && CONVERSATION_NOUN.test(t)) return true;
  return false;
}
