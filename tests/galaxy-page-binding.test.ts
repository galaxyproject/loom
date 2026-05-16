import { describe, expect, it } from "vitest";
import {
  findGalaxyPageBlocks,
  renderGalaxyPageBlock,
  stripGalaxyPageBlocks,
  upsertGalaxyPageBlock,
  type GalaxyPageBindingYaml,
} from "../extensions/loom/galaxy-page-binding";

function binding(overrides: Partial<GalaxyPageBindingYaml> = {}): GalaxyPageBindingYaml {
  return {
    pageId: "page-abc",
    pageSlug: "my-analysis",
    galaxyServerUrl: "https://usegalaxy.org",
    historyId: "hist-123",
    lastSyncedRevision: null,
    boundAt: "2026-05-14T11:00:00Z",
    ...overrides,
  };
}

describe("renderGalaxyPageBlock", () => {
  it("emits the fenced loom-galaxy-page grammar", () => {
    const out = renderGalaxyPageBlock(binding());
    expect(out).toBe(
      [
        "```loom-galaxy-page",
        "page_id: page-abc",
        "page_slug: my-analysis",
        'galaxy_server_url: "https://usegalaxy.org"',
        "history_id: hist-123",
        "last_synced_revision: ",
        "bound_at: 2026-05-14T11:00:00Z",
        "```",
        "",
      ].join("\n"),
    );
  });

  it("quotes server URLs because they contain a colon", () => {
    const out = renderGalaxyPageBlock(binding());
    expect(out).toContain('galaxy_server_url: "https://usegalaxy.org"');
  });

  it("emits null slug and revision as empty values", () => {
    const out = renderGalaxyPageBlock(
      binding({ pageSlug: null, lastSyncedRevision: null }),
    );
    expect(out).toContain("page_slug: \n");
    expect(out).toContain("last_synced_revision: \n");
  });

  it("emits the revision when present", () => {
    const out = renderGalaxyPageBlock(binding({ lastSyncedRevision: "rev-789" }));
    expect(out).toContain("last_synced_revision: rev-789");
  });
});

describe("findGalaxyPageBlocks round-trips render output", () => {
  it("parses a single block", () => {
    const content = renderGalaxyPageBlock(binding({ lastSyncedRevision: "rev-1" }));
    const found = findGalaxyPageBlocks(content);
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual(binding({ lastSyncedRevision: "rev-1" }));
  });

  it("parses multiple blocks in document order", () => {
    const a = renderGalaxyPageBlock(binding({ pageId: "page-A" }));
    const b = renderGalaxyPageBlock(binding({ pageId: "page-B" }));
    const found = findGalaxyPageBlocks(`# notebook\n\n${a}\nsome prose\n\n${b}`);
    expect(found.map((f) => f.pageId)).toEqual(["page-A", "page-B"]);
  });

  it("skips blocks missing required fields", () => {
    const broken = "```loom-galaxy-page\npage_slug: orphan\n```\n";
    expect(findGalaxyPageBlocks(broken)).toEqual([]);
  });

  it("returns [] when no block is present", () => {
    expect(findGalaxyPageBlocks("# just markdown\n\nhello\n")).toEqual([]);
  });
});

describe("upsertGalaxyPageBlock", () => {
  it("appends when no matching block exists", () => {
    const content = "# heading\n\nsome notes\n";
    const out = upsertGalaxyPageBlock(content, binding({ pageId: "page-new" }));
    expect(out).toContain("# heading");
    expect(out).toContain("some notes");
    expect(out).toContain("page_id: page-new");
    expect(out.endsWith("```\n")).toBe(true);
  });

  it("replaces an existing block keyed by page_id, preserving surroundings", () => {
    const existing = renderGalaxyPageBlock(
      binding({ pageId: "page-keep", lastSyncedRevision: "rev-old" }),
    );
    const content = `# heading\n\nbefore\n\n${existing}\nafter\n`;
    const out = upsertGalaxyPageBlock(
      content,
      binding({ pageId: "page-keep", lastSyncedRevision: "rev-new" }),
    );

    // The surroundings stayed put.
    expect(out).toContain("# heading");
    expect(out).toContain("before");
    expect(out).toContain("after");

    // The revision was updated in place — and exactly once.
    expect(out).toContain("last_synced_revision: rev-new");
    expect(out).not.toContain("last_synced_revision: rev-old");

    // No duplicate block was appended.
    const blocks = findGalaxyPageBlocks(out);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].pageId).toBe("page-keep");
    expect(blocks[0].lastSyncedRevision).toBe("rev-new");
  });

  it("supports multiple distinct page bindings keyed independently", () => {
    let content = "# notebook\n";
    content = upsertGalaxyPageBlock(content, binding({ pageId: "page-A" }));
    content = upsertGalaxyPageBlock(content, binding({ pageId: "page-B" }));

    let blocks = findGalaxyPageBlocks(content);
    expect(blocks.map((b) => b.pageId).sort()).toEqual(["page-A", "page-B"]);

    // Updating B leaves A intact.
    content = upsertGalaxyPageBlock(
      content,
      binding({ pageId: "page-B", lastSyncedRevision: "rev-B2" }),
    );
    blocks = findGalaxyPageBlocks(content);
    expect(blocks).toHaveLength(2);
    expect(blocks.find((b) => b.pageId === "page-A")!.lastSyncedRevision).toBeNull();
    expect(blocks.find((b) => b.pageId === "page-B")!.lastSyncedRevision).toBe("rev-B2");
  });

  it("works on empty content (no leading blank line needed)", () => {
    const out = upsertGalaxyPageBlock("", binding());
    expect(out.startsWith("```loom-galaxy-page")).toBe(true);
    expect(findGalaxyPageBlocks(out)).toHaveLength(1);
  });
});

describe("stripGalaxyPageBlocks", () => {
  it("removes a single block and its trailing blank line", () => {
    const content =
      "# heading\n\n" + renderGalaxyPageBlock(binding()) + "\nafter\n";
    const out = stripGalaxyPageBlocks(content);
    expect(out).not.toContain("loom-galaxy-page");
    expect(out).not.toContain("page_id");
    expect(out).toContain("# heading");
    expect(out).toContain("after");
  });

  it("removes multiple blocks", () => {
    const content =
      renderGalaxyPageBlock(binding({ pageId: "A" })) +
      "\nmiddle prose\n\n" +
      renderGalaxyPageBlock(binding({ pageId: "B" }));
    const out = stripGalaxyPageBlocks(content);
    expect(out).not.toContain("loom-galaxy-page");
    expect(out).toContain("middle prose");
  });

  it("leaves loom-invocation blocks alone", () => {
    const content =
      "```loom-invocation\ninvocation_id: inv-1\nstatus: in_progress\n```\n\n" +
      renderGalaxyPageBlock(binding());
    const out = stripGalaxyPageBlocks(content);
    expect(out).toContain("loom-invocation");
    expect(out).toContain("invocation_id: inv-1");
    expect(out).not.toContain("loom-galaxy-page");
  });

  it("is a no-op when no binding block is present", () => {
    const content = "# heading\n\nbody\n";
    expect(stripGalaxyPageBlocks(content)).toBe(content);
  });
});
