import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  GALAXY_POLL_INTERVAL_MS,
  registerGalaxyPollGuard,
} from "../extensions/loom/galaxy-poll-guard";
import {
  createMemoryOutputStore,
  setGalaxyOutputStore,
} from "../extensions/loom/galaxy-output-store";
import { bareFamily } from "../shared/galaxy-mcp-tools.js";

function harness() {
  const on = vi.fn();
  registerGalaxyPollGuard({ on } as unknown as ExtensionAPI);
  const abort = new AbortController();
  const notify = vi.fn();
  const ctx = { hasUI: true, ui: { notify }, signal: abort.signal } as unknown as ExtensionContext;
  const fire = (name: string, event: unknown) =>
    on.mock.calls.find(([n]) => n === name)![1](event, ctx);
  return {
    abort,
    notify,
    fire,
    check: (name = "mcp__galaxy__get_dataset_details", args = { dataset_id: "data1" }) =>
      fire("tool_call", { toolName: name, input: args }),
    result: (state: string, extras = {}) =>
      fire("tool_result", {
        toolName: "mcp__galaxy__get_dataset_details",
        input: { dataset_id: "data1" },
        isError: false,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              data: { dataset: { state, creating_job: "job1" } },
            }),
          },
        ],
        ...extras,
      }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  setGalaxyOutputStore(null);
});

