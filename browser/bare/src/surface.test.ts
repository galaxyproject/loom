/**
 * What the core alone sends a model, for a flavor that adds nothing. Every flavor gets this much,
 * so a diff here is a change to all of them, and a mention of one flavor's tools or wording here
 * is something the others ship without.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Python } from "@galaxyproject/orbit-browser/agent";
import { Headless, type HeadlessConfig } from "@galaxyproject/orbit-browser/node";
import { json, text } from "@galaxyproject/orbit-browser/testing";

const ROOT = "http://galaxy.test/";
const LLM = "http://llm.test/v1";
const SNAPSHOTS = "./__surface__";
const BARE = {};

const python: Python = { run: async () => "", write: async () => {}, read: async () => undefined };
/** As written, with the session's own directory (it varies per run) named for what it is. */
const pretty = (value: unknown) =>
  `${JSON.stringify(value, null, 2)}\n`.replaceAll(opened[0]?.root ?? "\0", "<session>");
const opened: Headless[] = [];

async function firstRequest(over: Partial<HeadlessConfig>) {
  const requests: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (request.url.startsWith(LLM)) {
      requests.push(JSON.parse(await request.text()));
      return text("ok");
    }
    return json(new URL(request.url).pathname === "/api/version" ? { version_major: "26.1" } : {});
  });
  const session = await Headless.open(
    {
      galaxy_root: ROOT,
      ai_base_url: LLM,
      ai_model: "test-model",
      ai_api_key: "sk-x",
      poll_ms: 10,
      ...over,
    },
    { python, flavor: BARE },
  );
  opened.push(session);
  await session.turn("hi");
  return requests[0];
}

beforeAll(() => {
  // The prompt carries today's date.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
});

afterAll(() => vi.useRealTimers());

afterEach(async () => {
  for (const session of opened.splice(0)) await session.close();
  vi.unstubAllGlobals();
});

describe("the first request from the core alone", () => {
  const LAUNCHES: Record<string, Partial<HeadlessConfig>> = {
    plain: {},
    "read-only": { capabilities: ["llm", "read"] },
  };

  for (const [name, over] of Object.entries(LAUNCHES)) {
    it(`for a ${name} launch: system prompt and tools, in order`, async () => {
      const { messages, tools } = await firstRequest(over);
      await expect(pretty({ messages, tools })).toMatchFileSnapshot(
        `${SNAPSHOTS}/request-${name}.json`,
      );
    });
  }
});
