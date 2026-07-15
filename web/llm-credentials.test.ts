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

// #330: providerKeyVar used to derive the var by uppercasing the provider name,
// which is wrong for google -- its key is GEMINI_API_KEY, not GOOGLE_API_KEY.
// The naive guess reported a perfectly good admin-injected GEMINI_API_KEY as
// absent, and sent a BYO Gemini key somewhere the brain never reads.
describe("providerKeyVar uses the canonical map, not the provider name", () => {
  it("maps google to GEMINI_API_KEY", () => {
    expect(providerKeyVar("google")).toBe("GEMINI_API_KEY");
    expect(providerKeyVar("google")).not.toBe("GOOGLE_API_KEY");
  });
  it("maps the rest of the built-ins", () => {
    expect(providerKeyVar("deepseek")).toBe("DEEPSEEK_API_KEY");
    expect(providerKeyVar("mistral")).toBe("MISTRAL_API_KEY");
    expect(providerKeyVar("groq")).toBe("GROQ_API_KEY");
  });
  it("finds an admin-injected Gemini key for provider google", () => {
    expect(hasProviderKey({ env: { GEMINI_API_KEY: "sk-g" }, provider: "google" })).toBe(true);
  });
  it("routes a BYO google key to GEMINI_API_KEY", () => {
    expect(llmKeyEnvVar("google")).toBe("GEMINI_API_KEY");
  });
});

// A custom OpenAI-compatible provider (gxit/README.md) carries its key in
// LOOM_ACTIVE_LLM_API_KEY, not ${PROVIDER}_API_KEY -- the brain resolves it from
// there (resolveActiveLlmApiKey). Gating on the named var alone reported "no key"
// for a correctly-configured container, so the server never spawned the brain and
// showed the BYO overlay instead.
describe("custom providers", () => {
  it("counts LOOM_ACTIVE_LLM_API_KEY when the provider is custom", () => {
    expect(
      hasProviderKey({
        env: { LOOM_ACTIVE_LLM_API_KEY: "sk-custom" },
        provider: "myprov",
        isCustom: true,
      }),
    ).toBe(true);
  });
  it("routes a custom provider's key to LOOM_ACTIVE_LLM_API_KEY", () => {
    expect(llmKeyEnvVar("myprov", { isCustom: true })).toBe("LOOM_ACTIVE_LLM_API_KEY");
  });
  // Codex #10: a stale LOOM_ACTIVE_LLM_API_KEY must NOT vouch for a built-in
  // provider. bin/loom.js only reads that var for baseUrl-carrying providers, so
  // treating it as a key here suppressed the BYO prompt and spawned a brain that
  // couldn't authenticate, with no way back to the prompt.
  it("ignores LOOM_ACTIVE_LLM_API_KEY for a built-in provider", () => {
    expect(
      hasProviderKey({ env: { LOOM_ACTIVE_LLM_API_KEY: "stale" }, provider: "anthropic" }),
    ).toBe(false);
  });
  it("is false when a custom provider has no key", () => {
    expect(hasProviderKey({ env: {}, provider: "myprov", isCustom: true })).toBe(false);
  });
});

describe("llmKeyEnvVar refuses to guess", () => {
  // Codex #2: the overlay can send "openai-compatible", which is not built in and
  // has no config entry in a stock container. There is nowhere to put the key, so
  // say so rather than inject it somewhere inert and report success.
  it("returns null for an unknown, non-custom provider", () => {
    expect(llmKeyEnvVar("openai-compatible")).toBeNull();
    expect(llmKeyEnvVar("myprov")).toBeNull();
  });
});
