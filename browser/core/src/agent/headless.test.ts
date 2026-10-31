import { contentText, type Message } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Binding } from "./documents";
import { Headless, type HeadlessConfig } from "./headless";
import { orbitSession } from "./orbit/worker";
import { context } from "./runtime";
import type { Python } from "./tool";

type Reply = {
  text?: string;
  reasoning?: string;
  calls?: Array<{ name: string; args: Record<string, unknown> }>;
};

const ROOT = "http://galaxy.test/";
const LLM = "http://llm.test/v1";

let callIds = 0;

function sse(reply: Reply): Response {
  const chunks: unknown[] = [];
  if (reply.reasoning) {
    chunks.push({ choices: [{ index: 0, delta: { reasoning_content: reply.reasoning } }] });
  }
  if (reply.text) {
    for (const part of reply.text.match(/.{1,4}/gs) ?? []) {
      chunks.push({ choices: [{ index: 0, delta: { content: part } }] });
    }
  }
  (reply.calls ?? []).forEach((call, index) =>
    chunks.push({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: `call_${++callIds}`,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              },
            ],
          },
        },
      ],
    }),
  );
  chunks.push({
    choices: [{ index: 0, delta: {}, finish_reason: reply.calls?.length ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function server(replies: Reply[], galaxy: Record<string, unknown> = {}) {
  const requests: Array<Record<string, any>> = [];
  const hits: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.href.startsWith(LLM)) {
      requests.push(JSON.parse(await request.text()));
      return sse(replies.shift() ?? { text: "done" });
    }
    hits.push(`${request.method} ${url.pathname}`);
    const path = url.pathname.replace(/^\//, "");
    const body =
      path in galaxy ? galaxy[path] : path === "api/version" ? { version_major: "26.1" } : {};
    return typeof body === "function" ? body(request) : json(body);
  });
  return { requests, hits };
}

const python: Python = { run: async () => "", write: async () => {}, read: async () => undefined };

const config = (over: Partial<HeadlessConfig> = {}): HeadlessConfig => ({
  galaxy_root: ROOT,
  ai_base_url: LLM,
  ai_model: "test-model",
  ai_api_key: "sk-test-secret-value",
  ...over,
});

const opened: Headless[] = [];

async function open(over: Partial<HeadlessConfig> = {}, env?: Record<string, string>) {
  const session = await Headless.open(config({ poll_ms: 10, ...over }), { python, env });
  opened.push(session);
  return session;
}

async function turn(
  replies: Reply[],
  over: Partial<HeadlessConfig> = {},
  galaxy?: Record<string, unknown>,
) {
  const wire = server(replies, galaxy);
  const session = await open(over);
  const result = await session.turn("hi");
  return { result, session, ...wire };
}

const messages = (entries: readonly EntryRecord[]) =>
  entries.flatMap((e) => (e.kind === "pi.system" ? [] : ((e.model ?? []) as Message[])));

type Result = Extract<Message, { role: "toolResult" }>;
const results = (entries: readonly EntryRecord[]) =>
  messages(entries).filter((m): m is Result => m.role === "toolResult");
const answers = (entries: readonly EntryRecord[]) =>
  messages(entries)
    .filter((m) => m.role === "assistant")
    .map((m) => contentText(m.content));

const bound = (session: Headless) =>
  session.runtime.harness.snapshot(Binding, session.conversation.id, context);

afterEach(async () => {
  for (const session of opened.splice(0)) await session.close();
  vi.unstubAllGlobals();
});

// Each case boots Orbit's brain, which takes a few seconds under a busy suite.
describe("a conversation without a page", { timeout: 30_000 }, () => {
  it("stops a Galaxy request in flight when the conversation is stopped", async () => {
    let aborted = false;
    const requests: unknown[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      if (url.href.startsWith(LLM)) {
        requests.push(1);
        return sse({ calls: [{ name: "get_history_details", args: { history_id: "f2c1" } }] });
      }
      if (url.pathname.endsWith("api/histories/f2c1")) {
        return new Promise((_resolve, reject) =>
          request.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          }),
        );
      }
      return json({});
    });
    const session = await open();
    const running = session.turn("hi");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    await session.runtime.hold([session.conversation]);
    expect(await running).toMatchObject({ status: "unanswered", reason: "aborted" });
    expect(aborted).toBe(true);
  });

  it("keeps the session's keys out of tool results", async () => {
    const { result } = await turn(
      [{ calls: [{ name: "get_history_details", args: { history_id: "f2c1" } }] }, { text: "ok" }],
      {},
      { "api/histories/f2c1": { id: "f2c1", annotation: "key sk-test-secret-value" } },
    );
    const text = contentText(results(result.entries)[0].content);
    expect(text).not.toContain("sk-test-secret-value");
    expect(text).toContain("[redacted]");
  });

  it("keeps a key read from the environment out of tool results too", async () => {
    server(
      [{ calls: [{ name: "get_history_details", args: { history_id: "f2c1" } }] }, { text: "ok" }],
      { "api/histories/f2c1": { id: "f2c1", annotation: "key or-env-secret-value" } },
    );
    const session = await open(
      { ai_provider: "openrouter", ai_api_key: undefined },
      { OPENROUTER_API_KEY: "or-env-secret-value" },
    );
    const result = await session.turn("hi");
    const text = contentText(results(result.entries)[0].content);
    expect(text).not.toContain("or-env-secret-value");
    expect(text).toContain("[redacted]");
  });

  it("settles a failed provider call unanswered", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      return url.startsWith(LLM)
        ? new Response("bad request", { status: 400 })
        : json({ version_major: "26.1" });
    });
    const session = await open();
    expect((await session.turn("hi")).status).toBe("unanswered");
  });

  it("sends max_tokens only when one is configured", async () => {
    const unset = await turn([{ text: "ok" }]);
    expect(unset.requests[0]).not.toHaveProperty("max_tokens");
    // One session to a process: the worker under it is the process's.
    await opened.pop()!.close();
    const set = await turn([{ text: "ok" }], { ai_max_tokens: 512 });
    expect(set.requests[0].max_tokens).toBe(512);
  });

  it("tells the model when Galaxy didn't answer as the session opened", async () => {
    const down = () => json({ err_msg: "unavailable" }, 503);
    const { requests } = await turn([{ text: "ok" }], {}, { "api/version": down });
    const system = (requests[0].messages as Array<{ role: string; content: string }>)[0].content;
    expect(system).toContain("## Galaxy connection: NOT CONNECTED");
    expect(system).toContain("Galaxy did not answer");
    // One session to a process: the next launch, with Galaxy up, opens after it.
    await opened.pop()!.close();
    const { requests: up } = await turn([{ text: "ok" }]);
    expect(up[0].messages[0].content).not.toContain("NOT CONNECTED");
  });

  it("puts the prompt first and the history binding just before the user's message", async () => {
    const { requests } = await turn([{ text: "ok" }], { history_id: "h1" });
    const sent = requests[0].messages as Array<{ role: string; content: string }>;
    expect(sent[0].role).toBe("system");
    expect(sent[0].content.startsWith("You are Orbit.")).toBe(true);
    expect(JSON.stringify(sent.at(-2)!.content)).toContain('Pass `history_id=\\"h1\\"`');
    expect(sent.at(-1)).toEqual({ role: "user", content: "hi" });
  });
});

