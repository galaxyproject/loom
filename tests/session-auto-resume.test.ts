import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

vi.mock("../extensions/loom/state.js", () => ({
  resetState: vi.fn(),
  initSessionArtifacts: vi.fn(),
  getNotebookPath: vi.fn(() => null),
  stopWatchingNotebook: vi.fn(),
}));
vi.mock("../extensions/loom/galaxy-poller.js", () => ({
  startGalaxyPoller: vi.fn(),
  stopGalaxyPoller: vi.fn(),
  setPollTickHook: vi.fn(),
}));
vi.mock("../extensions/loom/galaxy-page-sync.js", () => ({
  initGalaxyPageSync: vi.fn(),
  flushNotebookToGalaxy: vi.fn(),
}));
vi.mock("../extensions/loom/galaxy-cred-drift.js", () => ({ maybeNudgeGalaxyReconnect: vi.fn() }));
vi.mock("../extensions/loom/config", () => ({ loadConfig: vi.fn(() => ({})) }));
// Opening the real registry would take a lock under the test runner's cwd.
vi.mock("../extensions/loom/registry-runtime.js", () => ({
  openSessionRegistry: vi.fn(() => ({ session: { store: { mode: "writer" } }, notice: null })),
  closeSessionRegistry: vi.fn(),
}));

import { startGalaxyPoller } from "../extensions/loom/galaxy-poller.js";
import { getNotebookPath } from "../extensions/loom/state.js";
import { openSessionRegistry } from "../extensions/loom/registry-runtime.js";
import { registerSessionLifecycle } from "../extensions/loom/session-lifecycle";
import { registerCommandsAsUserInput } from "../extensions/loom/auto-resume";
import { profileFromEnv, setCapabilityProfile } from "../shared/capability-profile.js";

type SessionHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;

async function start(hasUI = true) {
  const handlers = new Map<string, SessionHandler>();
  const sendUserMessage = vi.fn();
  const notify = vi.fn();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
  const pi = {
    on: (name: string, handler: SessionHandler) => handlers.set(name, handler),
    sendUserMessage,
    registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => unknown }) =>
      commands.set(name, opts),
  } as unknown as ExtensionAPI;
  registerCommandsAsUserInput(pi);
  pi.registerCommand("execute", { description: "", handler: vi.fn() });
  const ctx = {
    hasUI,
    ui: { setToolsExpanded: vi.fn(), notify },
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => "test-session" },
  } as unknown as ExtensionContext;
  registerSessionLifecycle(pi);
  await handlers.get("session_start")!({}, ctx);
  const emit = (name: string, event: unknown) => handlers.get(name)!(event, ctx);
  return { sendUserMessage, notify, emit, commands };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("LOOM_AUTO_RESUME", undefined);
  vi.stubEnv("LOOM_FRESH_SESSION", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  setCapabilityProfile(null);
  vi.mocked(getNotebookPath).mockReturnValue(null);
});

describe("where session_start opens the approval registry", () => {
  it("is the cwd for a file notebook", async () => {
    vi.mocked(getNotebookPath).mockReturnValue("/elsewhere/notebook.md");
    await start();
    expect(vi.mocked(openSessionRegistry).mock.calls[0][0].analysisDir).toBe(process.cwd());
  });

  it("is the record's own dirname for a page notebook, so two pages in one worker stay apart", async () => {
    setCapabilityProfile({ ...profileFromEnv({}), notebook: "page" });
    vi.mocked(getNotebookPath).mockReturnValue("/pages/p1/notebook.md");
    await start();
    expect(vi.mocked(openSessionRegistry).mock.calls[0][0].analysisDir).toBe("/pages/p1");
  });
});

