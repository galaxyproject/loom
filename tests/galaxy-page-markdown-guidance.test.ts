import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as state from "../extensions/loom/state";
import { GALAXY_PAGE_MARKDOWN_GUIDANCE } from "../extensions/loom/galaxy-page-markdown-guidance";
import { NOTEBOOK_PUSH_TO_GALAXY_DESCRIPTION } from "../extensions/loom/tools-sync";
import { buildGalaxyPageBindingBlock } from "../extensions/loom/context";

vi.mock("../extensions/loom/state");

let dir: string;

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), "page-guidance-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("GALAXY_PAGE_MARKDOWN_GUIDANCE", () => {
  it("steers toward plain Markdown plus ```galaxy directive blocks", () => {
    expect(GALAXY_PAGE_MARKDOWN_GUIDANCE).toContain("```galaxy");
    expect(GALAXY_PAGE_MARKDOWN_GUIDANCE.toLowerCase()).toContain("plain markdown");
  });

  it("names a real Galaxy directive so the model uses recognized blocks", () => {
    expect(GALAXY_PAGE_MARKDOWN_GUIDANCE).toContain("history_dataset_display");
  });

  it("warns against ```txt and other arbitrary code fences", () => {
    expect(GALAXY_PAGE_MARKDOWN_GUIDANCE).toContain("```txt");
  });
});

describe("notebook_push_to_galaxy tool description", () => {
  // The reported bug is the FIRST push (create), when no binding block exists
  // yet -- so the always-present tool description is where the guidance has to
  // live to take effect at create time.
  it("carries the Galaxy-Flavored-Markdown authoring guidance", () => {
    expect(NOTEBOOK_PUSH_TO_GALAXY_DESCRIPTION).toContain(GALAXY_PAGE_MARKDOWN_GUIDANCE);
  });
});

describe("Galaxy page binding context block", () => {
  // Reinforces the guidance per turn during the update flow, once a binding exists.
  it("surfaces the Galaxy-Flavored-Markdown authoring guidance", async () => {
    const nbPath = join(dir, "notebook.md");
    vi.mocked(state.getNotebookPath).mockReturnValue(nbPath);
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
    writeFileSync(nbPath, nb, "utf-8");
    expect(await buildGalaxyPageBindingBlock()).toContain(GALAXY_PAGE_MARKDOWN_GUIDANCE);
  });
});