describe("a restart, as a browser with nothing stored does it", { timeout: 30_000 }, () => {
  const RECORD = {
    id: "p7",
    slug: "orbit-orbit-sess-7",
    title: "Orbit record",
    create_time: "2026-10-01T09:00:00",
    update_time: "2026-10-02T09:00:00",
  };

  async function launched(pages: unknown[]) {
    server([{ text: "ok" }], { "api/pages": pages });
    const session = await open({ history_id: "h1", dataset_id: "d1" });
    await session.runtime.harness.commit(async (tx) => {
      Object.assign(await tx.doc(Binding, session.conversation.id), { pageId: "p1" });
    }, context);
    return session;
  }

  it("starts a new session at once, as Reset does, when the history has no records", async () => {
    const session = await launched([]);
    const before = await bound(session);
    expect(await session.restart()).toEqual([]);
    const after = await bound(session);
    expect(after).toMatchObject({ historyId: "h1", datasetId: "d1" });
    expect(after?.pageId).toBeUndefined();
    expect(after?.sessionId).not.toBe(before?.sessionId);
  });

  it("offers the history's records and starts nothing until told which session this is", async () => {
    const session = await launched([RECORD, { id: "p9", slug: "not-orbit", title: "Mine" }]);
    const offered = await session.restart();
    expect(offered.map((r) => r.pageId)).toEqual(["p7"]);
    // Nothing is shown while the user decides.
    expect(orbitSession().conversation).toBeUndefined();
    await session.recover("p7");
    // The session's identity and record come back; its conversation does not.
    expect(await bound(session)).toMatchObject({
      sessionId: "sess-7",
      pageId: "p7",
      historyId: "h1",
      startedAt: "2026-10-01T09:00:00",
    });
    expect((await session.conversation.context(context)).entries).toEqual([]);
  });

  it("refuses a second session in the same process while one is open", async () => {
    await launched([]);
    await expect(Headless.open(config(), { python })).rejects.toThrow(/already open/);
  });

  it("starts new when told so, even with records on offer", async () => {
    const session = await launched([RECORD]);
    await session.restart();
    await session.recover();
    expect((await bound(session))?.sessionId).not.toBe("sess-7");
    expect((await bound(session))?.pageId).toBeUndefined();
  });
});

