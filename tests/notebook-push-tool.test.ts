import { describe, it, expect, vi } from "vitest";
import * as sync from "../extensions/loom/galaxy-pages-sync";

vi.mock("../extensions/loom/galaxy-pages-sync");

interface ToolDef {
    name: string;
    label?: string;
    execute: (
        callId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: Record<string, unknown>,
    ) => Promise<{ content: { type: string; text: string }[]; details?: unknown }>;
}

function makeFakeApi() {
    const tools: ToolDef[] = [];
    return {
        api: {
            registerTool: (def: ToolDef) => {
                tools.push(def);
            },
            registerCommand: vi.fn(),
            sendUserMessage: vi.fn(),
        },
        tools,
    };
}

describe("notebook_push_to_galaxy tool", () => {
    it("registers with expected label and forwards args to pushNotebookToGalaxy", async () => {
        const { api, tools } = makeFakeApi();
        const { registerNotebookSyncTools } = await import(
            "../extensions/loom/tools-sync"
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        registerNotebookSyncTools(api as any);

        const tool = tools.find((t) => t.name === "notebook_push_to_galaxy");
        expect(tool).toBeDefined();
        expect(tool!.label).toBe("Push notebook to Galaxy page");

        vi.mocked(sync.pushNotebookToGalaxy).mockResolvedValue({
            pageId: "p1",
            pageSlug: "a",
            latestRevisionId: "r1",
            action: "created",
        });
        const result = await tool!.execute(
            "call-1",
            { history_id: "h1", title: "A" },
            new AbortController().signal,
            vi.fn(),
            {},
        );

        expect(sync.pushNotebookToGalaxy).toHaveBeenCalledWith({
            historyId: "h1",
            title: "A",
            slug: undefined,
            annotation: undefined,
        });
        expect(result.content[0].text).toContain("p1");
        expect(result.content[0].text).toContain("created");
    });
});