describe("session Galaxy follow-up wiring", () => {
  it.each([true, false])(
    "queues a turn by default, including headless sessions (hasUI=%s)",
    async (hasUI) => {
      const { sendUserMessage, notify } = await start(hasUI);
      const [toast, resume] = vi.mocked(startGalaxyPoller).mock.calls[0];
      expect(resume).toBeTypeOf("function");
      resume!("Verify finished imports");
      // Pi starts immediately if idle and queues behind active work if busy.
      expect(sendUserMessage).toHaveBeenCalledWith("Verify finished imports", {
        deliverAs: "followUp",
      });
      toast!("Verification queued", "info");
      expect(notify).toHaveBeenCalledTimes(hasUI ? 1 : 0);
    },
  );

  it("keeps explicit opt-out sessions notification-only", async () => {
    vi.stubEnv("LOOM_AUTO_RESUME", "0");
    await start();
    expect(vi.mocked(startGalaxyPoller).mock.calls[0][1]).toBeUndefined();
  });

  const aborted = { messages: [{ role: "assistant", stopReason: "aborted", content: [] }] };
  const resumeFn = () => vi.mocked(startGalaxyPoller).mock.calls[0][1]!;

  it("pauses after the cap and notifies, until the user types or runs a command", async () => {
    vi.useFakeTimers();
    const { sendUserMessage, notify, emit, commands } = await start();
    // Pi records the sent message, which is delivery; then its turn runs.
    const turn = async (during?: () => void) => {
      const text = sendUserMessage.mock.lastCall![0] as string;
      await emit("message_end", { message: { role: "user", content: [{ type: "text", text }] } });
      await emit("agent_start", {});
      during?.();
      await emit("agent_settled", {});
      vi.advanceTimersByTime(1500);
    };
    resumeFn()("auto 0");
    await turn(() => resumeFn()("auto 1"));
    await turn(() => resumeFn()("auto 2"));
    await turn(() => ["auto 3", "auto 4"].forEach((t) => resumeFn()(t)));
    expect(sendUserMessage).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/paused after 3/), "info");

    // The brain's own prompts don't count as the user saying "keep going".
    await emit("input", { type: "input", text: "x", source: "extension" });
    resumeFn()("still paused");
    expect(sendUserMessage).toHaveBeenCalledTimes(3);

    await emit("input", { type: "input", text: "continue", source: "rpc" });
    await emit("agent_start", {});
    resumeFn()("resumed by input");
    expect(sendUserMessage).toHaveBeenCalledTimes(3);
    await emit("agent_settled", {});
    vi.advanceTimersByTime(1500);
    expect(sendUserMessage).toHaveBeenCalledTimes(4);
    expect(sendUserMessage).toHaveBeenLastCalledWith(
      "auto 3\n\nauto 4\n\nstill paused\n\nresumed by input",
      { deliverAs: "followUp" },
    );

    await turn(() => resumeFn()("fill 1"));
    await turn(() => resumeFn()("fill 2"));
    await turn(() => resumeFn()("fill 3"));
    expect(sendUserMessage).toHaveBeenCalledTimes(6);
    expect(notify).toHaveBeenCalledTimes(2);
    await commands.get("execute")!.handler("", {});
    await emit("agent_start", {});
    resumeFn()("resumed by /execute");
    await emit("agent_settled", {});
    vi.advanceTimersByTime(1500);
    expect(sendUserMessage).toHaveBeenLastCalledWith("fill 3\n\nresumed by /execute", {
      deliverAs: "followUp",
    });
  });

  it("stops waking the agent after the user stops a turn, until they speak again", async () => {
    vi.useFakeTimers();
    const { sendUserMessage, emit } = await start();
    await emit("agent_start", {});
    resumeFn()("held during the turn");
    await emit("agent_end", aborted);
    await emit("agent_settled", {});
    resumeFn()("after stop");
    expect(sendUserMessage).not.toHaveBeenCalled();
    await emit("input", { type: "input", text: "go on", source: "interactive" });
    await emit("agent_start", {});
    resumeFn()("after input");
    expect(sendUserMessage).not.toHaveBeenCalled();
    await emit("agent_settled", {});
    vi.advanceTimersByTime(1500);
    expect(sendUserMessage).toHaveBeenCalledExactlyOnceWith(
      "held during the turn\n\nafter stop\n\nafter input",
      {
        deliverAs: "followUp",
      },
    );
  });

  it("lets an explicit opt-out win over user input", async () => {
    vi.stubEnv("LOOM_AUTO_RESUME", "0");
    const { emit } = await start();
    await emit("input", { type: "input", text: "continue", source: "rpc" });
    expect(vi.mocked(startGalaxyPoller).mock.calls[0][1]).toBeUndefined();
  });
});
