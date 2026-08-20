/**
 * What Preferences should do when it wants an OpenAI-compatible endpoint's
 * model list.
 */
export type DiscoveryPlan =
  | { action: "probe" }
  | { action: "skip" }
  | { action: "message"; message: string }
  /** A key is on screen but not yet in main -- let the live validation probe. */
  | { action: "validate-typed-key" };

export interface DiscoveryContext {
  /** True when the user pressed "Fetch models" rather than just opening the pane. */
  manual: boolean;
  /** Base URL as stored in config -- the one main will actually contact. */
  savedBaseUrl: string;
  /** Base URL currently in the field. */
  typedBaseUrl: string;
  /** Key currently in the field, if the user is typing a new one. */
  typedKey: string;
  /** Config has a key for this provider. */
  hadKey: boolean;
  /** A list was already fetched for this provider in this Preferences session. */
  alreadyDiscovered: boolean;
}

/**
 * Decide whether to ask main to re-probe /models.
 *
 * Discovery runs through main because only main can read the stored key, and
 * main probes what is on disk. So anything the user has typed but not saved
 * has to be routed elsewhere rather than silently ignored: an edited base URL
 * would list the wrong endpoint's models, and a typed key belongs to the live
 * validation path.
 */
export function planModelDiscovery(ctx: DiscoveryContext): DiscoveryPlan {
  const saved = ctx.savedBaseUrl.trim();
  if (!saved) {
    return ctx.manual
      ? { action: "message", message: "Save the base URL and key first, then fetch." }
      : { action: "skip" };
  }
  if (ctx.manual) {
    if (ctx.typedBaseUrl.trim() !== saved) {
      return {
        action: "message",
        message: "Save the new base URL first — this fetches from the saved one.",
      };
    }
    if (ctx.typedKey.trim()) return { action: "validate-typed-key" };
    return { action: "probe" };
  }
  // Opening the pane: only worth a network call when main has something to
  // probe with, and only once per provider per session.
  if (!ctx.hadKey || ctx.alreadyDiscovered) return { action: "skip" };
  return { action: "probe" };
}