describe("waiting for Galaxy work", { timeout: 30_000 }, () => {
  const JOB = "aaaa000000000001";

  it("hands back work that settled before settle was called", async () => {
    let content = "";
    server(
      [
        { calls: [{ name: "run_tool", args: { history_id: "h1", tool_id: "cat1", inputs: {} } }] },
        { text: "submitted" },
      ],
      {
        "api/tools": { jobs: [{ id: JOB, tool_id: "cat1", history_id: "h1" }], outputs: [] },
        [`api/jobs/${JOB}`]: { id: JOB, state: "ok", tool_id: "cat1", history_id: "h1" },
        // The record the watch writes the job's block into.
        "api/pages": (request: Request) =>
          json(request.method === "POST" ? { id: "p1", slug: "s", history_id: "h1" } : []),
        "api/pages/p1": async (request: Request) => {
          if (request.method === "PUT")
            content = ((await request.json()) as { content: string }).content;
          return json({ id: "p1", slug: "s", history_id: "h1", content, content_editor: content });
        },
      },
    );
    const session = await open({ history_id: "h1" });
    await session.turn("run cat");
    // Settled while nobody was waiting: between the turn and the call to settle.
    const posted = (session as unknown as { posted: Array<{ type: string }> }).posted;
    await vi.waitFor(() => expect(posted.some((m) => m.type === "settled")).toBe(true), {
      timeout: 10_000,
    });
    const { settled } = await session.settle(5);
    expect(settled.map((s) => s.outcome)).toContain("completed");
    // Handed back once.
    expect((await session.settle(1)).settled).toEqual([]);
  });

  it("refuses to recover when nothing is on offer, rather than wait for an answer", async () => {
    server([]);
    const session = await open();
    await expect(session.recover()).rejects.toThrow(/Nothing is offered/);
  });
});

describe("the history a conversation is bound to", { timeout: 30_000 }, () => {
  it("stays on the history it was launched on when the agent creates another", async () => {
    const { session } = await turn(
      [{ calls: [{ name: "create_history", args: { history_name: "x" } }] }, { text: "ok" }],
      { history_id: "h1" },
      { "api/histories": { id: "hnew", name: "x", model_class: "History" } },
    );
    expect((await bound(session))?.historyId).toBe("h1");
  });

  it("does not take a history the agent creates when it was launched on none", async () => {
    const { session } = await turn(
      [{ calls: [{ name: "create_history", args: { history_name: "x" } }] }, { text: "ok" }],
      {},
      { "api/histories": { id: "hnew", name: "x", model_class: "History" } },
    );
    expect((await bound(session))?.historyId).toBeUndefined();
  });

  it("stays put when a result merely mentions another history", async () => {
    const { session, result } = await turn(
      [{ calls: [{ name: "get_dataset_details", args: { dataset_id: "d9" } }] }, { text: "ok" }],
      { history_id: "h1" },
      { "api/datasets/d9": { id: "d9", history_id: "elsewhere", name: "x" } },
    );
    expect(results(result.entries)[0].isError).toBe(false);
    expect((await bound(session))?.historyId).toBe("h1");
  });

  it("does not take a history the agent writes into when it was launched on none", async () => {
    const { session } = await turn(
      [
        { calls: [{ name: "update_history", args: { history_id: "hw", name: "renamed" } }] },
        { text: "ok" },
      ],
      {},
      { "api/histories/hw": { id: "hw", name: "renamed" } },
    );
    expect((await bound(session))?.historyId).toBeUndefined();
  });
});
