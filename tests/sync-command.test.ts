import { describe, it, expect, vi, beforeEach } from "vitest";
import * as notebookWriter from "../extensions/loom/notebook-writer";
import * as state from "../extensions/loom/state";
import * as sync from "../extensions/loom/galaxy-pages-sync";

vi.mock("../extensions/loom/notebook-writer", async (importOriginal) => {
    const actual = await importOriginal<typeof notebookWriter>();
    return { ...actual, readNotebook: vi.fn() };
});
vi.mock("../extensions/loom/state");
vi.mock("../extensions/loom/galaxy-pages-sync");

interface CmdDef {
    description: string;
    handler: (
        args: string,
        ctx: { ui: { notify: ReturnType<typeof vi.fn> } },
    ) => Promise<void>;
}

function makeApi() {
    const commands: Record<string, CmdDef> = {};
    return {
        api: {
            registerCommand: (name: string, def: CmdDef) => {
                commands[name] = def;
            },
            registerTool: vi.fn(),
            sendUserMessage: vi.fn(),
        },
        commands,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("/sync command", () => {
    it("status with no binding reports unbound", async () => {
        vi.mocked(state.getNotebookPath).mockReturnValue("/work/notebook.md");
        vi.mocked(notebookWriter.readNotebook).mockResolvedValue("# No binding\n");
        const { registerSyncCommand } = await import(
            "../extensions/loom/sync-command"
        );
        const { api, commands } = makeApi();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        registerSyncCommand(api as any);

        const ctx = { ui: { notify: vi.fn() } };
        await commands.sync.handler("status", ctx);
        expect(ctx.ui.notify).toHaveBeenCalledWith(
            expect.stringMatching(/not bound/i),
            expect.any(String),
        );
    });

    it("push forwards parsed args to pushNotebookToGalaxy", async () => {
        vi.mocked(sync.pushNotebookToGalaxy).mockResolvedValue({
            pageId: "p1",
            pageSlug: null,
            latestRevisionId: "r1",
            action: "created",
        });
        const { registerSyncCommand } = await import(
            "../extensions/loom/sync-command"
        );
        const { api, commands } = makeApi();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        registerSyncCommand(api as any);

        const ctx = { ui: { notify: vi.fn() } };
        await commands.sync.handler(
            'push --history h1 --title "My Analysis"',
            ctx,
        );
        expect(sync.pushNotebookToGalaxy).toHaveBeenCalledWith({
            historyId: "h1",
            title: "My Analysis",
            slug: undefined,
            annotation: undefined,
        });
    });

    it("pull forwards to pullNotebookFromGalaxy", async () => {
        vi.mocked(sync.pullNotebookFromGalaxy).mockResolvedValue({
            pageId: "p1",
            latestRevisionId: "r2",
        });
        const { registerSyncCommand } = await import(
            "../extensions/loom/sync-command"
        );
        const { api, commands } = makeApi();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        registerSyncCommand(api as any);

        const ctx = { ui: { notify: vi.fn() } };
        await commands.sync.handler("pull", ctx);
        expect(sync.pullNotebookFromGalaxy).toHaveBeenCalled();
    });

    it("link parses page id and optional history", async () => {
        vi.mocked(sync.linkGalaxyPage).mockResolvedValue({
            pageId: "p2",
            latestRevisionId: "r3",
        });
        const { registerSyncCommand } = await import(
            "../extensions/loom/sync-command"
        );
        const { api, commands } = makeApi();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        registerSyncCommand(api as any);

        const ctx = { ui: { notify: vi.fn() } };
        await commands.sync.handler("link p2 --history h2", ctx);
        expect(sync.linkGalaxyPage).toHaveBeenCalledWith("p2", {
            historyId: "h2",
        });
    });

    it("resume parses page id and optional history, reports action", async () => {
        vi.mocked(sync.resumeGalaxyPage).mockResolvedValue({
            pageId: "p7",
            latestRevisionId: "r7",
            action: "linked",
        });
        const { registerSyncCommand } = await import(
            "../extensions/loom/sync-command"
        );
        const { api, commands } = makeApi();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        registerSyncCommand(api as any);

        const ctx = { ui: { notify: vi.fn() } };
        await commands.sync.handler("resume p7 --history h7", ctx);
        expect(sync.resumeGalaxyPage).toHaveBeenCalledWith("p7", {
            historyId: "h7",
        });
        expect(ctx.ui.notify).toHaveBeenCalledWith(
            expect.stringMatching(/Resumed page p7.*linked.*revision r7/),
            "info",
        );
    });

    it("resume without a page id reports usage", async () => {
        const { registerSyncCommand } = await import(
            "../extensions/loom/sync-command"
        );
        const { api, commands } = makeApi();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        registerSyncCommand(api as any);

        const ctx = { ui: { notify: vi.fn() } };
        await commands.sync.handler("resume", ctx);
        expect(sync.resumeGalaxyPage).not.toHaveBeenCalled();
        expect(ctx.ui.notify).toHaveBeenCalledWith(
            expect.stringMatching(/Usage: \/sync resume/),
            "warning",
        );
    });
});
