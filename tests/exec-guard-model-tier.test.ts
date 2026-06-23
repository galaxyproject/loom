import { describe, it, expect } from "vitest";
import { classifyModelTier } from "../extensions/loom/exec-guard/model-tier";

describe("classifyModelTier", () => {
  it("frontier models are trusted", () => {
    expect(
      classifyModelTier({
        id: "claude-opus-4-8",
        provider: "anthropic",
        cost: { input: 15, output: 75 },
      }),
    ).toBe("trusted");
    expect(
      classifyModelTier({
        id: "claude-sonnet-4-6",
        provider: "anthropic",
        cost: { input: 3, output: 15 },
      }),
    ).toBe("trusted");
    expect(
      classifyModelTier({ id: "gpt-5.4", provider: "openai", cost: { input: 5, output: 20 } }),
    ).toBe("trusted");
    // Regression: "gemini" contains "mini"; a gemini-pro id must not match the weak marker.
    // gemini-2.5-pro is trusted by its marker (a sub-$10 price proves it, not the price fallback);
    // gemini-3.1-pro-preview has no marker and is trusted via the price fallback.
    expect(
      classifyModelTier({
        id: "gemini-2.5-pro",
        provider: "google",
        cost: { input: 1.25, output: 5 },
      }),
    ).toBe("trusted");
    expect(
      classifyModelTier({
        id: "gemini-3.1-pro-preview",
        provider: "google",
        cost: { input: 2, output: 12 },
      }),
    ).toBe("trusted");
  });
  it("cheap/small models are weak", () => {
    expect(
      classifyModelTier({
        id: "claude-haiku-4-5",
        provider: "anthropic",
        cost: { input: 1, output: 5 },
      }),
    ).toBe("weak");
    expect(
      classifyModelTier({
        id: "gpt-4o-mini",
        provider: "openai",
        cost: { input: 0.15, output: 0.6 },
      }),
    ).toBe("weak");
    expect(
      classifyModelTier({
        id: "gemini-2.5-flash",
        provider: "google",
        cost: { input: 0.3, output: 2.5 },
      }),
    ).toBe("weak");
  });
  it("unknown / undefined model is weak (fail-safe)", () => {
    expect(classifyModelTier(undefined)).toBe("weak");
    expect(
      classifyModelTier({
        id: "some-local-llama",
        provider: "custom",
        cost: { input: 0, output: 0 },
      }),
    ).toBe("weak");
  });
});
