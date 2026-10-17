import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as state from "../extensions/loom/state";
import { buildGalaxyPageBindingBlock } from "../extensions/loom/context";

vi.mock("../extensions/loom/state");

// The block reads the record through the record store, so the fixture is a
// real notebook.md in a scratch dir that the state automock points at.
let dir: string;
let nbPath: string;

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), "context-page-binding-"));
  nbPath = join(dir, "notebook.md");
  vi.mocked(state.getNotebookPath).mockReturnValue(nbPath);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const notebook = (content: string) => writeFileSync(nbPath, content, "utf-8");

describe("buildGalaxyPageBindingBlock", () => {
  it("provides actual page, history, and revision links to the brain", async () => {
    notebook(
      '```loom-galaxy-page\npage_id: 0123456789abcdef\npage_slug:\ngalaxy_server_url: "https://example.org/galaxy"\nhistory_id: 0123456789abcdeffedcba9876543210\nlast_synced_revision: abcdef0123456789\nbound_at: 2026-09-23T18:18:00.000Z\n```',
    );
    const out = await buildGalaxyPageBindingBlock();
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

  it("returns empty string when no notebook path", async () => {
    vi.mocked(state.getNotebookPath).mockReturnValue(null);
    expect(await buildGalaxyPageBindingBlock()).toBe("");
  });

  it("returns empty string when notebook has no binding", async () => {
    notebook("# Just text\n");
    expect(await buildGalaxyPageBindingBlock()).toBe("");
  });

  it("formats binding info when present", async () => {
    notebook(
      [
        "```loom-galaxy-page",
        "page_id: p1",
        'page_slug: "my-analysis"',
        'galaxy_server_url: "https://galaxy.example"',
        "history_id: h1",
        "last_synced_revision: r3",
        'bound_at: "2026-05-20T10:00:00Z"',
        "```",
        "",
      ].join("\n"),
    );
    const out = await buildGalaxyPageBindingBlock();
    expect(out).toContain("Galaxy page binding");
    expect(out).toContain("p1");
    expect(out).toContain("my-analysis");
    expect(out).toContain("https://galaxy.example");
    expect(out).toContain("notebook_push_to_galaxy");
    expect(out).toContain("notebook_pull_from_galaxy");
  });
});
