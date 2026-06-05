import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: { wrapWithSandbox: vi.fn(async (c: string) => c) },
}));
const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));
vi.mock("node:fs", () => ({ existsSync: () => true }));

import { createSandboxedBashOps } from "../extensions/loom/sandbox/sandbox-bash";

describe("createSandboxedBashOps", () => {
  beforeEach(() => spawnMock.mockReset());

  it("rejects an already-aborted signal without spawning", async () => {
    const ac = new AbortController();
    ac.abort();
    const ops = createSandboxedBashOps();
    await expect(
      ops.exec("echo hi", "/tmp", {
        onData: () => {},
        signal: ac.signal,
        timeout: 0,
        env: undefined,
      }),
    ).rejects.toThrow("aborted");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
