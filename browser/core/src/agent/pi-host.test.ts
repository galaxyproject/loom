// @vitest-environment node
/**
 * The shim's own semantics, against a probe extension: pi's event order and composition rules,
 * reproduced on pi-durable with a scripted model. No Orbit code here; pi-host.orbit.test.ts runs
 * the real brain on top of what this file pins.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type Conversation,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hanging, json, text, toolCall } from "./fake-model";
import { agentModels } from "./model";
import {
  createPiHost,
  EMITTED_EVENTS,
  NotInThisShell,
  NOT_BOUND_REASON,
  STALE_CTX_MESSAGE,
  SWITCHING_REASON,
  type HostNote,
  type PiHostOptions,
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

async function boot(
  options: {
    ui?: PiHostUi;
    extras?: (api: ExtensionAPI) => void;
    host?: Partial<PiHostOptions>;
  } = {},
) {
  const seq: string[] = [];
  const events: Recorded[] = [];
  const notes: HostNote[] = [];
  const host = createPiHost({
    name: "probe",
    ui: options.ui,
    model: () => ({ provider: "custom", id: "m" }),
    onNote: (n) => notes.push(n),
    ...options.host,
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
  const another = () =>
    harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, ctx);
  return { host, harness, conversation, another, seq, events, notes, reports };
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

describe("pi-host across conversations", () => {
  /** The tool results a conversation holds, as text. */
  const results = async (conversation: Conversation) =>
    (await conversation.context(ctx)).messages
      .filter((m) => m.role === "toolResult")
      .map((m) => textOf(m.content));

  it("shuts down, attaches another conversation and starts it, with fresh ctx and the old ones stale", async () => {
    model(
      () => toolCall("echo", { n: 1 }),
      () => text("done"),
    );
    const captured: ExtensionContext[] = [];
    const starting: string[] = [];
    const { host, harness, another, seq } = await boot({
      extras: (api) => api.on("session_start", (_e, c) => void captured.push(c)),
      host: { beforeStart: (id) => void starting.push(String(id)) },
    });
    await host.shutdown("new");
    const second = await another();
    await host.attach(harness, second, ctx);
    await host.start("new");
    expect(starting).toHaveLength(2);
    expect(starting[1]).toBe(String(second.id));
    expect(seq.filter((s) => s === "session_start")).toHaveLength(2);
    expect(() => captured[0].cwd).toThrow(STALE_CTX_MESSAGE);
    expect(captured[1].cwd).toBe("/");
    // The second conversation runs a tool turn through the same host.
    await (await host.submit("hi"))!.wait(ctx);
    await until(settled(seq));
    expect(await results(second)).toEqual(["echo 1"]);
  });

  it("makes the ctx of a conversation attached over without a shutdown stale too", async () => {
    model();
    let captured: ExtensionContext | undefined;
    const { host, harness, another } = await boot({
      extras: (api) => api.on("session_start", (_e, c) => void (captured ??= c)),
    });
    await host.attach(harness, await another(), ctx);
    expect(() => captured!.cwd).toThrow(STALE_CTX_MESSAGE);
  });

  it("blocks a tool call from a conversation that isn't bound, without running it", async () => {
    model(
      () => toolCall("echo", { n: 1 }),
      () => text("done"),
    );
    const ran: number[] = [];
    const { host, harness, conversation, another, notes } = await boot({
      extras: (api) => api.on("tool_execution_start", () => void ran.push(1)),
    });
    // Another conversation is bound; the first one still runs a turn of its own.
    await host.attach(harness, await another(), ctx);
    await (
      await conversation.submit({ type: "input", content: "hi", whenIdle: "start" }, ctx)
    ).wait(ctx);
    await conversation.waitForIdle(ctx);
    // pi-durable words the block itself, since no hook of a bound conversation rewrote it.
    const [only, ...rest] = await results(conversation);
    expect(rest).toEqual([]);
    expect(only).toContain(`Tool call blocked: ${NOT_BOUND_REASON}`);
    expect(ran).toEqual([]);
    expect(notes.map((n) => (n.kind === "refused" ? n.member : ""))).toContain(
      "hook for another conversation",
    );
  });

  it("blocks a call that arrives after quiesce, and admits again once re-attached", async () => {
    model(
      () => toolCall("echo", { n: 1 }),
      () => text("done"),
      () => toolCall("echo", { n: 2 }),
      () => text("done"),
    );
    const { host, harness, conversation, seq } = await boot();
    host.quiesce(conversation.id);
    await (await host.submit("hi"))!.wait(ctx);
    await until(settled(seq));
    expect(await results(conversation)).toEqual([SWITCHING_REASON]);
    await host.shutdown("resume");
    await host.attach(harness, conversation, ctx);
    await host.start("resume");
    await (await host.submit("again"))!.wait(ctx);
    await until(settled(seq, 2));
    expect(await results(conversation)).toEqual([SWITCHING_REASON, "echo 2"]);
  });

  it("follows the conversation's own model when no fixed model is given", async () => {
    model();
    let captured: ExtensionContext | undefined;
    const models = {
      getModel: (provider: string, id: string) =>
        (id === "big"
          ? {
              provider,
              id,
              contextWindow: 1_000_000,
              maxTokens: 64_000,
              cost: { input: 3, output: 15 },
            }
          : undefined) as never,
    };
    const { conversation, events } = await boot({
      extras: (api) => api.on("session_start", (_e, c) => void (captured = c)),
      host: { model: undefined, models },
    });
    expect(captured!.model?.id).toBe("m");
    expect(captured!.model?.contextWindow).toBe(128000);
    await conversation.configure({ model: { provider: "custom", modelId: "big" } }, ctx);
    await until(() => events.some((e) => e.type === "model_select"));
    expect(captured!.model).toMatchObject({
      id: "big",
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    });
    expect(events.find((e) => e.type === "model_select")!.model).toMatchObject({
      id: "big",
      contextWindow: 1_000_000,
    });
  });

  it("holds settle open until a slow tool_execution_end handler returns", async () => {
    model(
      () => toolCall("echo", { n: 1 }),
      () => text("done"),
    );
    let release!: () => void;
    let ended = false;
    const { host, conversation, seq } = await boot({
      extras: (api) =>
        api.on("tool_execution_end", async () => {
          await new Promise<void>((r) => (release = r));
          ended = true;
        }),
    });
    void host.submit("hi");
    await until(() => release !== undefined);
    host.quiesce(conversation.id);
    let outcome: { settled: boolean; late: string[] } | undefined;
    const settling = host.settle(conversation.id, 5_000).then((o) => (outcome = o));
    await new Promise((r) => setTimeout(r, 30));
    expect(outcome).toBeUndefined();
    release();
    await settling;
    expect(ended).toBe(true);
    expect(outcome).toEqual({ settled: true, late: [] });
    await until(settled(seq));
  });

  it("names a tool that outlives the timeout as late, and hands its result to the shell after the switch", async () => {
    model(
      () => toolCall("slow", {}),
      () => text("done"),
    );
    let finish!: () => void;
    const late: Array<{ conversation: string; name: string; text: string }> = [];
    const endedFor: string[] = [];
    const executed: string[] = [];
    const { host, harness, conversation, another } = await boot({
      extras: (api) => {
        api.registerTool({
          name: "slow",
          label: "Slow",
          description: "takes its time",
          parameters: Type.Object({}),
          execute: async () => {
            await new Promise<void>((r) => (finish = r));
            return { content: [{ type: "text", text: "slow done" }], details: {} };
          },
        });
        api.on("tool_execution_end", (e) => void endedFor.push(e.toolName));
      },
      host: {
        afterExecute: (name) => void executed.push(name),
        onLateCompletion: (id, call, result) =>
          void late.push({
            conversation: String(id),
            name: call.name,
            text: textOf(result.content),
          }),
      },
    });
    void host.submit("hi");
    await until(() => finish !== undefined);
    host.quiesce(conversation.id);
    const outcome = await host.settle(conversation.id, 30);
    expect(outcome.settled).toBe(false);
    expect(outcome.late).toHaveLength(1);
    // The switch goes on without it.
    await host.shutdown("new");
    await host.attach(harness, await another(), ctx);
    await host.start("new");
    finish();
    await until(() => late.length === 1);
    expect(late).toEqual([
      { conversation: String(conversation.id), name: "slow", text: "slow done" },
    ]);
    // Orbit's own end events didn't run for it, nor did afterExecute: they'd act on the
    // conversation bound now.
    expect(endedFor).toEqual([]);
    expect(executed).toEqual([]);
    expect(await host.settle(conversation.id, 30)).toEqual({ settled: true, late: [] });
  });

  it("lets settle through at once for a call its run's abort stopped", async () => {
    model(() => toolCall("waits", {}));
    let started = false;
    const { host, conversation } = await boot({
      extras: (api) =>
        api.registerTool({
          name: "waits",
          label: "Waits",
          description: "runs until stopped",
          parameters: Type.Object({}),
          execute: async (_id, _params, signal) => {
            started = true;
            await new Promise((_r, reject) =>
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
            );
            return { content: [], details: {} };
          },
        }),
    });
    void host.submit("hi");
    await until(() => started);
    await conversation.abort(ctx);
    host.quiesce(conversation.id);
    const before = Date.now();
    expect(await host.settle(conversation.id, 2_000)).toEqual({ settled: true, late: [] });
    expect(Date.now() - before).toBeLessThan(1_000);
  });

  it("runs none of Orbit's turn hooks for a conversation while nothing is bound", async () => {
    model(() => text("done"));
    const { host, another, seq, notes } = await boot();
    await host.shutdown("new");
    const marker = seq.length;
    const loose = await another();
    await (await loose.submit({ type: "input", content: "hi", whenIdle: "start" }, ctx)).wait(ctx);
    await loose.waitForIdle(ctx);
    expect(seq.slice(marker)).toEqual([]);
    expect(notes.filter((n) => n.kind === "handler-error")).toEqual([]);
  });
});

