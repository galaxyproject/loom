/**
 * What the agent sends a model and what its tools say back, pinned byte for byte. Restructuring
 * the agent must leave every one of these as it is: a changed snapshot is a changed agent.
 */
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";

import { olitFlavor } from "./flavor";
import { Headless, type HeadlessConfig } from "@galaxyproject/orbit-browser/node";
import type { Python } from "@galaxyproject/orbit-browser/agent";

const ROOT = "http://galaxy.test/";
const LLM = "http://llm.test/v1";
const SNAPSHOTS = "./__surface__";

type Reply = { text?: string; calls?: Array<{ name: string; args: Record<string, unknown> }> };

let callIds = 0;

function sse(reply: Reply): Response {
  const chunks: unknown[] = [];
  if (reply.text) chunks.push({ choices: [{ index: 0, delta: { content: reply.text } }] });
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

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function server(replies: Reply[]) {
  const requests: Array<Record<string, any>> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.href.startsWith(LLM)) {
      requests.push(JSON.parse(await request.text()));
      return sse(replies.shift() ?? { text: "done" });
    }
    const path = url.pathname.replace(/^\//, "");
    return json(path === "api/version" ? { version_major: "26.1" } : {});
  });
  return requests;
}

const python: Python = { run: async () => "", write: async () => {}, read: async () => undefined };

const opened: Headless[] = [];

async function turn(replies: Reply[], over: Partial<HeadlessConfig> = {}) {
  const requests = server(replies);
  const session = await Headless.open(
    {
      galaxy_root: ROOT,
      ai_base_url: LLM,
      ai_model: "test-model",
      ai_api_key: "sk-x",
      poll_ms: 10,
      ...over,
    },
    { python, flavor: olitFlavor },
  );
  opened.push(session);
  const result = await session.turn("hi");
  return { requests, result };
}

/** As written, with the session's own directory (it varies per run) named for what it is. */
const pretty = (value: unknown) =>
  `${JSON.stringify(value, null, 2)}\n`.replaceAll(opened[0]?.root ?? "\0", "<session>");

beforeAll(() => {
  // The prompt carries today's date.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
});

afterAll(() => {
  vi.useRealTimers();
});

afterEach(async () => {
  for (const session of opened.splice(0)) await session.close();
  vi.unstubAllGlobals();
});

describe("the first request a launch sends", () => {
  const LAUNCHES: Record<string, Partial<HeadlessConfig>> = {
    plain: {},
    dataset: { history_id: "h1", dataset_id: "d1" },
    "read-only": { capabilities: ["llm", "read"] },
  };

  for (const [name, over] of Object.entries(LAUNCHES)) {
    it(`is unchanged for a ${name} launch: system prompt and tools, in order`, async () => {
      const { requests } = await turn([{ text: "ok" }], over);
      const { messages, tools } = requests[0];
      await expect(pretty({ messages, tools })).toMatchFileSnapshot(
        `${SNAPSHOTS}/request-${name}.json`,
      );
    });
  }
});
