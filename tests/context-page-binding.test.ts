import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as state from "../extensions/loom/state";
import { buildGalaxyPageBindingBlock } from "../extensions/loom/context";

vi.mock("../extensions/loom/state");
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, readFileSync: vi.fn() };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildGalaxyPageBindingBlock", () => {
  it("provides actual page, history, and revision links to the brain", () => {
    vi.mocked(state.getNotebookPath).mockReturnValue("/work/notebook.md");
    vi.mocked(fs.readFileSync).mockReturnValue(
      '```loom-galaxy-page\npage_id: 0123456789abcdef\npage_slug:\ngalaxy_server_url: "https://example.org/galaxy"\nhistory_id: 0123456789abcdeffedcba9876543210\nlast_synced_revision: abcdef0123456789\nbound_at: 2026-09-23T18:18:00.000Z\n```',
    );
    const out = buildGalaxyPageBindingBlock();
    expect(out).toContain(
      "[0123456789abcdef](https://example.org/galaxy/published/page?id=0123456789abcdef)",
    );
    expect(out).toContain(
      "[0123456789abcdeffedcba9876543210](https://example.org/galaxy/histories/view?id=0123456789abcdeffedcba9876543210)",
    );
    expect(out).toContain(
      "[abcdef0123456789](https://example.org/galaxy/api/pages/0123456789abcdef/revisions/abcdef0123456789)",
    );
  });

  it("returns empty string when no notebook path", () => {
    vi.mocked(state.getNotebookPath).mockReturnValue(null);
    expect(buildGalaxyPageBindingBlock()).toBe("");
  });

  it("returns empty string when notebook has no binding", () => {
    vi.mocked(state.getNotebookPath).mockReturnValue("/work/notebook.md");
    vi.mocked(fs.readFileSync).mockReturnValue("# Just text\n" as never);
    expect(buildGalaxyPageBindingBlock()).toBe("");
  });

  it("formats binding info when present", () => {
    vi.mocked(state.getNotebookPath).mockReturnValue("/work/notebook.md");
    const nb = [
      "```loom-galaxy-page",
      "page_id: p1",
      'page_slug: "my-analysis"',
      'galaxy_server_url: "https://galaxy.example"',
      "history_id: h1",
      "last_synced_revision: r3",
      'bound_at: "2026-05-20T10:00:00Z"',
      "```",
      "",
    ].join("\n");
    vi.mocked(fs.readFileSync).mockReturnValue(nb as never);
    const out = buildGalaxyPageBindingBlock();
    expect(out).toContain("Galaxy page binding");
    expect(out).toContain("p1");
    expect(out).toContain("my-analysis");
    expect(out).toContain("https://galaxy.example");
    expect(out).toContain("notebook_push_to_galaxy");
    expect(out).toContain("notebook_pull_from_galaxy");
  });
});
