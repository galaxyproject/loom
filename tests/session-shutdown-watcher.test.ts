import { beforeEach, describe, expect, it, vi } from "vitest";

// #271: session_shutdown must close the notebook FSWatcher (via
// stopWatchingNotebook) so the dangling watcher stops holding the event loop
// open and --print can exit. Mock state + poller so we observe the wiring
// without touching real fs/git/timers.
vi.mock("../extensions/loom/state.js", () => ({
  resetState: vi.fn(),
  initSessionArtifacts: vi.fn(),
  getNotebookPath: vi.fn(() => null),
  stopWatchingNotebook: vi.fn(),
}));
vi.mock("../extensions/loom/galaxy-poller.js", () => ({
  startGalaxyPoller: vi.fn(),
  stopGalaxyPoller: vi.fn(),
}));

import * as poller from "../extensions/loom/galaxy-poller.js";
import * as state from "../extensions/loom/state.js";
import { registerSessionLifecycle } from "../extensions/loom/session-lifecycle";

function fakePi() {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const pi = {
    on: (evt: string, handler: (...args: any[]) => any) => {
      handlers[evt] = handler;
    },
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
  } as any;
  return { pi, handlers };
}

describe("session_shutdown closes the notebook watcher (#271)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("closes the watcher on shutdown so --print can exit", async () => {
    const { pi, handlers } = fakePi();
    registerSessionLifecycle(pi);

    expect(handlers["session_shutdown"]).toBeTypeOf("function");

    await handlers["session_shutdown"]({}, {});

    expect(poller.stopGalaxyPoller).toHaveBeenCalled();
    expect(state.stopWatchingNotebook).toHaveBeenCalledTimes(1);
  });
});
