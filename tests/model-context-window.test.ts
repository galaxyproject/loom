import { describe, expect, it } from "vitest";
import {
  MIN_USABLE_CONTEXT_WINDOW,
  filterUnusableContextWindows,
} from "../app/src/main/model-context-window.js";

type M = { id: string; contextWindow?: number };
const ids = (models: M[]): string[] => models.map((m) => m.id);

describe("filterUnusableContextWindows", () => {
  it("drops a model whose window can't fit the baseline prompt (#418 gpt-4)", () => {
    const models: M[] = [
      { id: "gpt-4", contextWindow: 8192 },
      { id: "gpt-4o", contextWindow: 128_000 },
    ];
    expect(ids(filterUnusableContextWindows("openai", models))).toEqual(["gpt-4o"]);
  });

  it("drops the whole broken tier (16K/32K), not just 8K", () => {
    const models: M[] = [
      { id: "small-16k", contextWindow: 16_385 },
      { id: "small-32k", contextWindow: 32_768 },
      { id: "big", contextWindow: 128_000 },
    ];
    expect(ids(filterUnusableContextWindows("openrouter", models))).toEqual(["big"]);
  });

  it("keeps every mainstream window", () => {
    const models: M[] = [
      { id: "gpt-4o", contextWindow: 128_000 },
      { id: "claude-opus-5", contextWindow: 200_000 },
      { id: "gemini-3.1-pro", contextWindow: 1_000_000 },
    ];
    expect(filterUnusableContextWindows("anthropic", models)).toHaveLength(3);
  });

  it("keeps the ~64K tier beta testers are on (threshold is not 64K)", () => {
    const models: M[] = [
      { id: "deepseek/deepseek-r1", contextWindow: 64_000 },
      { id: "open-mixtral-8x22b", contextWindow: 64_000 },
      { id: "big", contextWindow: 128_000 },
    ];
    expect(filterUnusableContextWindows("openrouter", models)).toHaveLength(3);
  });

  it("keeps a model sitting exactly on the threshold", () => {
    const models: M[] = [
      { id: "exactly-at", contextWindow: MIN_USABLE_CONTEXT_WINDOW },
      { id: "just-under", contextWindow: MIN_USABLE_CONTEXT_WINDOW - 1 },
    ];
    expect(ids(filterUnusableContextWindows("openai", models))).toEqual(["exactly-at"]);
  });

  it("fails open: a model that reports no window is kept, not dropped", () => {
    const models: M[] = [
      { id: "no-window" },
      { id: "undefined-window", contextWindow: undefined },
      { id: "nan-window", contextWindow: Number.NaN },
      { id: "zero-window", contextWindow: 0 },
      { id: "big", contextWindow: 128_000 },
    ];
    expect(filterUnusableContextWindows("openai", models)).toHaveLength(5);
  });

  it("never empties a provider that has models (would silently hide it)", () => {
    // Every model is under the floor. Returning [] here trips the caller's
    // `if (!models.length) continue` and the provider disappears from the
    // picker with no explanation -- worse than listing a small-window model.
    const models: M[] = [
      { id: "tiny-a", contextWindow: 4_096 },
      { id: "tiny-b", contextWindow: 8_192 },
    ];
    expect(ids(filterUnusableContextWindows("some-provider", models))).toEqual([
      "tiny-a",
      "tiny-b",
    ]);
  });

  it("passes an already-empty list through unchanged", () => {
    expect(filterUnusableContextWindows("ollama", [])).toEqual([]);
    expect(filterUnusableContextWindows("openai", [])).toEqual([]);
  });

  it("exempts local providers, whose registry window is not authoritative", () => {
    // A user can raise num_ctx on a local model; pi's registry number doesn't
    // know that, so filtering on it would hide a model they configured.
    const models: M[] = [
      { id: "qwen3:8b", contextWindow: 8_192 },
      { id: "qwen3-coder:30b", contextWindow: 32_768 },
    ];
    expect(filterUnusableContextWindows("ollama", models)).toHaveLength(2);
  });

  it("does not mutate the input list", () => {
    const models: M[] = [
      { id: "gpt-4", contextWindow: 8_192 },
      { id: "gpt-4o", contextWindow: 128_000 },
    ];
    filterUnusableContextWindows("openai", models);
    expect(models).toHaveLength(2);
  });

  it("keeps the floor above the broken tier and below mainstream models", () => {
    expect(MIN_USABLE_CONTEXT_WINDOW).toBeGreaterThan(32_768);
    expect(MIN_USABLE_CONTEXT_WINDOW).toBeLessThanOrEqual(64_000);
  });
});
