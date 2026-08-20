import { describe, it, expect } from "vitest";
import { classifyProviderAuth } from "../app/src/main/oauth-handler.js";

/**
 * #429: Orbit read "this provider can sign in" as "this provider has no API
 * key", which hid Anthropic's key field, masked hasApiKey, and stopped the
 * brain's key injection -- so the brain judged Anthropic unusable and flipped
 * llm.active to a signed-in Codex account behind the user's back.
 *
 * The shapes below mirror pi-ai 0.84.1's registry entries.
 */
describe("classifyProviderAuth", () => {
  it("treats a sign-in-only provider as OAuth-only", () => {
    const caps = classifyProviderAuth({
      id: "openai-codex",
      auth: { oauth: { login: () => {}, name: "OpenAI (ChatGPT Plus/Pro)" } },
    });
    expect(caps).toEqual({ signInLabel: "OpenAI (ChatGPT Plus/Pro)", acceptsApiKey: false });
  });

  it("keeps a dual-auth provider on the API-key path", () => {
    const caps = classifyProviderAuth({
      id: "anthropic",
      auth: {
        apiKey: { name: "Anthropic API key" },
        oauth: { login: () => {}, name: "Anthropic (Claude Pro/Max)" },
      },
    });
    // The regression was acceptsApiKey coming back false here.
    expect(caps).toEqual({ signInLabel: "Anthropic (Claude Pro/Max)", acceptsApiKey: true });
  });

  it("returns null for a provider with no sign-in flow", () => {
    expect(classifyProviderAuth({ id: "groq", auth: { apiKey: {} } })).toBeNull();
    expect(classifyProviderAuth({ id: "mistral" })).toBeNull();
  });

  it("ignores an oauth block that carries no login flow", () => {
    expect(classifyProviderAuth({ id: "half", auth: { oauth: { name: "Half" } } })).toBeNull();
  });

  it("prefers loginLabel over name, and tolerates neither", () => {
    expect(
      classifyProviderAuth({
        id: "xai",
        auth: { apiKey: {}, oauth: { login: () => {}, name: "xAI", loginLabel: "xAI (Grok)" } },
      }),
    ).toEqual({ signInLabel: "xAI (Grok)", acceptsApiKey: true });
    expect(classifyProviderAuth({ id: "bare", auth: { oauth: { login: () => {} } } })).toEqual({
      signInLabel: "",
      acceptsApiKey: false,
    });
  });
});
