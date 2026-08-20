// Orbit sends a large fixed prefix on every turn, before the user has typed
// anything: the baseline system prompt assembled by setupContextInjection in
// extensions/loom/context.ts (~8K tokens, and it grows every time someone adds
// a skill or a context block there) plus the tool schemas for Galaxy MCP's ~37
// tools. A model whose entire context window is smaller than that prefix
// overflows on the first message -- plain gpt-4's 8K window did exactly that to
// two beta testers, neither of whom ever got a working turn (#418).
//
// The floor is a judgment call, so here is the reasoning behind the number.
// Prefix + tool schemas leaves a 16K or 32K model almost nothing for tool
// results and a reply: it survives the first message and then dies a couple of
// tool calls in. That is failing *late*, after the user has invested in a
// session, which is worse than never offering the model. 50K clears that whole
// broken tier while sitting well under every mainstream model (128K gpt-4o
// family, 200K+ Claude, 1M Gemini), and deliberately under the ~64K tier
// (deepseek-r1, mixtral-8x22b) that active beta testers are using -- do not
// round this up to 64K, it would cut models people are working in today.
//
// This number is downstream of the baseline prompt: if you grow that prefix,
// revisit this rather than assuming it still holds.
export const MIN_USABLE_CONTEXT_WINDOW = 50_000;

// pi's registry window is not authoritative for locally-served models -- the
// user picks num_ctx themselves, so filtering on the registry number would hide
// a local model somebody deliberately configured with a large window. Custom
// OpenAI-compatible endpoints are user-named and never reach models:list-all,
// so they need no entry here; this is the place to add one if that changes.
const LOCAL_MODEL_PROVIDERS: ReadonlySet<string> = new Set(["ollama"]);

/** A window we can actually reason about. Anything else is treated as unknown. */
function hasKnownContextWindow(window: unknown): window is number {
  return typeof window === "number" && Number.isFinite(window) && window > 0;
}

/**
 * Drop models whose context window is too small to run a Loom session at all.
 *
 * Two deliberate escape hatches, both of which fail toward showing a model
 * rather than hiding one:
 *   - a model that reports no usable window is kept, because excluding
 *     unknowns is how you silently empty a provider;
 *   - if the filter would remove *every* model for a provider, the unfiltered
 *     list is returned instead. The caller drops providers with no models, so
 *     an empty result would make the provider vanish from the picker with no
 *     explanation -- the worst outcome available here.
 */
export function filterUnusableContextWindows<T extends { contextWindow?: number }>(
  provider: string,
  models: readonly T[],
): T[] {
  if (LOCAL_MODEL_PROVIDERS.has(provider)) return [...models];
  const usable = models.filter(
    (m) => !hasKnownContextWindow(m.contextWindow) || m.contextWindow >= MIN_USABLE_CONTEXT_WINDOW,
  );
  return usable.length ? usable : [...models];
}
