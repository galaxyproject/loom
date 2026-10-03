import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerProgressUpdates, PROGRESS_INTERVAL_MS } from "../extensions/loom/progress-updates";

function harness(hasUI = true) {
  const on = vi.fn();
  const notify = vi.fn();
  registerProgressUpdates({ on } as unknown as ExtensionAPI);
  const context = { hasUI, ui: { notify } } as unknown as ExtensionContext;
  return {
    notify,
    fire: (name: string, event = {}) => on.mock.calls.find(([n]) => n === name)![1](event, context),
  };
}
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("user-visible progress without model calls", () => {
  it("shows the first operation and a factual heartbeat during a long silent turn", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.fire("agent_start");
    h.fire("tool_execution_start", {
      toolCallId: "x",
      toolName: "mcp__galaxy__run_user_tool",
      args: { secret: "do-not-display" },
    });
    expect(h.notify).toHaveBeenCalledWith("Progress: submitting work to Galaxy.", "info");
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS);
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(h.notify.mock.calls[1][0]).toContain("Currently submitting work to Galaxy");
    expect(JSON.stringify(h.notify.mock.calls)).not.toContain("do-not-display");
    h.fire("tool_execution_end", { toolCallId: "x", isError: true });
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS);
    expect(h.notify.mock.calls[2][0]).toContain("1 tool call has returned, including 1 error");
    expect(h.notify.mock.calls[2][0]).toContain("results still require verification");
  });

  it("avoids redundant heartbeats when the assistant just gave a text update", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.fire("agent_start");
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS - 1000);
    h.fire("message_end", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Inputs verified; starting the run." }],
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it.each(["agent_end", "session_start", "session_shutdown"])(
    "stops notifications on %s",
    async (event) => {
      vi.useFakeTimers();
      const h = harness();
      h.fire("agent_start");
      h.fire(event);
      await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS * 3);
      expect(h.notify).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not require a UI or create a model message", async () => {
    vi.useFakeTimers();
    const h = harness(false);
    h.fire("agent_start");
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS);
    expect(h.notify).not.toHaveBeenCalled();
  });
});
