import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.fn();
// Capture the readline "line" handler so tests can feed brain stdout events
// through handleLine() (the real one is wired in start()).
let lineHandler: ((line: string) => void) | null = null;
const createInterfaceMock = vi.fn(() => ({
  on: (event: string, cb: (line: string) => void) => {
    if (event === "line") lineHandler = cb;
  },
}));
const existsSyncMock = vi.fn(() => false);
const readdirSyncMock = vi.fn(() => []);

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  // execFile is pulled in transitively via agent.ts -> proc-monitor.ts
  // (collectDescendantsOf walks `ps` for the abort-kill path, #64). Tests
  // don't trigger abort, but the import must resolve.
  execFile: vi.fn(),
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

// app/src/main/agent.ts → secure-config.ts imports `electron` at module top.
// Without this stub the test only resolves when `app/node_modules/electron`
// is present, which means CI or a fresh clone has to install app/ deps
// before the root `vitest` can even start. Stub the small surface area we
// transitively use; safeStorageAvailable() reads isEncryptionAvailable().
vi.mock("electron", () => ({
  // agent.ts imports `app` and reads `app?.isPackaged`; false routes it to the
  // dev resolution paths (no packaged bundle). Without this export vitest
  // throws "No 'app' export is defined on the 'electron' mock" in a clean
  // checkout where app/node_modules/electron isn't installed.
  app: { isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(""),
    decryptString: () => "",
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
    lineHandler = null;
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
      setTitle: vi.fn(),
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
      setTitle: vi.fn(),
      webContents: { send: vi.fn() },
    };

    const manager = new AgentManager(window as any, "/analysis/same");
    manager.start();

    expect(manager.switchCwd("/analysis/same")).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(firstProc.kill).not.toHaveBeenCalled();
  });

  describe("stall watchdog (#185)", () => {
    function agentEvents(window: { webContents: { send: ReturnType<typeof vi.fn> } }) {
      return window.webContents.send.mock.calls.filter((c: unknown[]) => c[0] === "agent:event");
    }
    function errorEvents(window: { webContents: { send: ReturnType<typeof vi.fn> } }) {
      return agentEvents(window).filter(
        (c: unknown[]) => (c[1] as { type?: string })?.type === "error",
      );
    }

    it("surfaces a synthetic error when the brain goes silent after a prompt", async () => {
      vi.useFakeTimers();
      try {
        const proc = makeProcess(101);
        spawnMock.mockReturnValue(proc);
        const { AgentManager, TURN_SILENCE_TIMEOUT_MS } = await import("../app/src/main/agent.js");
        const window = { isDestroyed: () => false, setTitle: vi.fn(), webContents: { send: vi.fn() } };
        const manager = new AgentManager(window as any, "/analysis");
        manager.start();

        manager.send({ type: "prompt", message: "How many histories do I have?" });
        expect(errorEvents(window)).toHaveLength(0);

        vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS + 1);

        const errors = errorEvents(window);
        expect(errors).toHaveLength(1);
        expect((errors[0][1] as { message?: string }).message).toMatch(/responding|stalled/i);
        // Best-effort: tell the wedged brain to abort so the next prompt works.
        expect(proc.stdin.write).toHaveBeenCalledWith(expect.stringMatching(/"type":"abort"/));
        // Turn is no longer considered active after recovery.
        expect(manager.getStatusSnapshot().turnActive).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not fire when the brain keeps streaming activity", async () => {
      vi.useFakeTimers();
      try {
        const proc = makeProcess(101);
        spawnMock.mockReturnValue(proc);
        const { AgentManager, TURN_SILENCE_TIMEOUT_MS } = await import("../app/src/main/agent.js");
        const window = { isDestroyed: () => false, setTitle: vi.fn(), webContents: { send: vi.fn() } };
        const manager = new AgentManager(window as any, "/analysis");
        manager.start();

        manager.send({ type: "prompt", message: "hi" });
        // Brain stays alive: an event arrives just before each deadline.
        for (let i = 0; i < 4; i++) {
          vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS - 1);
          lineHandler?.(JSON.stringify({ type: "message_update" }));
        }

        expect(errorEvents(window)).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("disarms on agent_end so a completed turn never false-fires", async () => {
      vi.useFakeTimers();
      try {
        const proc = makeProcess(101);
        spawnMock.mockReturnValue(proc);
        const { AgentManager, TURN_SILENCE_TIMEOUT_MS } = await import("../app/src/main/agent.js");
        const window = { isDestroyed: () => false, setTitle: vi.fn(), webContents: { send: vi.fn() } };
        const manager = new AgentManager(window as any, "/analysis");
        manager.start();

        manager.send({ type: "prompt", message: "hi" });
        lineHandler?.(JSON.stringify({ type: "agent_start" }));
        lineHandler?.(JSON.stringify({ type: "agent_end" }));

        vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS * 3);

        expect(errorEvents(window)).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("sets the window title from the cwd on construction, switch, and setCwd", async () => {
    spawnMock.mockReturnValue(makeProcess(101));

    const { AgentManager } = await import("../app/src/main/agent.js");
    const setTitle = vi.fn();
    const window = {
      isDestroyed: () => false,
      setTitle,
      webContents: { send: vi.fn() },
    };

    // os.homedir() is mocked to "/tmp/home" at the top of this file.
    const manager = new AgentManager(window as any, "/tmp/home/projectA");
    expect(setTitle).toHaveBeenLastCalledWith("~/projectA — Orbit");

    expect(manager.switchCwd("/srv/data/projectB")).toBe(true);
    expect(setTitle).toHaveBeenLastCalledWith("/srv/data/projectB — Orbit");

    manager.setCwd("/tmp/home/projectC");
    expect(setTitle).toHaveBeenLastCalledWith("~/projectC — Orbit");
  });
});
