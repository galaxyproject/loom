import { describe, it, expect } from "vitest";
import {
  hasStoredCredential,
  isProviderUsable,
  pickSignedInFallback,
} from "../bin/provider-auth.js";

const OAUTH_ONLY = new Set(["openai-codex"]);
const ENV_MAP = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };

describe("hasStoredCredential", () => {
  it("accepts pi's credential shapes", () => {
    expect(hasStoredCredential({ anthropic: { type: "oauth", access: "t" } }, "anthropic")).toBe(
      true,
    );
    expect(hasStoredCredential({ groq: { type: "api_key", key: "k" } }, "groq")).toBe(true);
    // Older auth.json entries predate the type tag.
    expect(hasStoredCredential({ x: { access: "t" } }, "x")).toBe(true);
  });

  it("rejects absent or non-credential values", () => {
    expect(hasStoredCredential({}, "anthropic")).toBe(false);
    expect(hasStoredCredential(undefined, "anthropic")).toBe(false);
    // The reconciler used to accept any truthy value here.
    expect(hasStoredCredential({ anthropic: "yes" }, "anthropic")).toBe(false);
    expect(hasStoredCredential({ anthropic: [] }, "anthropic")).toBe(false);
    expect(hasStoredCredential({ anthropic: { type: "nonsense" } }, "anthropic")).toBe(false);
  });
});

describe("isProviderUsable", () => {
  const opts = (env: Record<string, string> = {}) => ({
    env,
    oauthOnlyProviders: OAUTH_ONLY,
    providerEnvMap: ENV_MAP,
  });

  it("accepts an injected env key for a dual-auth provider (#429)", () => {
    // Orbit decrypts the stored key and passes it by env. Judging anthropic
    // unusable here is what flipped llm.active to Codex.
    expect(
      isProviderUsable(
        "anthropic",
        { apiKeyEncrypted: "blob" },
        {},
        opts({ ANTHROPIC_API_KEY: "sk" }),
      ),
    ).toBe(true);
  });

  it("accepts a stored login for any provider, not just sign-in-only ones", () => {
    const auth = { anthropic: { type: "oauth", access: "t" } };
    expect(isProviderUsable("anthropic", undefined, auth, opts())).toBe(true);
  });

  it("accepts a plaintext config key", () => {
    expect(isProviderUsable("anthropic", { apiKey: "sk" }, {}, opts())).toBe(true);
  });

  it("rejects a provider with no credential anywhere", () => {
    expect(isProviderUsable("anthropic", { apiKeyEncrypted: "blob" }, {}, opts())).toBe(false);
  });

  it("ignores keys for a sign-in-only provider", () => {
    expect(
      isProviderUsable("openai-codex", { apiKey: "sk" }, {}, opts({ OPENAI_API_KEY: "sk" })),
    ).toBe(false);
    expect(
      isProviderUsable("openai-codex", undefined, { "openai-codex": { type: "oauth" } }, opts()),
    ).toBe(true);
  });

  it("defers to the resolved key for custom providers", () => {
    expect(isProviderUsable("custom", {}, {}, { ...opts(), customKeyResolved: "sk" })).toBe(true);
    expect(isProviderUsable("custom", {}, {}, { ...opts(), customKeyResolved: "" })).toBe(false);
  });
});

describe("pickSignedInFallback", () => {
  it("finds a signed-in sign-in-only provider", () => {
    const auth = { "openai-codex": { type: "oauth", access: "t" } };
    expect(pickSignedInFallback(auth, OAUTH_ONLY, "anthropic")).toBe("openai-codex");
  });

  it("returns null when nothing is signed in, or when it's already active", () => {
    expect(pickSignedInFallback({}, OAUTH_ONLY, "anthropic")).toBeNull();
    const auth = { "openai-codex": { type: "oauth" } };
    expect(pickSignedInFallback(auth, OAUTH_ONLY, "openai-codex")).toBeNull();
  });
});