describe("pi-host's UI surface", () => {
  it("withdraws a confirm when its tool call stops, though the caller passed no signal", async () => {
    model(() => toolCall("echo", { n: 1 }));
    let withdrawn = false;
    let asked = false;
    const { host, conversation, seq } = await boot({
      ui: {
        ask: (_request, _id, signal) =>
          new Promise((resolve) => {
            asked = true;
            signal?.addEventListener("abort", () => {
              withdrawn = true;
              resolve(undefined);
            });
          }),
      },
      extras: (api) =>
        api.on("tool_call", async (_e, c) => {
          const ok = await c.ui.confirm("Destructive", "really?", {});
          return ok ? undefined : { block: true, reason: "declined" };
        }),
    });
    const s = await host.submit("hi");
    await until(() => asked);
    await conversation.abort(ctx);
    await s!.wait(ctx);
    expect(withdrawn).toBe(true);
    await until(settled(seq));
  });

  it("routes a registered /command from submit, as pi's prompt does, and sends the rest to the model", async () => {
    const requests = model(
      () => text("done"),
      () => text("done"),
    );
    const ran: string[] = [];
    const { host, seq } = await boot({
      extras: (api) =>
        api.registerCommand("pending", {
          description: "probe",
          handler: async (args) => void ran.push(args),
        }),
    });
    expect(await host.submit("/pending all of it")).toBeUndefined();
    expect(await host.submit("/pending")).toBeUndefined();
    expect(ran).toEqual(["all of it", ""]);
    expect(seq.filter((s) => s === "input")).toEqual([]);
    expect(requests).toHaveLength(0);
    // Slash text the brain sends itself goes to the model, as pi's sendUserMessage does.
    host.api.sendUserMessage("/pending from the brain");
    await until(() => requests.length === 1);
    expect(ran).toEqual(["all of it", ""]);
    await until(settled(seq));
    // An unregistered one is ordinary text.
    await (await host.submit("/nope"))!.wait(ctx);
    await until(settled(seq, 2));
    expect(requests).toHaveLength(2);
  });

  it("notes and dismisses an ask of a kind the shell doesn't support", async () => {
    model();
    let captured: ExtensionContext | undefined;
    const asked: string[] = [];
    const { notes } = await boot({
      ui: {
        supports: ["confirm"],
        ask: async (request) => {
          asked.push(request.kind);
          return true;
        },
      },
      extras: (api) => api.on("session_start", (_e, c) => void (captured = c)),
    });
    expect(await captured!.ui.select("pick", ["a", "b"])).toBeUndefined();
    expect(await captured!.ui.confirm("t", "m")).toBe(true);
    expect(asked).toEqual(["confirm"]);
    expect(notes).toContainEqual({
      kind: "refused",
      member: "ctx.ui.select",
      detail: "this shell can't ask a select",
      phase: "run",
    });
  });

  it("says compaction and context usage are unsupported here", async () => {
    model();
    let captured: ExtensionContext | undefined;
    const { notes } = await boot({
      extras: (api) => api.on("session_start", (_e, c) => void (captured = c)),
    });
    const errors: Error[] = [];
    captured!.compact({ onError: (e) => void errors.push(e) });
    expect(captured!.getContextUsage()).toBeUndefined();
    expect(errors[0]).toBeInstanceOf(NotInThisShell);
    const unsupported = notes.filter(
      (n) => n.kind === "refused" && n.detail === "unsupported in this shell",
    );
    expect(unsupported.map((n) => (n.kind === "refused" ? n.member : ""))).toEqual([
      "ctx.compact",
      "ctx.getContextUsage",
    ]);
  });

  it("asks again after a reload during a confirm, and runs the call once when approved", async () => {
    model(
      () => toolCall("echo", { n: 1 }),
      () => text("done"),
    );
    // The worker's files outlive the worker: the second harness reopens what the first wrote.
    const files = new MemoryStorage();
    const storage = new Proxy(files, {
      get(target, prop) {
        if (prop === "close") return async () => {};
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const log: string[] = [];
    async function worker(
      label: string,
      answer: (signal?: AbortSignal) => Promise<boolean | undefined>,
    ) {
      const host = createPiHost({
        name: "probe",
        model: () => ({ provider: "custom", id: "m" }),
        ui: {
          ask: (_request, _id, signal) => {
            log.push(`${label} asked`);
            return answer(signal);
          },
        },
      });
      host.api.registerTool({
        name: "echo",
        label: "Echo",
        description: "echoes n",
        parameters: Type.Object({ n: Type.Number() }),
        execute: async (_id, params) => {
          log.push(`${label} ran`);
          return { content: [{ type: "text", text: `echo ${params.n}` }], details: {} };
        },
      });
      host.api.on("tool_call", async (_e, c) =>
        (await c.ui.confirm("Destructive", "really?", {}))
          ? undefined
          : { block: true, reason: "declined" },
      );
      const registry = createRegistry();
      registry.install(host.seal());
      const { models, model: agent } = await agentModels().connect(
        resolve({ ai_base_url: LLM, ai_model: "m", ai_api_key: "k" }),
      );
      const harness = await Harness.open(
        storage,
        { models, registry, settings: { ...LOOP, maxTurns: 6 } },
        ctx,
      );
      opened.push(harness);
      return { host, harness, agent };
    }
    const first = await worker(
      "first",
      (signal) => new Promise((r) => signal?.addEventListener("abort", () => r(undefined))),
    );
    const conversation = await first.harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model: first.agent } },
      ctx,
    );
    await first.host.attach(first.harness, conversation, ctx);
    await first.host.start("startup");
    first.harness.resume();
    void first.host.submit("hi");
    await until(() => log.includes("first asked"));
    // The page reloads with the dialog open. A graceful close aborts the first worker's dialog,
    // where a killed worker would just stop; either way the second resumes the same intent, so
    // this pins pi-durable's recovery along the abort path.
    await first.harness.close(ctx);
    const second = await worker("second", async () => true);
    const resumed = (await second.harness.conversation(conversation.id, ctx))!;
    await second.host.attach(second.harness, resumed, ctx);
    await second.host.start("resume");
    second.harness.resume();
    await resumed.waitForIdle(ctx);
    expect(log).toEqual(["first asked", "second asked", "second ran"]);
    const results = (await resumed.context(ctx)).messages.filter((m) => m.role === "toolResult");
    expect(results.map((m) => textOf(m.content))).toEqual(["echo 1"]);
  });
});

