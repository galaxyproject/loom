/**
 * Per-provider credential state for the screens that let you pick an LLM
 * provider (Preferences and the first-run welcome overlay).
 *
 * Both screens show one set of inputs for whichever provider the dropdown has
 * selected, so the fields have to be swapped out when the selection changes.
 * Preferences has always done this; the welcome screen did not, and left the
 * key you typed for provider A sitting in the field under provider B -- which
 * Save then persisted as B's credential (issue #401). These helpers are the
 * DOM-free half of that capture/restore, so the contract can be tested without
 * standing up the renderer.
 */

/** A provider's in-memory field state while the screen is open. */
export interface ProviderState {
  /** A key for this provider is already on disk (masked -- never sent here). */
  hadKey: boolean;
  /** What the user typed into the API key input, verbatim. */
  typedKey: string;
  model: string;
  baseUrl: string;
}

/** The visible inputs, read off the form at capture time. */
export interface ProviderFields {
  typedKey: string;
  model: string;
  baseUrl: string;
}

/** A provider entry as `config:save` expects it (see main/ipc-handlers.ts). */
export interface ProviderConfigEntry {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export function emptyProviderState(): ProviderState {
  return { hadKey: false, typedKey: "", model: "", baseUrl: "" };
}

/**
 * The state to restore into the visible fields for `provider`. Unvisited
 * providers get blank fields -- that's what clears the previous provider's key
 * out of the input. Returns a copy so the caller can't write through it.
 */
export function providerStateFor(
  states: Readonly<Record<string, ProviderState>>,
  provider: string,
): ProviderState {
  const state = states[provider];
  return state ? { ...state } : emptyProviderState();
}

/**
 * Snapshot the visible fields into `provider`'s slot, keeping its stored-key
 * flag (which comes from config, not from the form). Returns a new map.
 */
export function captureProviderState(
  states: Readonly<Record<string, ProviderState>>,
  provider: string,
  fields: ProviderFields,
): Record<string, ProviderState> {
  return {
    ...states,
    [provider]: {
      hadKey: states[provider]?.hadKey ?? false,
      typedKey: fields.typedKey,
      model: fields.model,
      baseUrl: fields.baseUrl.trim(),
    },
  };
}

export interface OnboardingSaveOptions {
  /** Providers that authenticate via OAuth, so never get a plaintext apiKey. */
  isOAuthProvider: (provider: string) => boolean;
  /** Providers that are unusable without a base URL (the custom endpoint). */
  requiresBaseUrl?: (provider: string) => boolean;
}

/**
 * Build the `llm.providers` payload for a first-run save: every provider the
 * user actually typed a key for, plus the active one (so `llm.active` always
 * names a provider that's present in the map).
 *
 * Three things it deliberately never emits:
 *   - a plaintext `apiKey` for an OAuth provider -- that credential lives in
 *     ~/.pi/agent/auth.json, and a config.json key would shadow it;
 *   - an empty `apiKey`, which main reads as "clear the stored key". Onboarding
 *     has no business deleting a credential that's already on disk;
 *   - a stashed provider that can't be reached with what was typed (a custom
 *     endpoint with no base URL). The form enforces that for the provider on
 *     screen; the ones left behind in the state map have to be checked here.
 */
export function buildOnboardingProviders(
  states: Readonly<Record<string, ProviderState>>,
  activeProvider: string,
  { isOAuthProvider, requiresBaseUrl }: OnboardingSaveOptions,
): Record<string, ProviderConfigEntry> {
  const providers: Record<string, ProviderConfigEntry> = {};
  const names = new Set([...Object.keys(states), activeProvider]);
  for (const name of names) {
    const state = states[name] ?? emptyProviderState();
    const key = isOAuthProvider(name) ? "" : state.typedKey.trim();
    if (name !== activeProvider) {
      if (!key) continue;
      if (requiresBaseUrl?.(name) && !state.baseUrl) continue;
    }
    const entry: ProviderConfigEntry = {};
    if (key) entry.apiKey = key;
    if (state.model) entry.model = state.model;
    if (state.baseUrl) entry.baseUrl = state.baseUrl;
    providers[name] = entry;
  }
  return providers;
}

/**
 * The welcome overlay's per-provider state, kept together with the provider the
 * form is currently showing so the "stash the old, restore the new" ordering
 * lives here rather than in the click handler -- the wiring in app.ts is then
 * just reading and writing input elements.
 */
export class ProviderFieldStore {
  private states: Record<string, ProviderState> = {};
  private active: string;

  constructor(active: string) {
    this.active = active;
  }

  /** The provider the visible fields currently belong to. */
  get activeProvider(): string {
    return this.active;
  }

  /** Stash the visible fields under the provider they were typed for. */
  snapshot(fields: ProviderFields): void {
    this.states = captureProviderState(this.states, this.active, fields);
  }

  /**
   * Switch to `provider`, stashing the fields on screen first. Returns what the
   * form should show next -- blank for a provider that hasn't been visited,
   * which is what gets the previous provider's key out of the input.
   */
  select(provider: string, visible: ProviderFields): ProviderState {
    this.snapshot(visible);
    this.active = provider;
    return providerStateFor(this.states, provider);
  }

  /** The `llm.providers` payload for a save; snapshot the form first. */
  saveEntries(options: OnboardingSaveOptions): Record<string, ProviderConfigEntry> {
    return buildOnboardingProviders(this.states, this.active, options);
  }

  /** Drop every typed key once they've been handed off to main. */
  clear(): void {
    this.states = {};
  }
}
