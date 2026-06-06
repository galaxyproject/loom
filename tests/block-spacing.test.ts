import { describe, expect, it } from "vitest";
import { joinTextBlocks } from "../app/src/renderer/chat/block-spacing.js";

/**
 * Issue #200: a multi-step assistant turn (text → tool call → text → …) streams
 * each text block into one accumulating buffer. Without a separator between
 * blocks the rendered markdown collapses into one dense paragraph, e.g.
 * "…upload to Galaxy.Creating the conda env…" with "Galaxy.Creating" butted
 * together. `joinTextBlocks` inserts a paragraph break (blank line) between the
 * previous prose and the next block so marked renders them as separate <p>s.
 */
describe("joinTextBlocks", () => {
  it("separates two prose blocks with a blank line", () => {
    expect(joinTextBlocks("first block", "second block")).toBe("first block\n\nsecond block");
  });

  it("fixes the reported run-together case (Galaxy.Creating)", () => {
    const prev = "I'll install FastQC locally and upload to Galaxy.";
    const next = "Creating the conda env and uploading to Galaxy in parallel.";
    expect(joinTextBlocks(prev, next)).toBe(`${prev}\n\n${next}`);
  });

  it("does not add a leading break when there is no previous prose", () => {
    expect(joinTextBlocks("", "first block")).toBe("first block");
  });

  it("treats whitespace-only previous text as empty (no leading break)", () => {
    expect(joinTextBlocks("   \n  ", "first block")).toBe("first block");
  });

  it("collapses the model's own trailing newline into a single break", () => {
    expect(joinTextBlocks("done.\n", "next")).toBe("done.\n\nnext");
  });

  it("does not double the break when previous already ends with a blank line", () => {
    expect(joinTextBlocks("done.\n\n", "next")).toBe("done.\n\nnext");
  });

  it("strips leading whitespace on the next block so the break stays single", () => {
    expect(joinTextBlocks("done.", "\n\nCreating…")).toBe("done.\n\nCreating…");
  });

  it("keeps the break pending when the next block starts with only whitespace", () => {
    // First delta of a new block is whitespace; the break is applied now and
    // the real text appended by the following (normal) delta lands after it.
    expect(joinTextBlocks("done.", "  ")).toBe("done.\n\n");
  });

  it("preserves internal structure of the next block", () => {
    expect(joinTextBlocks("intro", "- a\n- b")).toBe("intro\n\n- a\n- b");
  });
});
