import { describe, it, expect } from "vitest";
import {
  loomToGalaxyMarkdown,
  galaxyMarkdownToLoom,
  loomToGalaxyMarkdownRich,
} from "../extensions/loom/galaxy-markdown-adapter";

const NOTEBOOK = [
  "# chrM Variant Calling",
  "",
  "## Plan A: chrM Variant Calling [hybrid]",
  "",
  "- [x] {#plan-a-step-2} BWA alignment",
  "",
  "```loom-invocation",
  "invocation_id: abc123",
  "galaxy_server_url: https://test.galaxyproject.org",
  "notebook_anchor: plan-a-step-2",
  "label: BWA alignment",
  "submitted_at: 2026-05-29T12:00:00Z",
  "status: completed",
  "```",
  "",
  "| sample | mapped % |",
  "|--------|----------|",
  "| s1     | 96.2     |",
].join("\n");

describe("galaxy-markdown-adapter -- push", () => {
  it("replaces the loom-invocation fence with a hidden carrier and leaves narrative intact", () => {
    const out = loomToGalaxyMarkdown(NOTEBOOK);
    expect(out).not.toContain("```loom-invocation");
    expect(out).toMatch(/^\[loom-invocation:v1\]: #loom "[A-Za-z0-9+/=]+"$/m);
    expect(out).toContain("## Plan A: chrM Variant Calling [hybrid]");
    expect(out).toContain("- [x] {#plan-a-step-2} BWA alignment");
    expect(out).toContain("| s1     | 96.2     |");
  });
});

describe("galaxy-markdown-adapter -- round trip", () => {
  it("loom -> galaxy -> loom is the identity", () => {
    expect(galaxyMarkdownToLoom(loomToGalaxyMarkdown(NOTEBOOK))).toBe(NOTEBOOK);
  });

  it("is a no-op on content with no invocation blocks", () => {
    const plain = "# Title\n\nsome prose\n";
    expect(loomToGalaxyMarkdown(plain)).toBe(plain);
    expect(galaxyMarkdownToLoom(plain)).toBe(plain);
  });

  it("does not decode carrier-like syntax that appears inline in prose", () => {
    // A notebook documenting Loom's own format must survive the round trip: an
    // inline mention of the carrier is not a real (standalone-line) carrier.
    const prose = [
      "# Format docs",
      "",
      'On push, Loom emits `[loom-invocation:v1]: #loom "YWJj"` for each block.',
      "",
    ].join("\n");
    expect(loomToGalaxyMarkdown(prose)).toBe(prose);
    expect(galaxyMarkdownToLoom(prose)).toBe(prose);
  });

  it("preserves a human-authored ```galaxy fence on pull", () => {
    // A narrative galaxy directive someone wrote by hand (no carrier following)
    // must survive -- only Loom's own directives, which sit directly above a
    // carrier, get stripped.
    const authored = [
      "# Notes",
      "",
      "Example of a Galaxy directive you can use:",
      "",
      "```galaxy",
      "history_dataset_display(history_dataset_id=abc)",
      "```",
      "",
      "more prose",
      "",
    ].join("\n");
    expect(galaxyMarkdownToLoom(authored)).toBe(authored);
  });

  it("strips Loom's directive but keeps an adjacent human-authored ```galaxy fence", async () => {
    const human = ["```galaxy", "history_dataset_display(history_dataset_id=abc)", "```"].join(
      "\n",
    );
    const pushed = await loomToGalaxyMarkdownRich(NOTEBOOK, { isValid: async () => true });
    // Drop a hand-authored galaxy fence into the pushed page (with a blank line,
    // as a human would), then pull.
    const pulled = galaxyMarkdownToLoom(`${human}\n\n${pushed}`);
    expect(pulled).toContain("history_dataset_display(history_dataset_id=abc)");
    expect(pulled).toContain("```loom-invocation");
    expect(pulled).not.toContain("invocation_outputs(");
  });

  it("handles multiple invocation blocks", () => {
    const two =
      NOTEBOOK +
      "\n\n```loom-invocation\ninvocation_id: def456\ngalaxy_server_url: https://test.galaxyproject.org\nnotebook_anchor: plan-a-step-3\nlabel: calling\nsubmitted_at: 2026-05-29T13:00:00Z\nstatus: in_progress\n```\n";
    const pushed = loomToGalaxyMarkdown(two);
    expect((pushed.match(/^\[loom-invocation:v1\]: #loom "/gm) ?? []).length).toBe(2);
    expect(galaxyMarkdownToLoom(pushed)).toBe(two);
  });
});

describe("galaxy-markdown-adapter -- rich push", () => {
  it("emits a galaxy directive when the invocation id validates, plus the carrier", async () => {
    const out = await loomToGalaxyMarkdownRich(NOTEBOOK, { isValid: async () => true });
    expect(out).toContain("```galaxy");
    expect(out).toContain("invocation_outputs(invocation_id=abc123)");
    expect(out).toMatch(/^\[loom-invocation:v1\]: #loom "[A-Za-z0-9+/=]+"$/m);
    // round trip still restores the original, stripping the directive
    expect(galaxyMarkdownToLoom(out)).toBe(NOTEBOOK);
  });

  it("omits the directive when the id does not validate, but keeps the carrier", async () => {
    const out = await loomToGalaxyMarkdownRich(NOTEBOOK, { isValid: async () => false });
    expect(out).not.toContain("```galaxy");
    expect(out).toMatch(/^\[loom-invocation:v1\]: #loom "[A-Za-z0-9+/=]+"$/m);
    expect(galaxyMarkdownToLoom(out)).toBe(NOTEBOOK);
  });

  it("omits the directive without calling the validator when the block has no invocation_id", async () => {
    const noId = [
      "# Notes",
      "",
      "```loom-invocation",
      "galaxy_server_url: https://test.galaxyproject.org",
      "notebook_anchor: plan-a-step-2",
      "label: BWA alignment",
      "status: completed",
      "```",
      "",
    ].join("\n");
    const validator = {
      isValid: async () => {
        throw new Error("validator must not be consulted when there is no invocation_id");
      },
    };
    const out = await loomToGalaxyMarkdownRich(noId, validator);
    expect(out).not.toContain("```galaxy");
    expect(out).toMatch(/^\[loom-invocation:v1\]: #loom "[A-Za-z0-9+/=]+"$/m);
    expect(galaxyMarkdownToLoom(out)).toBe(noId);
  });
});
