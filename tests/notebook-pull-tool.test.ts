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

describe("notebook_pull_from_galaxy tool", () => {
  it("forwards to pullNotebookFromGalaxy", async () => {
    const tools: ToolDef[] = [];
    const api = {
      registerTool: (d: ToolDef) => tools.push(d),
      registerCommand: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const { registerNotebookSyncTools } = await import("../extensions/loom/tools-sync");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerNotebookSyncTools(api as any);
    const tool = tools.find((t) => t.name === "notebook_pull_from_galaxy");
    expect(tool).toBeDefined();

    vi.mocked(sync.pullNotebookFromGalaxy).mockResolvedValue({
      pageId: "p1",
      latestRevisionId: "r2",
    });
    const result = await tool!.execute("c1", {}, new AbortController().signal, vi.fn(), {});

    expect(sync.pullNotebookFromGalaxy).toHaveBeenCalledWith();
    expect(result.content[0].text).toContain("r2");
  });
});
