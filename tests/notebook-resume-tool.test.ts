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

describe("notebook_resume_from_galaxy tool", () => {
    it("forwards page_id and optional history_id to resumeGalaxyPage", async () => {
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
        const tool = tools.find((t) => t.name === "notebook_resume_from_galaxy");
        expect(tool).toBeDefined();

        vi.mocked(sync.resumeGalaxyPage).mockResolvedValue({
            pageId: "p99",
            latestRevisionId: "r99",
            action: "linked",
        });
        const result = await tool!.execute(
            "c1",
            { page_id: "p99", history_id: "h99" },
            new AbortController().signal,
            vi.fn(),
            {},
        );
        expect(sync.resumeGalaxyPage).toHaveBeenCalledWith("p99", {
            historyId: "h99",
        });
        const payload = JSON.parse(result.content[0].text) as {
            page_id: string;
            latest_revision_id: string;
            action: string;
        };
        expect(payload).toEqual({
            page_id: "p99",
            latest_revision_id: "r99",
            action: "linked",
        });
    });
});
