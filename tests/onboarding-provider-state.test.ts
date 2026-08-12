import { describe, expect, it } from "vitest";
import {
  ProviderFieldStore,
  buildOnboardingProviders,
  captureProviderState,
  emptyProviderState,
  providerStateFor,
  type ProviderState,
} from "../app/src/renderer/provider-state.js";

/**
 * Issue #401: the first-run welcome screen left the API key you typed for one
 * provider sitting in the field after you switched the dropdown, and Save wrote
 * that key under the *newly selected* provider -- so provider A's credential
 * ended up stored as provider B's, and the first call failed with an auth error
 * pointing at the wrong provider. These tests pin the per-provider capture /
 * restore contract (already used by Preferences) and the save payload built
 * from it, without touching the DOM.
 */

const isOAuth = (p: string): boolean => p === "openai-codex";
const saveOptions = {
  isOAuthProvider: isOAuth,
  requiresBaseUrl: (p: string): boolean => p === "openai-compatible",
};

describe("providerStateFor", () => {
  it("returns blank fields for a provider that has never been visited", () => {
    expect(providerStateFor({}, "openai")).toEqual(emptyProviderState());
  });

  it("returns the stored state for a visited provider", () => {
    const states = captureProviderState({}, "openai", {
      typedKey: "sk-openai",
      model: "gpt-5.4",
      baseUrl: "",
    });
    expect(providerStateFor(states, "openai")).toEqual({
      hadKey: false,
      typedKey: "sk-openai",
      model: "gpt-5.4",
      baseUrl: "",
    });
  });

  it("hands back a copy so callers can't mutate the map through it", () => {
    const states = captureProviderState({}, "openai", {
      typedKey: "sk-openai",
      model: "gpt-5.4",
      baseUrl: "",
    });
    providerStateFor(states, "openai").typedKey = "clobbered";
    expect(states.openai.typedKey).toBe("sk-openai");
  });
});

describe("captureProviderState", () => {
  it("does not mutate the map it was given", () => {
    const before: Record<string, ProviderState> = {};
    const after = captureProviderState(before, "openai", {
      typedKey: "sk-openai",
      model: "gpt-5.4",
      baseUrl: "",
    });
    expect(before).toEqual({});
    expect(after.openai.typedKey).toBe("sk-openai");
  });

  it("leaves every other provider's state alone", () => {
    let states = captureProviderState({}, "openai", {
      typedKey: "sk-openai",
      model: "gpt-5.4",
      baseUrl: "",
    });
    states = captureProviderState(states, "deepseek", {
      typedKey: "sk-deepseek",
      model: "deepseek-v4-pro",
      baseUrl: "",
    });
    expect(states.openai.typedKey).toBe("sk-openai");
    expect(states.deepseek.typedKey).toBe("sk-deepseek");
  });

  it("preserves the stored-key flag across a re-capture", () => {
    const states = captureProviderState(
      { anthropic: { hadKey: true, typedKey: "", model: "claude-opus-5", baseUrl: "" } },
      "anthropic",
      { typedKey: "", model: "claude-sonnet-5", baseUrl: "" },
    );
    expect(states.anthropic).toEqual({
      hadKey: true,
      typedKey: "",
      model: "claude-sonnet-5",
      baseUrl: "",
    });
  });

  it("trims the base URL", () => {
    const states = captureProviderState({}, "openai-compatible", {
      typedKey: "sk-custom",
      model: "gpt-oss-120b",
      baseUrl: "  https://llm.jetstream-cloud.org/api  ",
    });
    expect(states["openai-compatible"].baseUrl).toBe("https://llm.jetstream-cloud.org/api");
  });
});

