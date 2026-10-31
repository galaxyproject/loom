import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

// #564: stopping the brain while a prompt's preflight response is still
// pending used to reject that prompt with a plain Error("Agent stopped"),
// which the renderer painted as a chat error. Drives the real AgentManager and
// the real agent:prompt handler; only the process, readline and Electron are
// stubbed.

const { spawnMock, handlers } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
let lineHandler: ((line: string) => void) | null = null;

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  execFile: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock("node:readline", () => ({
  createInterface: () => ({
    on: (event: string, cb: (line: string) => void) => {
      if (event === "line") lineHandler = cb;
    },
  }),
}));

// Electron is installed under app/, not the root test package.
vi.mock("../app/node_modules/electron/index.js", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => "/tmp" },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(""),
    decryptString: () => "",
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    removeHandler: (channel: string) => handlers.delete(channel),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  dialog: {},
  BrowserWindow: { getAllWindows: () => [] },
  shell: {},
  autoUpdater: { on: vi.fn() },
}));

function makeProcess(pid: number) {
  const proc = new EventEmitter() as EventEmitter & Record<string, any>;
  proc.pid = pid;
  proc.stdin = { writable: true, write: vi.fn() };
  proc.stdout = Object.assign(new EventEmitter(), { removeAllListeners: vi.fn() });
  proc.stderr = Object.assign(new EventEmitter(), { removeAllListeners: vi.fn(), on: vi.fn() });
  proc.kill = vi.fn();
  proc.removeAllListeners = vi.fn();
  return proc;
}

async function startedManager() {
  const proc = makeProcess(564);
  spawnMock.mockReturnValue(proc);
  const { AgentManager } = await import("../app/src/main/agent.js");
  const window = { isDestroyed: () => false, setTitle: vi.fn(), webContents: { send: vi.fn() } };
  const manager = new AgentManager(window as any, "/analysis");
  manager.start();
  return { manager, proc, window };
}

describe("stopping the agent is not a chat error (#564)", () => {
  beforeEach(() => {
    vi.resetModules();
    spawnMock.mockReset();
    lineHandler = null;
    handlers.clear();
  });

  it("rejects pending commands with a typed AgentStoppedError", async () => {
    const { manager } = await startedManager();
    const { AgentStoppedError } = await import("../app/src/main/agent.js");
    const pending = manager.sendCommand({ type: "get_state" });
    manager.stop();
    await expect(pending).rejects.toBeInstanceOf(AgentStoppedError);
  });

  it("agent:prompt resolves quietly when the brain is stopped mid-preflight", async () => {
    const { manager, window } = await startedManager();
    const { registerIpcHandlers } = await import("../app/src/main/ipc-handlers.js");
    registerIpcHandlers(manager);
    const prompt = handlers.get("agent:prompt")!({}, "hello");
    manager.stop();
    await expect(prompt).resolves.toBeUndefined();
    // The renderer resets its turn UI off this status event, not off the rejection.
    expect(window.webContents.send).toHaveBeenCalledWith("agent:status", "stopped", undefined);
  });

  it("agent:prompt still rejects on a real preflight failure", async () => {
    const { manager, proc } = await startedManager();
    const { registerIpcHandlers } = await import("../app/src/main/ipc-handlers.js");
    registerIpcHandlers(manager);
    const prompt = handlers.get("agent:prompt")!({}, "hello");
    const sent = JSON.parse(proc.stdin.write.mock.calls.at(-1)![0]);
    lineHandler?.(
      JSON.stringify({
        type: "response",
        id: sent.id,
        command: "prompt",
        success: false,
        error: "Preflight failed",
      }),
    );
    await expect(prompt).rejects.toThrow("Preflight failed");
    manager.stop();
  });
});
