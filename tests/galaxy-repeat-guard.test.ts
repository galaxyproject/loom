import { describe, expect, it } from "vitest";

import { registerGalaxyRepeatGuard } from "../extensions/loom/galaxy-repeat-guard";

type Handler = (event: unknown, ctx?: unknown) => unknown;

function guard() {
  const on = new Map<string, Handler>();
  registerGalaxyRepeatGuard({ on: (event: string, h: Handler) => on.set(event, h) } as never);
  let n = 0;
  const call = (toolName: string, input: Record<string, unknown>) => {
    const toolCallId = `c${++n}`;
    return { toolCallId, refused: on.get("tool_call")!({ toolName, toolCallId, input }) };
  };
  const result = (toolName: string, toolCallId: string, isError: boolean, signal?: AbortSignal) =>
    on.get("tool_result")!({ toolName, toolCallId, input: {}, content: [], isError }, { signal });
  const fail = (toolName: string, input: Record<string, unknown>) => {
    const { toolCallId, refused } = call(toolName, input);
    expect(refused).toBeFalsy();
    result(toolName, toolCallId, true);
  };
  return { on, call, result, fail };
}

const RUN = "mcp__galaxy__run_tool";

describe("registerGalaxyRepeatGuard", () => {
  it("keys on the arguments' content, not their key order", () => {
    const g = guard();
    g.fail(RUN, { a: 1, b: { c: 2, d: 3 } });
    g.fail(RUN, { b: { d: 3, c: 2 }, a: 1 });
    g.fail(RUN, { a: 1, b: { c: 2, d: 3 } });
    expect(g.call(RUN, { b: { c: 2, d: 3 }, a: 1 }).refused).toMatchObject({ block: true });
  });

  it("lets a changed call through", () => {
    const g = guard();
    for (let i = 0; i < 3; i++) g.fail(RUN, { a: 1 });
    expect(g.call(RUN, { a: 2 }).refused).toBeFalsy();
  });

  it("does not count successes", () => {
    const g = guard();
    for (let i = 0; i < 3; i++) {
      const { toolCallId } = g.call(RUN, { a: 1 });
      g.result(RUN, toolCallId, false);
    }
    expect(g.call(RUN, { a: 1 }).refused).toBeFalsy();
  });

  it("does not count calls the user stopped", () => {
    const g = guard();
    const stopped = new AbortController();
    stopped.abort();
    for (let i = 0; i < 3; i++) {
      const { toolCallId } = g.call(RUN, { a: 1 });
      g.result(RUN, toolCallId, true, stopped.signal);
    }
    expect(g.call(RUN, { a: 1 }).refused).toBeFalsy();
  });

  it("refuses once per streak of failures", () => {
    const g = guard();
    for (let i = 0; i < 3; i++) g.fail(RUN, { a: 1 });
    expect(g.call(RUN, { a: 1 }).refused).toMatchObject({ block: true });
    expect(g.call(RUN, { a: 1 }).refused).toBeFalsy();
  });

  it("leaves tools outside galaxy-mcp alone", () => {
    const g = guard();
    for (let i = 0; i < 3; i++) g.fail("bash", { command: "false" });
    expect(g.call("bash", { command: "false" }).refused).toBeFalsy();
  });

  it("starts over with a new session", () => {
    const g = guard();
    for (let i = 0; i < 3; i++) g.fail(RUN, { a: 1 });
    g.on.get("session_start")!({});
    expect(g.call(RUN, { a: 1 }).refused).toBeFalsy();
  });
});