describe("pi-host's tools", () => {
  const extras = (api: ExtensionAPI) => {
    api.registerTool({
      name: "lookup",
      label: "Lookup",
      description: "reads",
      parameters: Type.Object({}),
      annotations: { readOnlyHint: true },
      execute: async () => ({ content: [{ type: "text", text: "found" }], details: {} }),
    });
    api.registerTool({
      name: "change",
      label: "Change",
      description: "writes",
      parameters: Type.Object({}),
      annotations: { readOnlyHint: false, destructiveHint: true },
      execute: async () => ({ content: [], details: {} }),
    });
    api.registerTool({
      name: "secret",
      label: "Secret",
      description: "unreachable",
      parameters: Type.Object({}),
      exposure: "hidden",
      execute: async () => ({ content: [], details: {} }),
    });
  };

  /** The pi-durable extension a host seals, with the probe's tools and these. */
  function sealed() {
    const host = createPiHost({ name: "probe" });
    probe(host.api, [], [], extras);
    return { host, extension: host.seal() };
  }

  it("lets only a tool that says it changes nothing rerun after a reload", () => {
    const replay = Object.fromEntries(
      sealed().extension.tools!.map((t) => [t.name, t.replay ?? "unsafe"]),
    );
    expect(replay).toEqual({ echo: "unsafe", boom: "unsafe", lookup: "safe", change: "unsafe" });
  });

  it("keeps a hidden tool registered but never declares it", () => {
    const { host, extension } = sealed();
    expect(host.tools).toContain("secret");
    expect(extension.tools!.map((t) => t.name)).not.toContain("secret");
    expect(host.api.getActiveTools()).not.toContain("secret");
    const all = Object.fromEntries(host.api.getAllTools().map((t) => [t.name, t.exposure]));
    expect(all).toMatchObject({ secret: "hidden", lookup: "direct", echo: "direct" });
  });

  it("runs afterExecute inside the call, with pi-durable's api, before tool_result", async () => {
    model(
      () => toolCall("echo", { n: 3 }),
      () => text("done"),
    );
    const order: string[] = [];
    const seen: Array<{ name: string; text: string; callId: string; conversation: string }> = [];
    const { host, conversation, seq } = await boot({
      extras: (api) => api.on("tool_result", () => void order.push("tool_result")),
      host: {
        afterExecute: (name, result, api, conversationId) => {
          order.push("afterExecute");
          seen.push({
            name,
            text: textOf(result.content),
            callId: api.callId,
            conversation: String(conversationId),
          });
        },
      },
    });
    await (await host.submit("hi"))!.wait(ctx);
    await until(settled(seq));
    expect(order).toEqual(["afterExecute", "tool_result"]);
    expect(seen).toEqual([
      {
        name: "echo",
        text: "echo 3",
        callId: expect.any(String),
        conversation: String(conversation.id),
      },
    ]);
  });

  it("keeps the call's result when afterExecute throws, and notes it", async () => {
    model(
      () => toolCall("echo", { n: 4 }),
      () => text("done"),
    );
    const { host, conversation, seq, notes } = await boot({
      host: {
        afterExecute: () => {
          throw new Error("no task store");
        },
      },
    });
    await (await host.submit("hi"))!.wait(ctx);
    await until(settled(seq));
    const result = (await conversation.context(ctx)).messages.find((m) => m.role === "toolResult")!;
    expect(textOf(result.content)).toBe("echo 4");
    expect(notes.filter((n) => n.kind === "handler-error").map((n) => n.event)).toEqual([
      "after_execute",
    ]);
  });
});
