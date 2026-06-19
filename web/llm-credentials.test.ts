import { describe, it, expect } from "vitest";
import { providerKeyVar, hasProviderKey } from "./llm-credentials.js";

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
