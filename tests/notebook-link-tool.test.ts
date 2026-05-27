import { describe, it, expect, vi } from "vitest";
import * as sync from "../extensions/loom/galaxy-pages-sync";

vi.mock("../extensions/loom/galaxy-pages-sync");

interface ToolDef {
    name: string;
    execute: (
        callId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: Record<string, unknown>,
    ) => Promise<{ content: { type: string; text: string }[]; details?: unknown }>;
}

describe("notebook_link_galaxy_page tool", () => {
    it("forwards page_id and optional history_id to linkGalaxyPage", async () => {
        const tools: ToolDef[] = [];
        const api = {
            registerTool: (d: ToolDef) => tools.push(d),
            registerCommand: vi.fn(),
            sendUserMessage: vi.fn(),
        };
        const { registerNotebookSyncTools } = await import(
            "../extensions/loom/tools-sync"
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        registerNotebookSyncTools(api as any);
        const tool = tools.find((t) => t.name === "notebook_link_galaxy_page");
        expect(tool).toBeDefined();

        vi.mocked(sync.linkGalaxyPage).mockResolvedValue({
            pageId: "p5",
            latestRevisionId: "r7",
        });
        await tool!.execute(
            "c1",
            { page_id: "p5", history_id: "h5" },
            new AbortController().signal,
            vi.fn(),
            {},
        );
        expect(sync.linkGalaxyPage).toHaveBeenCalledWith("p5", {
            historyId: "h5",
        });
    });
});
