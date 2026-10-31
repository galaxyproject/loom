import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// An eval's json-mode run quits right after the model's last reply, often before the poller's
// next tick: the env knob makes shutdown wait (bounded) for in-flight runs first.
const order: string[] = [];
vi.mock("../extensions/orbit/state.js", () => ({
  resetState: vi.fn(),
  initSessionArtifacts: vi.fn(),
  getNotebookPath: vi.fn(() => null),
  stopWatchingNotebook: vi.fn(),
}));
vi.mock("../extensions/orbit/galaxy-poller.js", () => ({
  startGalaxyPoller: vi.fn(),
  stopGalaxyPoller: vi.fn(() => order.push("stop")),
  drainGalaxyPoller: vi.fn(async () => (order.push("drain"), true)),
  setPollTickHook: vi.fn(),
}));
vi.mock("../extensions/orbit/registry-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../extensions/orbit/registry-runtime.js")>()),
  recordActiveAtShutdown: vi.fn(() => (order.push("orphans"), [])),
}));

import * as poller from "../extensions/orbit/galaxy-poller.js";
import { registerSessionLifecycle } from "../extensions/orbit/session-lifecycle";

function shutdownHandler() {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const pi = {
    on: (evt: string, handler: (...args: any[]) => any) => (handlers[evt] = handler),
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
  } as any;
  registerSessionLifecycle(pi);
  return handlers["session_shutdown"];
}

describe("session_shutdown drains the poller for an eval run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("drains before stopping the poller and before the orphan snapshot", async () => {
    vi.stubEnv("ORBIT_EVAL_POLLER_DRAIN_MS", "1000");
    await shutdownHandler()({ reason: "quit" }, {});
    expect(poller.drainGalaxyPoller).toHaveBeenCalledWith({ timeoutMs: 1000 });
    expect(order.slice(0, 3)).toEqual(["drain", "orphans", "stop"]);
  });

  it("does not drain without the knob, or on a reload or a new session", async () => {
    await shutdownHandler()({ reason: "quit" }, {});
    vi.stubEnv("ORBIT_EVAL_POLLER_DRAIN_MS", "1000");
    await shutdownHandler()({ reason: "reload" }, {});
    await shutdownHandler()({ reason: "new" }, {});
    vi.stubEnv("ORBIT_EVAL_POLLER_DRAIN_MS", "soon");
    await shutdownHandler()({ reason: "quit" }, {});
    expect(poller.drainGalaxyPoller).not.toHaveBeenCalled();
  });
});
