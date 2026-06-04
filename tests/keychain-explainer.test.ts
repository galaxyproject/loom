import { describe, it, expect } from "vitest";
import {
  payloadHasNewSecret,
  shouldShowKeychainExplainer,
} from "../app/src/renderer/keychain-explainer.js";

const SENTINEL = "__loom_unchanged_secret__";

describe("payloadHasNewSecret", () => {
  it("is true when an LLM provider carries a freshly typed key", () => {
    const cfg = { llm: { active: "anthropic", providers: { anthropic: { apiKey: "sk-real" } } } };
    expect(payloadHasNewSecret(cfg, SENTINEL)).toBe(true);
  });

  it("is false for the unchanged-secret sentinel", () => {
    const cfg = { llm: { active: "anthropic", providers: { anthropic: { apiKey: SENTINEL } } } };
    expect(payloadHasNewSecret(cfg, SENTINEL)).toBe(false);
  });

  it("is false for an empty key string", () => {
    const cfg = { llm: { active: "anthropic", providers: { anthropic: { apiKey: "" } } } };
    expect(payloadHasNewSecret(cfg, SENTINEL)).toBe(false);
  });

  it("is false for an OAuth provider with no apiKey field", () => {
    const cfg = { llm: { active: "openai-codex", providers: { "openai-codex": { model: "x" } } } };
    expect(payloadHasNewSecret(cfg, SENTINEL)).toBe(false);
  });

  it("is true when a Galaxy profile carries a freshly typed key", () => {
    const cfg = { galaxy: { active: "default", profiles: { default: { url: "u", apiKey: "g" } } } };
    expect(payloadHasNewSecret(cfg, SENTINEL)).toBe(true);
  });

  it("is false when the Galaxy profile key is the sentinel", () => {
    const cfg = {
      galaxy: { active: "default", profiles: { default: { url: "u", apiKey: SENTINEL } } },
    };
    expect(payloadHasNewSecret(cfg, SENTINEL)).toBe(false);
  });

  it("is false for an empty payload", () => {
    expect(payloadHasNewSecret({}, SENTINEL)).toBe(false);
  });
});

describe("shouldShowKeychainExplainer", () => {
  const base = {
    platform: "darwin",
    encryptionAvailable: true,
    alreadyShown: false,
    hasNewSecret: true,
  };

  it("is true when all conditions hold", () => {
    expect(shouldShowKeychainExplainer(base)).toBe(true);
  });

  it("is false off macOS", () => {
    expect(shouldShowKeychainExplainer({ ...base, platform: "linux" })).toBe(false);
    expect(shouldShowKeychainExplainer({ ...base, platform: "win32" })).toBe(false);
  });

  it("is false when safeStorage is unavailable", () => {
    expect(shouldShowKeychainExplainer({ ...base, encryptionAvailable: false })).toBe(false);
  });

  it("is false when already shown", () => {
    expect(shouldShowKeychainExplainer({ ...base, alreadyShown: true })).toBe(false);
  });

  it("is false when there is no new secret", () => {
    expect(shouldShowKeychainExplainer({ ...base, hasNewSecret: false })).toBe(false);
  });
});
