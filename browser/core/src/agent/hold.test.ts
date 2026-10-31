import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FollowUps } from "./documents";
import { hanging, json, text, toolCall } from "./fake-model";
import { Headless } from "./headless";
import { context } from "./runtime";
import type { Python } from "./tool";

const ROOT = "http://galaxy.test/";
const LLM = "http://llm.test/v1";

const python = (code: string) => toolCall("run_python", { code });

/** A model answering each request in turn, and a Galaxy that says nothing in particular. */
function model(...answers: Array<(request: Request) => Response | Promise<Response>>) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (!request.url.startsWith(LLM)) {
      return json(request.url.endsWith("api/version") ? { version_major: "26.1" } : {});
    }
    asked.push(request.url);
    return (answers[asked.length - 1] ?? (() => text("done")))(request);
  });
  return asked;
}

/** Python whose runs end only when aborted, saying whether they were. */
function stuckPython() {
  const runs: Array<{ aborted: boolean }> = [];
  const py: Python = {
    run: (_code, signal) =>
      new Promise<string>((_, reject) => {
        const run = { aborted: false };
        runs.push(run);
        signal?.addEventListener("abort", () => {
          run.aborted = true;
          reject(new Error("aborted"));
        });
      }),
    write: async () => {},
    read: async () => undefined,
  };
  return { py, runs };
}

const opened: Headless[] = [];

/** One browser's worth of agent on Orbit's brain, over `storage`, launched on history h1. */
async function machine(
  storage = undefined as Parameters<typeof Headless.open>[1]["storage"] | undefined,
  py?: Python,
) {
  const session = await Headless.open(
    { galaxy_root: ROOT, ai_base_url: LLM, ai_model: "m", ai_api_key: "k", history_id: "h1" },
    {
      storage: storage ?? (await openNodeSqliteStorage(":memory:")),
      python: py ?? stuckPython().py,
    },
  );
  opened.push(session);
  return session;
}

const until = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(done()).toBe(true);
};

afterEach(async () => {
  for (const session of opened.splice(0)) await session.close().catch(() => {});
  vi.unstubAllGlobals();
});

// Each case boots Orbit's brain, which takes a few seconds under a busy suite.
describe("holding a conversation", { timeout: 60_000 }, () => {
  it("returns while a tool is still running, and the tool is then aborted", async () => {
    model(() => python("while True: pass"));
    const { py, runs } = stuckPython();
    const session = await machine(undefined, py);
    const { runtime, conversation } = session;
    void session.turn("loop forever").catch(() => {}); // left running: it ends when the session closes
    await until(() => runs.length === 1);

    await runtime.hold([conversation]);
    expect(runs[0].aborted).toBe(false);
    await until(() => runs[0].aborted);
    await conversation.waitForIdle(context);
    expect((await runtime.harness.snapshot(FollowUps, conversation.id, context))?.paused).toBe(
      true,
    );
  });

  it("ends a tool's request to another host with the run", async () => {
    const asked: Request[] = [];
    let calls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      if (request.url.startsWith("https://www.ebi.ac.uk/")) {
        asked.push(request);
        return hanging(request);
      }
      if (request.url.startsWith(LLM)) {
        calls++;
        return calls === 1 ? toolCall("ena_runs", { accession: "SRR390728" }) : text("done");
      }
      return json(request.url.endsWith("api/version") ? { version_major: "26.1" } : {});
    });
    const session = await machine();
    const { runtime, conversation } = session;
    void session.turn("which runs does SRR390728 have?").catch(() => {}); // left running: it ends when the session closes
    await until(() => asked.length === 1);

    await runtime.hold([conversation]);
    const idle = await Promise.race([
      conversation.waitForIdle(context).then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
    ]);
    expect(idle).toBe(true);
    expect(asked[0].signal.aborted).toBe(true);
  });

  it("does not resume a run the store held when it is opened again", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "olit-hold-")), "olit.sqlite3");
    const asked = model(hanging, () => text("The answer, once asked again."));
    const before = await machine(await openNodeSqliteStorage(file));
    const started = before.conversation.id;
    void before.turn("answer slowly").catch(() => {}); // left running: it ends when the session closes
    await until(() => asked.length === 1);
    await before.close();
    opened.splice(opened.indexOf(before), 1);

    // Opened again on the same history: the conversation kept there, not resumed.
    const after = await machine(await openNodeSqliteStorage(file));
    const reopened = after.conversation;
    expect(reopened.id).toBe(started);
    await reopened.waitForIdle(context);
    expect(asked).toHaveLength(1);
    const { harness } = after.runtime;
    expect((await harness.snapshot(LiveDoc, reopened.id, context))?.run).toBeUndefined();
    expect((await harness.snapshot(FollowUps, reopened.id, context))?.paused).toBe(true);

    await after.turn("continue");
    expect(asked).toHaveLength(2);
    expect(JSON.stringify((await reopened.context(context)).messages)).toContain(
      "The answer, once asked again.",
    );
  });
});
