import { describe, it, expect } from "vitest";
import {
  foldConfusables,
  hasConfusables,
  findConfusablesMatch,
} from "../extensions/loom/confusables";

describe("foldConfusables", () => {
  it("leaves pure ASCII unchanged (returns the same reference)", () => {
    const s = "mcp__brc_analytics__get_organism";
    expect(foldConfusables(s)).toBe(s);
  });

  it("folds the Cyrillic с (U+0441) to Latin c", () => {
    // The captured failure from issue #100: gpt-oss-120b sampled с in place of c.
    const bad = "mcp__brс_analytics__get_organism";
    expect(bad).not.toBe("mcp__brc_analytics__get_organism"); // sanity: not equal as raw strings
    expect(foldConfusables(bad)).toBe("mcp__brc_analytics__get_organism");
  });

  it("folds multiple Cyrillic letters in one name", () => {
    // "р" (U+0440) → p, "о" (U+043E) → o, "а" (U+0430) → a
    const bad = "рора";
    expect(foldConfusables(bad)).toBe("popa");
  });

  it("folds Greek lookalikes ν → v, τ → t", () => {
    expect(foldConfusables("νector")).toBe("vector");
    expect(foldConfusables("geτ_data")).toBe("get_data");
  });

  it("folds uppercase Cyrillic (А, Е, О, Р, С, Х, У)", () => {
    expect(foldConfusables("Саll")).toBe("Call");
  });
});

describe("hasConfusables", () => {
  it("returns false for pure ASCII", () => {
    expect(hasConfusables("mcp__brc_analytics__get_organism")).toBe(false);
    expect(hasConfusables("")).toBe(false);
  });

  it("returns true when any confusable codepoint is present", () => {
    expect(hasConfusables("mcp__brс_analytics__get_organism")).toBe(true);
  });

  it("returns false for non-Latin chars that aren't in the confusables map", () => {
    // Chinese / emoji / unrelated unicode shouldn't trigger
    expect(hasConfusables("zh_中文_tool")).toBe(false);
  });
});

describe("findConfusablesMatch", () => {
  const candidates = [
    "mcp__brc_analytics__get_organism",
    "mcp__brc_analytics__search_organisms",
    "mcp__galaxy__run_tool",
    "web_search",
  ];

  it("returns the canonical name when the bad name folds to one of the candidates", () => {
    const bad = "mcp__brс_analytics__get_organism";
    expect(findConfusablesMatch(bad, candidates)).toBe("mcp__brc_analytics__get_organism");
  });

  it("returns undefined when the bad name has confusables but doesn't fold to any candidate", () => {
    const bad = "fоo_bаr"; // "foo_bar" — not in candidates
    expect(findConfusablesMatch(bad, candidates)).toBeUndefined();
  });

  it("returns undefined when the bad name is plain ASCII and unmatched (real hallucination)", () => {
    // No confusables → not our problem to solve.
    expect(findConfusablesMatch("totally_made_up_tool", candidates)).toBeUndefined();
  });

  it("returns undefined when the bad name is plain ASCII and DOES match (no confusables = no suggestion needed)", () => {
    // The real tool was called correctly; nothing to suggest.
    expect(findConfusablesMatch("mcp__brc_analytics__get_organism", candidates)).toBeUndefined();
  });

  it("handles the second case from the captured trace (search_organisms)", () => {
    const bad = "mcp__brс_analytics__search_organisms";
    expect(findConfusablesMatch(bad, candidates)).toBe("mcp__brc_analytics__search_organisms");
  });
});
