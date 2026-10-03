import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  GALAXY_POLL_INTERVAL_MS,
  registerGalaxyPollGuard,
} from "../extensions/loom/galaxy-poll-guard";

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

afterEach(() => vi.useRealTimers());

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
