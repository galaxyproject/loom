import { describe, it, expect } from "vitest";
import {
  loomToGalaxyMarkdown,
  galaxyMarkdownToLoom,
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
    expect(out).toMatch(/<!-- loom-invocation:v1 [A-Za-z0-9+/=]+ -->/);
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

  it("handles multiple invocation blocks", () => {
    const two =
      NOTEBOOK +
      "\n\n```loom-invocation\ninvocation_id: def456\ngalaxy_server_url: https://test.galaxyproject.org\nnotebook_anchor: plan-a-step-3\nlabel: calling\nsubmitted_at: 2026-05-29T13:00:00Z\nstatus: in_progress\n```\n";
    const pushed = loomToGalaxyMarkdown(two);
    expect((pushed.match(/<!-- loom-invocation:v1 /g) ?? []).length).toBe(2);
    expect(galaxyMarkdownToLoom(pushed)).toBe(two);
  });
});
