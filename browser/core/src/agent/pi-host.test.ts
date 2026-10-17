// @vitest-environment node
/**
 * The shim's own semantics, against a probe extension: pi's event order and composition rules,
 * reproduced on pi-durable with a scripted model. No Orbit code here; pi-host.orbit.test.ts runs
 * the real brain on top of what this file pins.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hanging, json, text, toolCall } from "./fake-model";
import { agentModels } from "./model";
import {
  createPiHost,
  EMITTED_EVENTS,
  NotInThisShell,
  STALE_CTX_MESSAGE,
  type HostNote,
  type PiHostUi,
} from "./pi-host";
import { resolve } from "./providers";
import { LOOP } from "./runtime";

const LLM = "http://llm.test/v1";
const ctx = BACKGROUND_CONTEXT;

/** A model answering each request in turn, and a Galaxy that says nothing in particular. */
function model(...answers: Array<(request: Request) => Response | Promise<Response>>) {
  const requests: Array<Record<string, any>> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (!request.url.startsWith(LLM)) return json({});
    requests.push(JSON.parse(await request.text()));
    return (answers[requests.length - 1] ?? (() => text("done")))(request);
  });
  return requests;
}

const until = async (done: () => boolean) => {
  for (let i = 0; i < 300 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(done()).toBe(true);
};

const textOf = (content: unknown) =>
  (content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");

type Recorded = { type: string; [key: string]: unknown };

/** The probe extension: records every emitted event, and registers the tools and handlers the tests poke. */
function probe(
  api: ExtensionAPI,
  seq: string[],
  events: Recorded[],
  extras: (api: ExtensionAPI) => void = () => {},
) {
  // pi's on() is an overload per event name; one loose signature serves a loop over names.
  const on = api.on as unknown as (event: string, handler: (e: Recorded) => void) => () => void;
  for (const event of EMITTED_EVENTS) {
    on(event, (e) => {
      events.push(e);
      const message = e.message as { role?: string } | undefined;
      seq.push(event === "message_end" ? `${event}:${message?.role}` : event);
    });
  }
  extras(api);
  api.registerTool({
    name: "echo",
    label: "Echo",
    description: "echoes n",
    parameters: Type.Object({ n: Type.Number(), block: Type.Optional(Type.Boolean()) }),
    execute: async (_id, params) => ({
      content: [{ type: "text", text: `echo ${params.n}` }],
      details: { n: params.n },
    }),
  });
  api.registerTool({
    name: "boom",
    label: "Boom",
    description: "throws",
    parameters: Type.Object({}),
    execute: async () => {
      throw new Error("kaboom");
    },
  });
  api.on("tool_call", (event) => {
    if ((event.input as { block?: boolean }).block) return { block: true, reason: "nope" };
  });
}

const opened: Harness[] = [];

async function boot(options: { ui?: PiHostUi; extras?: (api: ExtensionAPI) => void } = {}) {
  const seq: string[] = [];
  const events: Recorded[] = [];
  const notes: HostNote[] = [];
  const host = createPiHost({
    name: "probe",
    ui: options.ui,
    model: () => ({ provider: "custom", id: "m" }),
    onNote: (n) => notes.push(n),
  });
  probe(host.api, seq, events, options.extras);
  const registry = createRegistry();
  registry.install(host.seal());
  const { models, model } = await agentModels().connect(
    resolve({ ai_base_url: LLM, ai_model: "m", ai_api_key: "k" }),
  );
  const reports: unknown[] = [];
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, settings: { ...LOOP, maxTurns: 6 }, onReport: (e) => reports.push(e) },
    ctx,
  );
  opened.push(harness);
  const conversation = await harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model } },
    ctx,
  );
  await host.attach(harness, conversation, ctx);
  // pi's session_start precedes any run; a resumed conversation's hooks must find it done.
  await host.start("startup");
  harness.resume();
  return { host, harness, conversation, seq, events, notes, reports };
}

const settled =
  (seq: string[], times = 1) =>
  () =>
    seq.filter((s) => s === "agent_settled").length >= times;

afterEach(async () => {
  for (const harness of opened.splice(0)) await harness.close(ctx).catch(() => {});
  vi.unstubAllGlobals();
});

