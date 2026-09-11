/**
 * Per-provider credential and field state for the screens that let you pick an
 * LLM provider (Preferences and the first-run welcome overlay).
 *
 * Both screens show one set of inputs for whichever provider the dropdown has
 * selected, so the fields have to be swapped out when the selection changes.
 * Preferences has always done this; the welcome screen did not, and left the
 * key you typed for provider A sitting in the field under provider B -- which
 * Save then persisted as B's credential (issue #401).
 *
 * Most of that state is just what is in the form, but two pieces are not:
 * `savedBaseUrl` (the base URL as it sits on disk) and `discoveredModels`.
 * Rebuilding this object from the form fields alone silently reintroduces #432
 * (model discovery skips every probe).
 */

/** The visible inputs, read off the form at snapshot time. */
export interface ProviderFieldValues {
  typedKey: string;
  model: string;
  baseUrl: string;
}

/** Alias for ProviderFieldValues for backwards compatibility. */
export type ProviderFields = ProviderFieldValues;

/** A provider's in-memory state while Preferences or Onboarding is open. */
export interface ProviderState {
  /** Config has a key for this provider (masked -- the key never reaches us). */
  hadKey: boolean;
  /** What the user typed into the API key input, verbatim. */
  typedKey: string;
  model: string;
  /** Base URL as it sits in the editable field. */
  baseUrl: string;
  /**
   * Base URL as it sits in config -- what main would actually contact for a
   * discovery probe. Not editable, so a form snapshot must not overwrite it.
   */
  savedBaseUrl: string;
  /** Ids last reported by a custom endpoint's /models, if it was asked. */
  discoveredModels?: string[];
}

/** A provider entry as `config:save` expects it (see main/ipc-handlers.ts). */
export interface ProviderConfigEntry {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export function emptyProviderState(): ProviderState {
  return { hadKey: false, typedKey: "", model: "", baseUrl: "", savedBaseUrl: "" };
}

/**
 * Stash the visible fields into `provider`'s slot when switching away.
 *
 * `hadKey`, `savedBaseUrl` and `discoveredModels` describe config and the
 * endpoint's answer, not the form, so they are carried forward from `prev`
 * rather than read off the inputs. Rebuilding this object from the form fields
 * alone silently reintroduces #432: `planModelDiscovery` reads a blank
 * `savedBaseUrl`, skips every probe, and the model picker stays empty with all
 * tests still green. `tests/provider-state.test.ts` pins that.
 */
export function snapshotProviderState(
  prev: ProviderState | undefined,
  fields: ProviderFieldValues,
): ProviderState {
  return {
    hadKey: prev?.hadKey ?? false,
    typedKey: fields.typedKey,
    model: fields.model,
    baseUrl: fields.baseUrl.trim(),
    savedBaseUrl: prev?.savedBaseUrl ?? "",
    discoveredModels: prev?.discoveredModels,
  };
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
  fields: ProviderFieldValues,
): Record<string, ProviderState> {
  return {
    ...states,
    [provider]: snapshotProviderState(states[provider], fields),
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
  snapshot(fields: ProviderFieldValues): void {
    this.states = captureProviderState(this.states, this.active, fields);
  }

  /**
   * Switch to `provider`, stashing the fields on screen first. Returns what the
   * form should show next -- blank for a provider that hasn't been visited,
   * which is what gets the previous provider's key out of the input.
   */
  select(provider: string, visible: ProviderFieldValues): ProviderState {
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
