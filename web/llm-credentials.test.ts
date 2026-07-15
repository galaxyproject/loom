import { describe, it, expect } from "vitest";
import { providerKeyVar, hasProviderKey, llmKeyEnvVar } from "./llm-credentials.js";

describe("providerKeyVar", () => {
  it("maps a known provider to its API-key env var", () => {
    expect(providerKeyVar("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(providerKeyVar("xai")).toBe("XAI_API_KEY");
    expect(providerKeyVar("openai")).toBe("OPENAI_API_KEY");
  });
  it("returns null for an unknown provider (not in the canonical set)", () => {
    expect(providerKeyVar("bogus")).toBeNull();
  });
});

describe("hasProviderKey", () => {
  it("is true when a provided key is non-empty", () => {
    expect(hasProviderKey({ env: {}, provider: "anthropic", providedKey: "sk-x" })).toBe(true);
  });
  it("is true when the env carries the provider's key var", () => {
    expect(hasProviderKey({ env: { ANTHROPIC_API_KEY: "sk-y" }, provider: "anthropic" })).toBe(
      true,
    );
  });
  it("is false when neither env nor provided key is present", () => {
    expect(hasProviderKey({ env: {}, provider: "anthropic" })).toBe(false);
  });
  it("is false for an empty provided key and empty env value", () => {
    expect(
      hasProviderKey({ env: { ANTHROPIC_API_KEY: "" }, provider: "anthropic", providedKey: "" }),
    ).toBe(false);
  });
});

// #330 regression: a custom OpenAI-compatible provider (gxit/README.md) carries
// its key in LOOM_ACTIVE_LLM_API_KEY, not ${PROVIDER}_API_KEY -- the brain
// resolves it from there (bin/loom.js resolveActiveLlmApiKey). Gating on the
// named var alone reported "no key" for a correctly-configured container, so the
// server never spawned the brain and the user got the BYO overlay instead.
describe("hasProviderKey with a custom provider", () => {
  it("is true when LOOM_ACTIVE_LLM_API_KEY carries the key", () => {
    expect(
      hasProviderKey({ env: { LOOM_ACTIVE_LLM_API_KEY: "sk-custom" }, provider: "myprov" }),
    ).toBe(true);
  });
  it("is true even when the active provider name looks built-in", () => {
    // The server defaults activeProvider() to "anthropic" when LOOM_LLM_PROVIDER
    // is unset, while config.json names the real custom provider -- so the key
    // must count regardless of the provider label the server happens to hold.
    expect(
      hasProviderKey({ env: { LOOM_ACTIVE_LLM_API_KEY: "sk-custom" }, provider: "anthropic" }),
    ).toBe(true);
  });
  it("is false when LOOM_ACTIVE_LLM_API_KEY is empty", () => {
    expect(hasProviderKey({ env: { LOOM_ACTIVE_LLM_API_KEY: "" }, provider: "myprov" })).toBe(
      false,
    );
  });
});

describe("llmKeyEnvVar", () => {
  it("routes a built-in provider to its own key var", () => {
    expect(llmKeyEnvVar("anthropic")).toBe("ANTHROPIC_API_KEY");
  });
  it("routes an unknown/custom provider to LOOM_ACTIVE_LLM_API_KEY", () => {
    // Mirrors Orbit desktop (app/src/main/agent.ts): custom endpoints route
    // through LOOM_ACTIVE_LLM_API_KEY. Returning null here meant startLoom
    // injected nothing and spawned an unauthenticated brain.
    expect(llmKeyEnvVar("myprov")).toBe("LOOM_ACTIVE_LLM_API_KEY");
    expect(llmKeyEnvVar("openai-compatible")).toBe("LOOM_ACTIVE_LLM_API_KEY");
  });
  it("never returns null, so a supplied key always lands somewhere", () => {
    for (const p of ["anthropic", "myprov", "", "openai"]) {
      expect(typeof llmKeyEnvVar(p)).toBe("string");
    }
  });
});
