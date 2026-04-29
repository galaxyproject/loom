import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.fn();
const createInterfaceMock = vi.fn(() => ({ on: vi.fn() }));
const existsSyncMock = vi.fn(() => false);
const readdirSyncMock = vi.fn(() => []);

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("node:readline", () => ({
  createInterface: createInterfaceMock,
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: existsSyncMock,
    readdirSync: readdirSyncMock,
  },
}));

vi.mock("node:os", () => ({
  default: {
    homedir: () => "/tmp/home",
  },
}));

function makeProcess(pid: number) {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
  proc.pid = pid;
  proc.stdin = { writable: true, write: vi.fn() };
  proc.stdout = new EventEmitter() as EventEmitter & {
    removeAllListeners: ReturnType<typeof vi.fn>;
  };
  proc.stdout.removeAllListeners = vi.fn();
  proc.stderr = new EventEmitter() as EventEmitter & {
    removeAllListeners: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
  proc.stderr.removeAllListeners = vi.fn();
  proc.stderr.on = vi.fn();
  proc.kill = vi.fn();
  proc.removeAllListeners = vi.fn();
  return proc;
}

describe("AgentManager", () => {
  beforeEach(() => {
    vi.resetModules();
    spawnMock.mockReset();
    createInterfaceMock.mockClear();
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(false);
    readdirSyncMock.mockReset();
    readdirSyncMock.mockReturnValue([]);
  });

  it("restarts in the new cwd without using --continue", async () => {
    const firstProc = makeProcess(101);
    const secondProc = makeProcess(202);
    spawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

    const { AgentManager } = await import("../app/src/main/agent.js");
    const window = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    };

    const manager = new AgentManager(window as any, "/analysis/old");
    manager.start();

    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      "node",
      expect.arrayContaining(["--mode", "rpc"]),
      expect.objectContaining({ cwd: "/analysis/old" }),
    );
    expect(spawnMock.mock.calls[0][1] as string[]).not.toContain("--continue");

    expect(manager.switchCwd("/analysis/new")).toBe(true);

    expect(firstProc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      "node",
      expect.arrayContaining(["--mode", "rpc"]),
      expect.objectContaining({ cwd: "/analysis/new" }),
    );
    expect(spawnMock.mock.calls[1][1] as string[]).not.toContain("--continue");
  });

  it("does not restart when the cwd is unchanged", async () => {
    const firstProc = makeProcess(101);
    spawnMock.mockReturnValue(firstProc);

    const { AgentManager } = await import("../app/src/main/agent.js");
    const window = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    };

    const manager = new AgentManager(window as any, "/analysis/same");
    manager.start();

    expect(manager.switchCwd("/analysis/same")).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(firstProc.kill).not.toHaveBeenCalled();
  });
});
