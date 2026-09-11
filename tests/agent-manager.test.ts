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
        const window = {
          isDestroyed: () => false,
          setTitle: vi.fn(),
          webContents: { send: vi.fn() },
        };
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
        const window = {
          isDestroyed: () => false,
          setTitle: vi.fn(),
          webContents: { send: vi.fn() },
        };
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
        const window = {
          isDestroyed: () => false,
          setTitle: vi.fn(),
          webContents: { send: vi.fn() },
        };
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

  /**
   * #439: a deterministic config failure (EX_CONFIG) is not a crash. Retrying
   * it cannot change the answer, and the three silent restarts replaced the
   * brain's own explanation with a generic "crashed repeatedly" box.
   */
  describe("startup failure surfacing (#439)", () => {
    // makeProcess() stubs stderr.on, which would swallow the brain's output
    // before AgentManager could buffer it. These tests need the real emitter.
    function makeProcessWithStderr(pid: number) {
      const proc = makeProcess(pid);
      const stderr = proc.stderr as unknown as EventEmitter;
      proc.stderr.on = stderr.addListener.bind(stderr) as never;
      return proc;
    }

    function statusEvents(window: { webContents: { send: ReturnType<typeof vi.fn> } }) {
      return window.webContents.send.mock.calls.filter((c: unknown[]) => c[0] === "agent:status");
    }

    function makeWindow() {
      return {
        isDestroyed: () => false,
        setTitle: vi.fn(),
        webContents: { send: vi.fn() },
      };
    }

    it("does not retry a config failure, and shows what the brain said", async () => {
      vi.useFakeTimers();
      try {
        const proc = makeProcessWithStderr(101);
        spawnMock.mockReturnValue(proc);

        const { AgentManager } = await import("../app/src/main/agent.js");
        const window = makeWindow();
        const manager = new AgentManager(window as any, "/analysis");
        manager.start();

        proc.stderr.emit(
          "data",
          Buffer.from('loom: provider "openai-codex" requires a sign-in.\n'),
        );
        proc.emit("exit", 78, null);

        // The restart path defers by 100ms; give it every chance to fire.
        vi.advanceTimersByTime(5000);
        expect(spawnMock).toHaveBeenCalledTimes(1);

        // The chat pane is the only surface that renders multi-line text, so
        // the brain's full message goes there...
        const chatError = window.webContents.send.mock.calls.find(
          (c: unknown[]) => c[0] === "agent:event" && (c[1] as { type?: string })?.type === "error",
        );
        expect((chatError?.[1] as { message: string }).message).toContain("requires a sign-in");

        // ...and the width-capped pill gets a one-liner. It must be the LAST
        // status write: the renderer's chat-error handler resets the badge to a
        // bare "error", so a summary sent first would be clobbered.
        const last = statusEvents(window).at(-1);
        expect(last?.[1]).toBe("error");
        expect(last?.[2]).toContain("requires a sign-in");
        expect(last?.[2]).not.toContain("\n");
        // The generic crash text is precisely what this replaces.
        expect(last?.[2]).not.toContain("crashed repeatedly");
      } finally {
        vi.useRealTimers();
      }
    });

    it("still retries an ordinary crash", async () => {
      vi.useFakeTimers();
      try {
        const first = makeProcessWithStderr(101);
        const second = makeProcessWithStderr(202);
        spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

        const { AgentManager } = await import("../app/src/main/agent.js");
        const window = makeWindow();
        const manager = new AgentManager(window as any, "/analysis");
        manager.start();

        // Exit 1 stays "something went wrong" -- a transient fault earns a retry.
        first.emit("exit", 1, null);
        vi.advanceTimersByTime(200);

        expect(spawnMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("attaches the stderr tail once the retry budget is spent", async () => {
      vi.useFakeTimers();
      try {
        const procs = [101, 202, 303, 404].map(makeProcessWithStderr);
        spawnMock.mockImplementation(() => procs.shift()!);
        const all = [...procs];

        const { AgentManager } = await import("../app/src/main/agent.js");
        const window = makeWindow();
        const manager = new AgentManager(window as any, "/analysis");
        manager.start();

        // Three restarts are allowed in the window; the fourth exit gives up.
        for (const proc of all) {
          proc.stderr.emit("data", Buffer.from("pi: connection reset by peer\n"));
          proc.emit("exit", 1, null);
          vi.advanceTimersByTime(200);
        }

        const last = statusEvents(window).at(-1);
        expect(last?.[1]).toBe("error");
        expect(last?.[2]).toContain("crashed repeatedly");
        // The stderr rides the chat channel, not the pill.
        expect(last?.[2]).not.toContain("connection reset by peer");
        const chatError = window.webContents.send.mock.calls
          .filter(
            (c: unknown[]) =>
              c[0] === "agent:event" && (c[1] as { type?: string })?.type === "error",
          )
          .at(-1);
        expect((chatError?.[1] as { message: string }).message).toContain(
          "connection reset by peer",
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