describe("Galaxy polling cooldown", () => {
  it("directs an unfinished response to notebook tracking and preserves the original metadata", () => {
    const h = harness();
    const result = h.result("running");
    expect(result.content).toHaveLength(2);
    expect(result.content[0].text).toContain('"state":"running"');
    expect(result.content[1].text).toContain('"job1"');
    expect(result.content[1].text).toContain("end this turn");
    expect(result.content[1].text).toContain("15 seconds without model calls");
  });

  it("does not dispatch a duplicate for two minutes, without a model-facing retry loop", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.result("queued");
    let released = false;
    const call = h.check().then(() => {
      released = true;
    });
    await vi.advanceTimersByTimeAsync(GALAXY_POLL_INTERVAL_MS - 1);
    expect(released).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await call;
    expect(released).toBe(true);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("cancels a waiting read on Stop instead of issuing the Galaxy request", async () => {
    const h = harness();
    h.result("running");
    const waiting = h.check();
    h.abort.abort();
    expect(await waiting).toMatchObject({ block: true });
  });

  it("does not throttle other datasets, terminal results, or mutations", async () => {
    const h = harness();
    h.result("running");
    expect(
      await h.check("mcp__galaxy__get_dataset_details", { dataset_id: "other" }),
    ).toBeUndefined();
    expect(await h.check("mcp__galaxy__run_tool")).toBeUndefined();
    h.result("ok");
    expect(await h.check()).toBeUndefined();
    h.result("error");
    expect(await h.check()).toBeUndefined();
  });

  it("cancels stale waits on a session change and allows an explicit new user status request", async () => {
    const h = harness();
    h.result("running");
    const waiting = h.check();
    h.fire("session_start", {});
    expect(await waiting).toMatchObject({ block: true });
    expect(await h.check()).toBeUndefined();
    h.result("running");
    h.fire("input", { source: "interactive" });
    expect(await h.check()).toBeUndefined();
  });

  it("does not interpret a failed request as evidence of pending work", async () => {
    const h = harness();
    expect(h.result("running", { isError: true })).toBeUndefined();
    expect(await h.check()).toBeUndefined();
    expect(h.result("running", { details: { error: "call_failed" } })).toBeUndefined();
    expect(await h.check()).toBeUndefined();
  });
});

describe("invocation reads under in-process Galaxy tools", () => {
  function invocationHarness(opts?: { invocations?: boolean }) {
    const on = vi.fn();
    registerGalaxyPollGuard(
      { on } as unknown as ExtensionAPI,
      bareFamily(["get_invocations", "get_dataset_details"]),
      opts,
    );
    const ctx = {
      hasUI: false,
      ui: { notify: vi.fn() },
      signal: new AbortController().signal,
    } as unknown as ExtensionContext;
    const fire = (name: string, event: unknown) =>
      on.mock.calls.find(([n]) => n === name)![1](event, ctx);
    const input = { invocation_id: "inv1" };
    return {
      fire,
      check: (args: Record<string, unknown> = input) =>
        fire("tool_call", { toolName: "get_invocations", input: args }),
      result: (state: string) =>
        fire("tool_result", {
          toolName: "get_invocations",
          input,
          isError: false,
          content: [
            { type: "text", text: JSON.stringify({ success: true, data: { id: "inv1", state } }) },
          ],
        }),
    };
  }

  it("holds a repeated read of an invocation that is still scheduling", async () => {
    vi.useFakeTimers();
    const h = invocationHarness({ invocations: true });
    const annotated = h.result("ready");
    expect(annotated.content[1].text).toContain("still ready");
    let released = false;
    const call = h.check().then(() => {
      released = true;
    });
    await vi.advanceTimersByTimeAsync(GALAXY_POLL_INTERVAL_MS - 1);
    expect(released).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await call;
    expect(released).toBe(true);
  });

  describe("a spilled invocation, whose content is a prose preview", () => {
    const PREVIEW =
      "Large Galaxy response saved in memory. Showing a bounded preview.\n{...}\n[loom Galaxy output]";
    const envelope = (state: string) => ({ success: true, data: { id: "inv1", state, steps: [] } });
    const spilled = (
      h: ReturnType<typeof invocationHarness>,
      state: string,
      structured: boolean,
    ) => {
      const store = createMemoryOutputStore();
      setGalaxyOutputStore(store);
      const outputId = structured
        ? "01JAAAAAAAAAAAAAAAAAAAAAAA"
        : store.put(JSON.stringify(envelope(state)), "get_invocations");
      return h.fire("tool_result", {
        toolName: "get_invocations",
        input: { invocation_id: "inv1" },
        isError: false,
        content: [{ type: "text", text: PREVIEW }],
        details: { galaxy: { tool: "get_invocations", outputId, elapsedMs: 1 } },
        ...(structured ? { structuredContent: envelope(state) } : {}),
      });
    };

    async function held(h: ReturnType<typeof invocationHarness>) {
      let released = false;
      const call = h.check().then(() => {
        released = true;
      });
      await vi.advanceTimersByTimeAsync(GALAXY_POLL_INTERVAL_MS - 1);
      const early = released;
      await vi.advanceTimersByTimeAsync(1);
      await call;
      return early === false && released;
    }

    it("holds a repeated read when structuredContent was dropped, reading the saved output", async () => {
      vi.useFakeTimers();
      const h = invocationHarness({ invocations: true });
      const annotated = spilled(h, "ready", false);
      expect(annotated.content[0].text).toBe(PREVIEW);
      expect(annotated.content[1].text).toContain("[Loom background monitoring]");
      expect(await held(h)).toBe(true);
    });

    it("holds it from structuredContent when that survived", async () => {
      vi.useFakeTimers();
      const h = invocationHarness({ invocations: true });
      expect(spilled(h, "new", true).content[1].text).toContain("still new");
      expect(await held(h)).toBe(true);
    });

    it("lets a spilled finished invocation through", async () => {
      const h = invocationHarness({ invocations: true });
      expect(spilled(h, "scheduled", false)).toBeUndefined();
      expect(await h.check()).toBeUndefined();
    });
  });

  it("lets reads through once Galaxy has scheduled every step", async () => {
    const h = invocationHarness({ invocations: true });
    h.result("new");
    expect(h.result("scheduled")).toBeUndefined();
    expect(await h.check()).toBeUndefined();
    // A listing names no single invocation, so there is nothing to hold.
    h.result("ready");
    expect(await h.check({ history_id: "h1" })).toBeUndefined();
  });

  it("never throttles get_invocations without the option, as on the MCP desktop", async () => {
    const h = invocationHarness();
    expect(h.result("ready")).toBeUndefined();
    expect(await h.check()).toBeUndefined();
  });
});
