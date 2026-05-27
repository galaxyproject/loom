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