describe("buildOnboardingProviders", () => {
  it("stores each typed key under the provider it was typed for", () => {
    // The #401 flow: type a key for OpenAI, switch the dropdown to DeepSeek,
    // type its key, save.
    let states = captureProviderState({}, "openai", {
      typedKey: "sk-openai",
      model: "gpt-5.4",
      baseUrl: "",
    });
    states = captureProviderState(states, "deepseek", {
      typedKey: "sk-deepseek",
      model: "deepseek-v4-pro",
      baseUrl: "",
    });

    const providers = buildOnboardingProviders(states, "deepseek", saveOptions);

    expect(providers).toEqual({
      openai: { apiKey: "sk-openai", model: "gpt-5.4" },
      deepseek: { apiKey: "sk-deepseek", model: "deepseek-v4-pro" },
    });
  });

  it("never writes the previous provider's key under the active one", () => {
    // Same flow, but the user switched away from OpenAI without typing a
    // DeepSeek key. Save blocks this one before it gets here (an active
    // API-key provider with no key is a validation error), so it pins the
    // invariant rather than a reachable path -- the reachable version is the
    // OAuth case below, where no key is required to save.
    let states = captureProviderState({}, "openai", {
      typedKey: "sk-openai",
      model: "gpt-5.4",
      baseUrl: "",
    });
    states = captureProviderState(states, "deepseek", {
      typedKey: "",
      model: "deepseek-v4-pro",
      baseUrl: "",
    });

    const providers = buildOnboardingProviders(states, "deepseek", saveOptions);

    expect(providers.deepseek.apiKey).toBeUndefined();
    expect(providers.openai.apiKey).toBe("sk-openai");
  });

  it("skips providers that were only looked at", () => {
    let states = captureProviderState({}, "anthropic", {
      typedKey: "sk-anthropic",
      model: "claude-opus-5",
      baseUrl: "",
    });
    states = captureProviderState(states, "groq", {
      typedKey: "",
      model: "llama-3.3-70b-versatile",
      baseUrl: "",
    });

    expect(Object.keys(buildOnboardingProviders(states, "anthropic", saveOptions))).toEqual([
      "anthropic",
    ]);
  });

  it("drops a stashed custom endpoint that never got a base URL", () => {
    // Unreachable as saved: openai-compatible is nothing without its URL, and
    // only the provider on screen gets the form's base-URL check.
    let states = captureProviderState({}, "openai-compatible", {
      typedKey: "sk-custom",
      model: "",
      baseUrl: "",
    });
    states = captureProviderState(states, "anthropic", {
      typedKey: "sk-anthropic",
      model: "claude-opus-5",
      baseUrl: "",
    });

    expect(Object.keys(buildOnboardingProviders(states, "anthropic", saveOptions))).toEqual([
      "anthropic",
    ]);
  });

  it("keeps the active provider even when it looks incomplete", () => {
    // The form blocks this one before save; the payload builder isn't the
    // place to second-guess which provider the user is actively configuring.
    const states = captureProviderState({}, "openai-compatible", {
      typedKey: "sk-custom",
      model: "",
      baseUrl: "",
    });

    expect(buildOnboardingProviders(states, "openai-compatible", saveOptions)).toEqual({
      "openai-compatible": { apiKey: "sk-custom" },
    });
  });

  it("keeps a base URL on the provider it belongs to", () => {
    let states = captureProviderState({}, "openai-compatible", {
      typedKey: "sk-custom",
      model: "gpt-oss-120b",
      baseUrl: "https://llm.jetstream-cloud.org/api",
    });
    states = captureProviderState(states, "anthropic", {
      typedKey: "sk-anthropic",
      model: "claude-opus-5",
      baseUrl: "",
    });

    const providers = buildOnboardingProviders(states, "anthropic", saveOptions);

    expect(providers["openai-compatible"].baseUrl).toBe("https://llm.jetstream-cloud.org/api");
    expect(providers.anthropic.baseUrl).toBeUndefined();
  });

  it("trims typed keys", () => {
    const states = captureProviderState({}, "anthropic", {
      typedKey: "  sk-anthropic  ",
      model: "claude-opus-5",
      baseUrl: "",
    });
    expect(buildOnboardingProviders(states, "anthropic", saveOptions).anthropic.apiKey).toBe(
      "sk-anthropic",
    );
  });

  it("never writes a plaintext apiKey for an OAuth provider", () => {
    // OAuth credentials live in ~/.pi/agent/auth.json; an apiKey in config.json
    // would shadow that path.
    const states = captureProviderState({}, "openai-codex", {
      typedKey: "leaked-from-another-provider",
      model: "gpt-5.3-codex",
      baseUrl: "",
    });

    const providers = buildOnboardingProviders(states, "openai-codex", saveOptions);

    expect(providers["openai-codex"]).toEqual({ model: "gpt-5.3-codex" });
    expect(JSON.stringify(providers)).not.toContain("leaked-from-another-provider");
  });

  it("keeps the active provider in the payload even with nothing typed", () => {
    // OAuth sign-in path: no key, no model picked yet -- the entry still has to
    // exist so llm.active points at a provider that's present in the map.
    const providers = buildOnboardingProviders({}, "openai-codex", saveOptions);
    expect(providers).toEqual({ "openai-codex": {} });
  });

  it("omits an empty model rather than clearing a stored one", () => {
    const states = captureProviderState({}, "anthropic", {
      typedKey: "sk-anthropic",
      model: "",
      baseUrl: "",
    });
    expect(buildOnboardingProviders(states, "anthropic", saveOptions).anthropic).toEqual({
      apiKey: "sk-anthropic",
    });
  });
});