describe("pi-host", () => {
  it("emits pi's events in pi's order for a tool turn and an answer", async () => {
    model(
      () => toolCall("echo", { n: 1 }),
      () => text("done"),
    );
    const { host, seq } = await boot();
    const s = await host.submit("hi");
    await s!.wait(ctx);
    await until(settled(seq));
    expect(seq).toEqual([
      "session_start",
      "input",
      "message_end:user",
      "before_agent_start",
      "agent_start",
      "turn_start",
      "context",
      "context_with_system",
      "message_end:assistant",
      "tool_execution_start",
      "tool_call",
      "tool_result",
      "tool_execution_end",
      "message_end:toolResult",
      "turn_end",
      "turn_start",
      "context",
      "context_with_system",
      "message_end:assistant",
      "turn_end",
      "agent_end",
      "agent_settled",
    ]);
  });

  it("gives a blocked call start and end but no result, with the reason as its content", async () => {
    model(
      () => toolCall("echo", { n: 1, block: true }),
      () => text("done"),
    );
    const { host, conversation, seq, events } = await boot();
    await (await host.submit("hi"))!.wait(ctx);
    await until(settled(seq));
    const tool = seq.filter((s) => s.startsWith("tool_") || s === "message_end:toolResult");
    expect(tool).toEqual([
      "tool_execution_start",
      "tool_call",
      "tool_execution_end",
      "message_end:toolResult",
    ]);
    const end = events.find((e) => e.type === "tool_execution_end")!;
    expect(end.isError).toBe(true);
    expect(textOf((end.result as { content: unknown }).content)).toBe("nope");
    const result = (await conversation.context(ctx)).messages.find((m) => m.role === "toolResult")!;
    expect(textOf(result.content)).toBe("nope");
  });

  it("chains tool_result handlers and keeps a message_end replacement of the wrong role", async () => {
    model(
      () => toolCall("echo", { n: 2 }),
      () => text("done"),
    );
    const seen: string[] = [];
    const { host, conversation, seq, notes } = await boot({
      extras: (api) => {
        api.on("tool_result", (event) => ({
          content: [...event.content, { type: "text", text: " +1" }],
          structuredContent: { x: 1 },
        }));
        api.on("tool_result", (event) => {
          seen.push(textOf(event.content), JSON.stringify(event.structuredContent));
          return { content: [{ type: "text", text: "final" }] };
        });
        api.on("tool_result", (event) => {
          seen.push(String(event.structuredContent));
        });
        api.on("message_end", (event) =>
          event.message.role === "toolResult"
            ? { message: { ...event.message, role: "user" } as never }
            : undefined,
        );
      },
    });
    await (await host.submit("hi"))!.wait(ctx);
    await until(settled(seq));
    expect(seen).toEqual(["echo 2 +1", '{"x":1}', "undefined"]);
    const result = (await conversation.context(ctx)).messages.find((m) => m.role === "toolResult")!;
    expect(textOf(result.content)).toBe("final");
    expect(notes.filter((n) => n.kind === "handler-error").map((n) => n.event)).toEqual([
      "message_end",
    ]);
  });

  it("lets the last before_agent_start override win, once per run", async () => {
    const requests = model(
      () => toolCall("echo", { n: 1 }),
      () => text("done"),
    );
    let captured: ExtensionContext | undefined;
    const { host, seq } = await boot({
      extras: (api) => {
        api.on("before_agent_start", () => ({ systemPrompt: "FIRST PROMPT" }));
        api.on("before_agent_start", (event, c) => {
          captured = c;
          expect(event.systemPrompt).toBe("FIRST PROMPT");
          return { systemPrompt: "SECOND PROMPT" };
        });
      },
    });
    await (await host.submit("hi"))!.wait(ctx);
    await until(settled(seq));
    expect(seq.filter((s) => s === "before_agent_start" || s === "agent_start")).toHaveLength(2);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.messages[0].role).toBe("system");
      expect(request.messages[0].content).toContain("SECOND PROMPT");
      expect(request.messages[0].content).not.toContain("FIRST PROMPT");
    }
    expect(captured!.getSystemPrompt()).toBe("SECOND PROMPT");
  });

  it("renders a context handler's custom message as user text before the last user message", async () => {
    const requests = model(() => text("done"));
    const { host, seq } = await boot({
      extras: (api) => {
        api.on("before_agent_start", () => ({ systemPrompt: "SYS" }));
        api.on("context", (event) => {
          const at = event.messages.findLastIndex((m) => m.role === "user");
          event.messages.splice(at, 0, {
            role: "custom",
            customType: "probe",
            content: "X",
            display: false,
            timestamp: Date.now(),
          } as never);
          return { messages: event.messages };
        });
      },
    });
    await (await host.submit("hi"))!.wait(ctx);
    await until(settled(seq));
    const roles = requests[0].messages.map((m: { role: string }) => m.role);
    expect(roles).toEqual(["system", "user", "user"]);
    const content = (c: unknown) => (typeof c === "string" ? c : textOf(c));
    expect(content(requests[0].messages[1].content)).toBe("X");
    expect(content(requests[0].messages[2].content)).toBe("hi");
  });

  it("keeps registerCommand reassignable and runs the stored wrapper", async () => {
    model();
    const ran: string[] = [];
    const { host } = await boot({
      extras: (api) => {
        const register = api.registerCommand.bind(api);
        api.registerCommand = (name, options) =>
          register(name, {
            ...options,
            handler: (args, c) => {
              ran.push(`wrapped ${name}`);
              return options.handler(args, c);
            },
          });
        api.registerCommand("c", {
          description: "probe",
          handler: async (args) => {
            ran.push(`c ${args}`);
          },
        });
      },
    });
    expect(await host.command("c", "a b")).toBe(true);
    expect(ran).toEqual(["wrapped c", "c a b"]);
    expect(await host.command("nope", "")).toBe(false);
    expect([...host.commands.keys()]).toEqual(["c"]);
  });

  it("makes every issued ctx stale after shutdown", async () => {
    model();
    let captured: ExtensionContext | undefined;
    const { host } = await boot({
      extras: (api) => {
        api.on("session_start", (_e, c) => {
          captured = c;
        });
      },
    });
    expect(captured!.cwd).toBe("/");
    await host.shutdown("quit");
    expect(() => captured!.ui).toThrow(STALE_CTX_MESSAGE);
    expect(() => captured!.isIdle()).toThrow(STALE_CTX_MESSAGE);
    expect(() => captured!.cwd).toThrow(STALE_CTX_MESSAGE);
  });

  it("reports a busy sendUserMessage and delivers a follow-up inside the same run, as pi does", async () => {
    model(
      () => toolCall("echo", { n: 1 }),
      () => text("first done"),
      () => text("second done"),
    );
    let api!: ExtensionAPI;
    const { host, conversation, seq, events, notes } = await boot({
      extras: (a) => {
        api = a;
        a.on("tool_execution_start", () => {
          api.sendUserMessage("dropped");
          api.sendUserMessage("later", { deliverAs: "followUp" });
        });
      },
    });
    await (await host.submit("hi"))!.wait(ctx);
    await until(settled(seq));
    await conversation.waitForIdle(ctx);
    expect(notes.filter((n) => n.kind === "busy")).toHaveLength(1);
    const users = (await conversation.context(ctx)).messages
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : textOf(m.content)));
    expect(users).toEqual(["hi", "later"]);
    // message_end(user) is the receipt that a message entered the loop: the rejected one has
    // none, the follow-up's arrives when pi-durable places it, between the turns of one run.
    const recorded = events
      .filter((e) => e.type === "message_end" && (e.message as { role: string }).role === "user")
      .map((e) => (e.message as { content: string }).content);
    expect(recorded).toEqual(["hi", "later"]);
    expect(seq.filter((s) => s === "before_agent_start" || s === "agent_start")).toHaveLength(2);
    // From the tool round's end: the answer turn, the follow-up placed between turns, its answer,
    // then one agent_end for the chain (pi-durable ran it as two runs).
    expect(seq.slice(seq.indexOf("turn_end"))).toEqual([
      "turn_end",
      "turn_start",
      "context",
      "context_with_system",
      "message_end:assistant",
      "turn_end",
      "message_end:user",
      "turn_start",
      "context",
      "context_with_system",
      "message_end:assistant",
      "turn_end",
      "agent_end",
      "agent_settled",
    ]);
  });

  it("reports rather than throws a sendUserMessage after shutdown", async () => {
    model();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const { host, notes } = await boot();
      await host.shutdown("quit");
      host.api.sendUserMessage("late");
      await new Promise((r) => setTimeout(r, 20));
      expect(notes).toContainEqual({
        kind: "refused",
        member: "sendUserMessage",
        detail: "no conversation attached",
        phase: "run",
      });
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("gives tool_result the validated arguments tool_call saw", async () => {
    model(
      () => toolCall("echo", { n: 1, block: null }),
      () => text("done"),
    );
    const { host, seq, events } = await boot();
    await (await host.submit("hi"))!.wait(ctx);
    await until(settled(seq));
    const input = (type: string) =>
      events.find((e) => e.type === type)![type === "tool_execution_start" ? "args" : "input"];
    expect(input("tool_result")).toEqual(input("tool_call"));
    // The start event's args are the validated ones too (pi passes the raw call there).
    expect(input("tool_execution_start")).toEqual(input("tool_call"));
  });

  it("derives hasUI from ask and answers dialogs through it", async () => {
    model();
    let captured: ExtensionContext | undefined;
    const capture = (api: ExtensionAPI) =>
      api.on("session_start", (_e, c) => {
        captured = c;
      });
    const headless = await boot({ extras: capture });
    expect(captured!.hasUI).toBe(false);
    expect(await captured!.ui.confirm("t", "m")).toBe(false);
    expect(headless.notes.filter((n) => n.kind === "refused").map((n) => n.member)).toContain(
      "ctx.ui.confirm",
    );
    await headless.harness.close(ctx);
    opened.splice(opened.indexOf(headless.harness), 1);

    const asked: unknown[] = [];
    await boot({
      extras: capture,
      ui: {
        ask: async (request) => {
          asked.push(request);
          return request.kind === "select" ? "b" : true;
        },
      },
    });
    expect(captured!.hasUI).toBe(true);
    expect(await captured!.ui.select("pick", ["a", "b"])).toBe("b");
    expect(await captured!.ui.confirm("t", "m")).toBe(true);
    expect(asked).toEqual([
      { kind: "select", title: "pick", options: ["a", "b"] },
      { kind: "confirm", title: "t", message: "m" },
    ]);
  });

  it("records an MCP registration and throws for exec", async () => {
    model();
    const { host, notes } = await boot({
      extras: (api) => {
        api.registerMcpServer("brc", { url: "https://example.test/mcp" });
      },
    });
    expect(notes).toContainEqual({
      kind: "refused",
      member: "registerMcpServer",
      detail: "brc",
      phase: "run",
    });
    let thrown: unknown;
    try {
      await host.api.exec("ls", []);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NotInThisShell);
    expect((thrown as NotInThisShell).member).toBe("exec");
  });

  it("hands tool_call the run's abort signal, so a Stop ends a waiting guard", async () => {
    model(() => toolCall("echo", { n: 1 }));
    let aborted = false;
    const { host, conversation, seq } = await boot({
      extras: (api) => {
        api.on("tool_call", async (_e, c) => {
          await new Promise<void>((r) => c.signal!.addEventListener("abort", () => r()));
          aborted = c.signal!.aborted;
          return { block: true, reason: "stopped" };
        });
      },
    });
    const s = await host.submit("hi");
    await until(() => seq.includes("tool_call"));
    await conversation.abort(ctx);
    await s!.wait(ctx);
    expect(aborted).toBe(true);
    await conversation.waitForIdle(ctx);
    await until(settled(seq));
    expect(seq.at(-1)).toBe("agent_settled");
  });

  it("reports an aborted run as pi does: an aborted assistant message and agent_settled.aborted", async () => {
    const requests = model(hanging);
    const { host, conversation, seq, events } = await boot();
    const s = await host.submit("hi");
    await until(() => requests.length === 1);
    await conversation.abort(ctx);
    expect((await s!.wait(ctx)).status).toBe("unanswered");
    await until(settled(seq));
    const end = events.find((e) => e.type === "agent_end")!;
    const messages = end.messages as Array<{ role: string; stopReason?: string }>;
    expect(messages.at(-1)?.role).toBe("assistant");
    expect(messages.at(-1)?.stopReason).toBe("aborted");
    expect(events.find((e) => e.type === "agent_settled")!.aborted).toBe(true);
  });

  it("turns a throwing tool into an error result rather than a task fault", async () => {
    model(
      () => toolCall("boom", {}),
      () => text("done"),
    );
    const { host, conversation, seq, reports } = await boot();
    await (await host.submit("hi"))!.wait(ctx);
    await until(settled(seq));
    const result = (await conversation.context(ctx)).messages.find((m) => m.role === "toolResult")!;
    expect(result.isError).toBe(true);
    expect(textOf(result.content)).toBe("kaboom");
    expect(reports).toEqual([]);
  });

  it("refuses a tool registered after seal", async () => {
    model();
    const { host, notes } = await boot();
    host.api.registerTool({
      name: "late",
      label: "Late",
      description: "too late",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: undefined }),
    });
    expect(host.tools).toEqual(["echo", "boom"]);
    expect(notes).toContainEqual({
      kind: "refused",
      member: "registerTool",
      detail: "late",
      phase: "run",
    });
  });
});