/**
 * The store is what the welcome overlay actually drives: it owns which provider
 * the visible fields belong to, so the capture-then-restore ordering that #401
 * got wrong is pinned here instead of only in the change handler.
 */
describe("ProviderFieldStore", () => {
  const openaiFields = { typedKey: "sk-openai", model: "gpt-5.4", baseUrl: "" };

  it("clears the field when switching to a provider you haven't visited", () => {
    const store = new ProviderFieldStore("openai");
    expect(store.select("deepseek", openaiFields)).toEqual(emptyProviderState());
    expect(store.activeProvider).toBe("deepseek");
  });

  it("restores the stashed key when you switch back", () => {
    const store = new ProviderFieldStore("openai");
    store.select("deepseek", openaiFields);
    expect(store.select("openai", { typedKey: "", model: "deepseek-v4-pro", baseUrl: "" })).toEqual(
      { hadKey: false, ...openaiFields },
    );
  });

  it("keeps what's on screen when the selection doesn't actually change", () => {
    const store = new ProviderFieldStore("openai");
    expect(store.select("openai", openaiFields)).toEqual({ hadKey: false, ...openaiFields });
  });

  it("saves each key under its own provider, with the selected one active", () => {
    const store = new ProviderFieldStore("openai");
    store.select("deepseek", openaiFields);
    store.snapshot({ typedKey: "sk-deepseek", model: "deepseek-v4-pro", baseUrl: "" });

    expect(store.saveEntries(saveOptions)).toEqual({
      openai: { apiKey: "sk-openai", model: "gpt-5.4" },
      deepseek: { apiKey: "sk-deepseek", model: "deepseek-v4-pro" },
    });
  });

  it("leaves an OAuth provider keyless when the form still holds someone else's key", () => {
    // Reachable through the UI: type an OpenAI key, switch to the OAuth
    // provider, sign in, save. The OAuth entry must carry no apiKey, and the
    // OpenAI key must stay on OpenAI.
    const store = new ProviderFieldStore("openai");
    store.select("openai-codex", openaiFields);

    const providers = store.saveEntries(saveOptions);

    expect(providers["openai-codex"].apiKey).toBeUndefined();
    expect(providers.openai.apiKey).toBe("sk-openai");
  });

  it("drops every typed key on clear", () => {
    const store = new ProviderFieldStore("openai");
    store.select("deepseek", openaiFields);
    store.clear();

    expect(store.select("openai", { typedKey: "", model: "", baseUrl: "" })).toEqual(
      emptyProviderState(),
    );
    expect(store.saveEntries(saveOptions)).toEqual({ openai: {} });
  });
});
