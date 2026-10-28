import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineDoc,
  Harness,
  InboxDoc,
  LiveDoc,
  watchEvents,
  type Conversation,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_BRAND, followUpMark } from "./brand";
import { FollowUps, MAX_AUTO_FOLLOW_UPS } from "./documents";
import { hanging, json, text, toolCall } from "./fake-model";
import type { Galaxy } from "./galaxy";
import { context, Runtime } from "./runtime";
import type { Python } from "./tool";
import { galaxyWatch, type Watched } from "./watch";

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

const opened: Runtime[] = [];

async function machine(
  storage = undefined as Parameters<typeof Runtime.open>[0]["storage"] | undefined,
  py?: Python,
) {
  const runtime = await Runtime.open({
    storage: storage ?? (await openNodeSqliteStorage(":memory:")),
    config: { galaxy_root: ROOT, ai_base_url: LLM, ai_model: "m", ai_api_key: "k" },
    python: py ?? stuckPython().py,
    pollMs: 5,
  });
  opened.push(runtime);
  return runtime;
}

const until = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(done()).toBe(true);
};

afterEach(async () => {
  for (const runtime of opened.splice(0)) await runtime.close().catch(() => {});
  vi.unstubAllGlobals();
});

describe("holding a conversation", () => {
  it("returns while a tool is still running, and the tool is then aborted", async () => {
    model(() => python("while True: pass"));
    const { py, runs } = stuckPython();
    const runtime = await machine(undefined, py);
    const conversation = await runtime.create({ historyId: "h1" });
    await runtime.submit(conversation, "loop forever");
    await until(() => runs.length === 1);

    await runtime.hold([conversation]);
    expect(runs[0].aborted).toBe(false);
    await until(() => runs[0].aborted);
    await conversation.waitForIdle(context);
    expect((await runtime.harness.snapshot(FollowUps, conversation.id, context))?.paused).toBe(
      true,
    );
  });

  it("ends the record reads a request makes before the model, with the run", async () => {
    const reads: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      if (request.url.includes("/contents")) {
        reads.push(request);
        return hanging(request);
      }
      return json(request.url.endsWith("api/version") ? { version_major: "26.1" } : {});
    });
    const runtime = await machine();
    const conversation = await runtime.create({ historyId: "h1" });
    await runtime.submit(conversation, "what is in my history?");
    await until(() => reads.length === 1);

    await runtime.hold([conversation]);
    const idle = await Promise.race([
      conversation.waitForIdle(context).then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
    ]);
    expect(idle).toBe(true);
    expect(reads[0].signal.aborted).toBe(true);
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
    const runtime = await machine();
    const conversation = await runtime.create({ historyId: "h1" });
    await runtime.submit(conversation, "which runs does SRR390728 have?");
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
    const started = await before.create({ historyId: "h1" });
    await before.submit(started, "answer slowly");
    await until(() => asked.length === 1);
    await before.close();
    opened.splice(opened.indexOf(before), 1);

    const after = await machine(await openNodeSqliteStorage(file));
    const reopened = (await after.kept({ historyId: "h1" }))!;
    await reopened.waitForIdle(context);
    expect(asked).toHaveLength(1);
    expect((await after.harness.snapshot(LiveDoc, reopened.id, context))?.run).toBeUndefined();
    expect((await after.harness.snapshot(FollowUps, reopened.id, context))?.paused).toBe(true);

    await (await after.submit(reopened, "continue")).wait(context);
    expect(asked).toHaveLength(2);
    expect(JSON.stringify((await reopened.context(context)).messages)).toContain(
      "The answer, once asked again.",
    );
  });
});

const MARK = followUpMark(DEFAULT_BRAND);
const JOB: Watched = { kind: "job", id: "j1", label: "run_tool", state: "queued" };

/**
 * A model answering each request in turn, keeping the user messages each request carried, and a
 * Galaxy whose job j1 is in `job.state`.
 */
function world(
  job: { state: string },
  ...answers: Array<(request: Request) => Response | Promise<Response>>
) {
  const asked: string[][] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (!request.url.startsWith(LLM)) {
      if (request.url.endsWith("api/jobs/j1")) return json({ state: job.state });
      return json(request.url.endsWith("api/version") ? { version_major: "26.1" } : {});
    }
    const body = JSON.parse(await request.clone().text()) as {
      messages: Array<{ role: string; content: string | Array<{ text?: string }> }>;
    };
    asked.push(
      body.messages
        .filter((m) => m.role === "user")
        .map((m) =>
          typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join(""),
        ),
    );
    return (answers[asked.length - 1] ?? (() => text("done")))(request);
  });
  return asked;
}

/** Watch job j1 for the conversation, as a run_tool result would. */
async function watchJob(conversation: Conversation) {
  const watch = galaxyWatch({ galaxy: {} as Galaxy, editRecord: async () => undefined });
  return conversation.commit(
    (tx) =>
      tx.createTask(watch, JOB, {
        ownership: { kind: "conversation" },
        conversationId: conversation.id,
        background: true,
      }),
    context,
  );
}

const policyOf = (runtime: Runtime, conversation: Conversation) =>
  runtime.harness.snapshot(FollowUps, conversation.id, context);

/** The user entries of the conversation's context, as text. */
const userEntries = async (conversation: Conversation) =>
  (await conversation.context(context)).entries.flatMap((e) => {
    const message = e.model?.[0] as { role?: string; content?: unknown } | undefined;
    if (message?.role !== "user") return [];
    const content = message.content;
    return [typeof content === "string" ? content : JSON.stringify(content)];
  });

describe("follow-ups held for the user", () => {
  it("keeps a follow-up that settles while held, and starts nothing", async () => {
    const job = { state: "ok" };
    const asked = world(job);
    const runtime = await machine();
    const conversation = await runtime.create({ historyId: "h1" });
    await runtime.hold([conversation]);
    await runtime.harness.waitForTask(await watchJob(conversation), context);
    await conversation.waitForIdle(context);

    expect(asked).toHaveLength(0);
    expect(
      (await runtime.harness.snapshot(LiveDoc, conversation.id, context))?.run,
    ).toBeUndefined();
    expect(
      (await runtime.harness.snapshot(InboxDoc, conversation.id, context))?.items ?? [],
    ).toEqual([]);
    expect((await policyOf(runtime, conversation))?.pending.map((p) => p.id)).toEqual([
      "watch:job:j1",
    ]);
    expect(await userEntries(conversation)).toEqual([]);
  });

  it.each(["a write", "a compaction", "a reset"])(
    "starts no run when a held conversation gets %s",
    async (what) => {
      const job = { state: "queued" };
      const asked = world(
        job,
        () => text("Hello."),
        () => text("A summary."),
      );
      const runtime = await machine();
      const conversation = await runtime.create({ historyId: "h1" });
      await (await runtime.submit(conversation, "hi")).wait(context);
      const watching = await watchJob(conversation);
      await runtime.hold([conversation]);
      await conversation.waitForIdle(context);
      job.state = "ok";
      await runtime.harness.waitForTask(watching, context);
      expect(asked).toHaveLength(1);

      if (what === "a write") {
        const note = { role: "user" as const, content: "a note", timestamp: Date.now() };
        const entry = { kind: "test.note", model: [note] };
        await (await conversation.submit({ type: "write", entry }, context)).wait(context);
      } else if (what === "a compaction") {
        const compaction = await conversation.compact(undefined, context);
        await runtime.harness.waitForTask(compaction, context);
      } else {
        await conversation.reset(undefined, context);
      }
      await conversation.waitForIdle(context);

      // A compaction asks for its summary; nothing carried the follow-up to the model.
      expect(asked.flat().some((m) => m.startsWith(MARK))).toBe(false);
      expect(
        (await runtime.harness.snapshot(LiveDoc, conversation.id, context))?.run,
      ).toBeUndefined();
      expect((await userEntries(conversation)).some((m) => m.startsWith(MARK))).toBe(false);
      expect((await policyOf(runtime, conversation))?.pending).toHaveLength(1);

      await (await runtime.submit(conversation, "continue")).wait(context);
      const last = asked.at(-1)!;
      expect(last.slice(-2).map((m) => m.startsWith(MARK) || m)).toEqual([true, "continue"]);
      expect(asked.filter((a) => a.some((m) => m.startsWith(MARK)))).toHaveLength(1);
      expect((await policyOf(runtime, conversation))?.pending).toEqual([]);
    },
  );

  it("runs the held follow-ups with the user's message, in one request, once", async () => {
    const job = { state: "ok" };
    const asked = world(job, () => text("Both."));
    const runtime = await machine();
    const conversation = await runtime.create({ historyId: "h1" });
    await runtime.hold([conversation]);
    await runtime.harness.waitForTask(await watchJob(conversation), context);

    // What the page draws: the follow-up lands as an entry the transcript reads as one.
    const stream = await watchEvents(runtime.harness, conversation.id, context);
    const drawn: string[] = [];
    stream.start(async (events) => {
      for (const e of events) {
        const message = e.type === "message_end" ? e.entry.model?.[0] : undefined;
        if (message?.role === "user") drawn.push(String(message.content));
      }
    });
    await (await runtime.submit(conversation, "continue")).wait(context);
    await stream.stop();
    expect(drawn.map((m) => m.startsWith(MARK) || m)).toEqual([true, "continue"]);
    expect(asked).toHaveLength(1);
    expect(asked[0].map((m) => m.startsWith(MARK) || m)).toEqual([true, "continue"]);
    const policy = await policyOf(runtime, conversation);
    expect(policy).toMatchObject({ paused: false, automatic: 0, pending: [] });

    await (await runtime.submit(conversation, "and then?")).wait(context);
    expect((await userEntries(conversation)).filter((m) => m.startsWith(MARK))).toHaveLength(1);
  });

  it("keeps a follow-up past the cap for the user, who lifts the cap by writing", async () => {
    const asked = world({ state: "ok" }, () => text("Checked."));
    const runtime = await machine();
    const conversation = await runtime.create({ historyId: "h1" });
    await conversation.commit(async (tx) => {
      (await tx.doc(FollowUps, conversation.id)).automatic = MAX_AUTO_FOLLOW_UPS;
    }, context);
    await runtime.harness.waitForTask(await watchJob(conversation), context);
    await conversation.waitForIdle(context);
    expect(asked).toHaveLength(0);
    expect((await policyOf(runtime, conversation))?.pending).toHaveLength(1);

    await (await runtime.submit(conversation, "go on")).wait(context);
    expect(asked[0].map((m) => m.startsWith(MARK) || m)).toEqual([true, "go on"]);
    expect(await policyOf(runtime, conversation)).toMatchObject({ automatic: 0, pending: [] });
  });

  it("moves input queued during a run into the pending list at a Stop, and runs it next", async () => {
    const asked = world({ state: "queued" }, hanging, () => text("All three."));
    const runtime = await machine();
    const conversation = await runtime.create({ historyId: "h1" });
    await runtime.submit(conversation, "first");
    await until(() => asked.length === 1);
    const queued = await conversation.submit({ type: "input", content: "second" }, context);
    expect((await queued.status(context)).status).toBe("queued");

    await runtime.hold([conversation]);
    expect((await runtime.harness.snapshot(InboxDoc, conversation.id, context))?.items).toEqual([]);
    expect(await queued.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
    expect((await policyOf(runtime, conversation))?.pending).toEqual([
      { id: `inbox:${queued.id}`, content: "second" },
    ]);
    await conversation.waitForIdle(context);
    expect(asked).toHaveLength(1);

    await (await runtime.submit(conversation, "continue")).wait(context);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toEqual(["first", "second", "continue"]);
  });

  it("keeps queued writes in pi-durable's inbox at a Stop", async () => {
    const asked = world({ state: "queued" }, hanging);
    const runtime = await machine();
    const conversation = await runtime.create({ historyId: "h1" });
    await runtime.submit(conversation, "first");
    await until(() => asked.length === 1);
    const note = { role: "user" as const, content: "a note", timestamp: Date.now() };
    const write = await conversation.submit(
      { type: "write", entry: { kind: "test.note", model: [note] } },
      context,
    );
    await runtime.hold([conversation]);
    expect((await policyOf(runtime, conversation))?.pending).toEqual([]);
    await conversation.waitForIdle(context);
    expect((await write.status(context)).status).not.toBe("unanswered");
  });

  it("holding twice moves nothing twice", async () => {
    const asked = world({ state: "queued" }, hanging);
    const runtime = await machine();
    const conversation = await runtime.create({ historyId: "h1" });
    await runtime.submit(conversation, "first");
    await until(() => asked.length === 1);
    await conversation.submit({ type: "input", content: "second" }, context);
    await runtime.hold([conversation]);
    await runtime.hold([conversation]);
    expect((await policyOf(runtime, conversation))?.pending).toHaveLength(1);
  });

  it("starts a fork with nothing held", async () => {
    const job = { state: "ok" };
    world(job, () => text("Hello."));
    const runtime = await machine();
    const conversation = await runtime.create({ historyId: "h1" });
    await (await runtime.submit(conversation, "hi")).wait(context);
    await runtime.hold([conversation]);
    await runtime.harness.waitForTask(await watchJob(conversation), context);
    const at = (await conversation.context(context)).entries.at(-1)!.id;
    const fork = await conversation.fork(at, { ownership: { kind: "ownerless" } }, context);
    // `fork: "initial"`: the fork has no policy of its own until something writes one.
    const forked = await policyOf(runtime, fork);
    expect(forked?.paused ?? false).toBe(false);
    expect(forked?.pending ?? []).toEqual([]);
    expect((await policyOf(runtime, conversation))?.pending).toHaveLength(1);
  });
});

const file = () => join(mkdtempSync(join(tmpdir(), "olit-hold-")), "olit.sqlite3");

/** Open the store again; after a "crash" step threw, closing commits nothing more. */
const reopen = async (runtime: Runtime, path: string) => {
  await runtime.close();
  opened.splice(opened.indexOf(runtime), 1);
  return machine(await openNodeSqliteStorage(path));
};

describe("held follow-ups across a restart", () => {
  it("keeps a held follow-up when the page closes, and delivers it once", async () => {
    const path = file();
    const asked = world({ state: "ok" }, () => text("Both."));
    const before = await machine(await openNodeSqliteStorage(path));
    const conversation = await before.create({ historyId: "h1" });
    await before.hold([conversation]);
    await before.harness.waitForTask(await watchJob(conversation), context);

    const after = await reopen(before, path);
    const reopened = (await after.kept({ historyId: "h1" }))!;
    expect((await policyOf(after, reopened))?.pending).toHaveLength(1);
    await reopened.waitForIdle(context);
    expect(asked).toHaveLength(0);
    await (await after.submit(reopened, "continue")).wait(context);
    expect(asked).toHaveLength(1);
    expect(asked[0].map((m) => m.startsWith(MARK) || m)).toEqual([true, "continue"]);
  });

  it("delivers a follow-up once when the page closed while delivering it", async () => {
    const path = file();
    const asked = world({ state: "ok" }, () => text("Both."));
    const before = await machine(await openNodeSqliteStorage(path));
    const conversation = await before.create({ historyId: "h1" });
    await before.hold([conversation]);
    await before.harness.waitForTask(await watchJob(conversation), context);
    // What submit() writes before the commit that empties the list, and no further.
    const [pending] = (await policyOf(before, conversation))!.pending;
    const message = { role: "user" as const, content: pending.content as string, timestamp: 1 };
    await conversation.submit(
      {
        type: "write",
        requestId: `held:${pending.id}`,
        entry: { kind: "pi.user", model: [message] },
      },
      context,
    );

    const after = await reopen(before, path);
    const reopened = (await after.kept({ historyId: "h1" }))!;
    await (await after.submit(reopened, "continue")).wait(context);
    expect(asked).toHaveLength(1);
    expect(asked[0].map((m) => m.startsWith(MARK) || m)).toEqual([true, "continue"]);
    expect((await policyOf(after, reopened))?.pending).toEqual([]);
  });

  it("moves input the store had queued behind a run when it opens again", async () => {
    const path = file();
    const asked = world({ state: "queued" }, hanging, () => text("All three."));
    const before = await machine(await openNodeSqliteStorage(path));
    const conversation = await before.create({ historyId: "h1" });
    await before.submit(conversation, "first");
    await until(() => asked.length === 1);
    const queued = await conversation.submit({ type: "input", content: "second" }, context);

    const after = await reopen(before, path);
    const reopened = (await after.kept({ historyId: "h1" }))!;
    await reopened.waitForIdle(context);
    expect(asked).toHaveLength(1);
    expect((await policyOf(after, reopened))?.pending).toEqual([
      { id: `inbox:${queued.id}`, content: "second" },
    ]);
    expect(
      (await (await after.harness.submission(queued.id, context))!.status(context)).status,
    ).toBe("unanswered");
    await (await after.submit(reopened, "continue")).wait(context);
    expect(asked[1]).toEqual(["first", "second", "continue"]);
  });

  it("keeps watching across a restart and keeps the follow-up for the user", async () => {
    const path = file();
    const job = { state: "running" };
    const asked = world(job, () => text("Done."));
    const before = await machine(await openNodeSqliteStorage(path));
    const conversation = await before.create({ historyId: "h1" });
    const watching = await watchJob(conversation);
    await before.hold([conversation]);

    const after = await reopen(before, path);
    job.state = "ok";
    await after.harness.waitForTask(watching, context);
    const reopened = (await after.kept({ historyId: "h1" }))!;
    expect(asked).toHaveLength(0);
    expect((await policyOf(after, reopened))?.pending).toHaveLength(1);
  });
});

const crash = () => Promise.reject(new Error("crash"));
const marked = (messages: string[]) => messages.map((m) => m.startsWith(MARK) || m);
const times = (messages: string[], what: string) => messages.filter((m) => m === what).length;

/**
 * A conversation held with two inputs waiting, in the order they arrived: "second", queued behind
 * the run "first" started, then job j1's follow-up, which settled while held.
 */
async function heldTwo(runtime: Runtime, asked: string[][], job: { state: string }) {
  const conversation = await runtime.create({ historyId: "h1" });
  const watching = await watchJob(conversation);
  await runtime.submit(conversation, "first");
  await until(() => asked.length === 1);
  const queued = await conversation.submit({ type: "input", content: "second" }, context);
  await runtime.hold([conversation]);
  job.state = "ok";
  await runtime.harness.waitForTask(watching, context);
  await conversation.waitForIdle(context);
  expect((await policyOf(runtime, conversation))?.pending.map((p) => p.id)).toEqual([
    `inbox:${queued.id}`,
    "watch:job:j1",
  ]);
  return { conversation, queued };
}

describe("delivering held input", () => {
  it("delivers it in the order it arrived, a watch's follow-up among it, before the user's message", async () => {
    const job = { state: "queued" };
    const asked = world(job, hanging, () => text("All."));
    const runtime = await machine();
    const { conversation } = await heldTwo(runtime, asked, job);

    await (await runtime.submit(conversation, "continue")).wait(context);
    expect(asked).toHaveLength(2);
    expect(marked(asked[1])).toEqual(["first", "second", true, "continue"]);
    expect((await policyOf(runtime, conversation))?.pending).toEqual([]);
  });

  it("keeps a follow-up held before queued input ahead of it", async () => {
    const asked = world({ state: "ok" }, hanging, () => text("All."));
    const runtime = await machine();
    const conversation = await runtime.create({ historyId: "h1" });
    await runtime.submit(conversation, "first");
    await until(() => asked.length === 1);
    await conversation.commit(async (tx) => {
      (await tx.doc(FollowUps, conversation.id)).automatic = MAX_AUTO_FOLLOW_UPS;
    }, context);
    // Past the cap the follow-up waits even while the run goes on.
    await runtime.harness.waitForTask(await watchJob(conversation), context);
    const queued = await conversation.submit({ type: "input", content: "second" }, context);
    await runtime.hold([conversation]);
    expect((await policyOf(runtime, conversation))?.pending.map((p) => p.id)).toEqual([
      "watch:job:j1",
      `inbox:${queued.id}`,
    ]);
    await conversation.waitForIdle(context);

    await (await runtime.submit(conversation, "continue")).wait(context);
    expect(marked(asked[1])).toEqual(["first", true, "second", "continue"]);
  });

  it("withdraws queued input under its own id and delivers it under held:<id>, once", async () => {
    const asked = world({ state: "queued" }, hanging, () => text("Both."));
    const runtime = await machine();
    const conversation = await runtime.create({ historyId: "h1" });
    await runtime.submit(conversation, "first");
    await until(() => asked.length === 1);
    const queued = await conversation.submit({ type: "input", content: "second" }, context);
    await runtime.hold([conversation]);
    const withdrawn = await queued.status(context);
    expect(withdrawn).toMatchObject({ type: "input", status: "unanswered", reason: "aborted" });
    expect(withdrawn.entry).toBeUndefined();

    await (await runtime.submit(conversation, "continue")).wait(context);
    expect(times(await userEntries(conversation), "second")).toBe(1);
    // The original submission stays withdrawn; its input is answered under the write's entry.
    expect(await queued.status(context)).toEqual(withdrawn);

    // Delivering again under the same request id finds the write delivered, and writes nothing.
    const requestId = `held:inbox:${queued.id}`;
    const message = { role: "user" as const, content: "second", timestamp: 1 };
    const again = await conversation.submit(
      { type: "write", requestId, entry: { kind: "pi.user", model: [message] } },
      context,
    );
    expect(again.id).not.toBe(queued.id);
    expect(await again.status(context)).toMatchObject({ type: "write", requestId, status: "done" });
    expect(times(await userEntries(conversation), "second")).toBe(1);
  });

  it("delivers input once when the run placed it between the pause and its withdrawal", async () => {
    const gate = Promise.withResolvers<Response>();
    const asked = world(
      { state: "queued" },
      () => gate.promise,
      () => text("Second."),
    );
    const runtime = await machine();
    const conversation = await runtime.create({ historyId: "h1" });
    await runtime.submit(conversation, "first");
    await until(() => asked.length === 1);
    const queued = await conversation.submit({ type: "input", content: "second" }, context);
    vi.spyOn(runtime.harness, "abortSubmission").mockImplementationOnce(crash);
    await expect(runtime.hold([conversation])).rejects.toThrow("crash");

    // The run's next boundary places it before anything withdraws it.
    gate.resolve(text("First."));
    expect(await queued.wait(context)).toMatchObject({ status: "done" });
    expect((await policyOf(runtime, conversation))?.pending.map((p) => p.id)).toEqual([
      `inbox:${queued.id}`,
    ]);

    await (await runtime.submit(conversation, "continue")).wait(context);
    expect(asked.at(-1)).toEqual(["first", "second", "continue"]);
    expect(times(await userEntries(conversation), "second")).toBe(1);
    expect((await policyOf(runtime, conversation))?.pending).toEqual([]);
  });
});

/** Reset, compact or write to the conversation, and wait for what that started. */
async function touch(runtime: Runtime, conversation: Conversation, what: string) {
  if (what === "a write") {
    const note = { role: "user" as const, content: "a note", timestamp: Date.now() };
    const entry = { kind: "test.note", model: [note] };
    await (await conversation.submit({ type: "write", entry }, context)).wait(context);
  } else if (what === "a compaction") {
    await runtime.harness.waitForTask(await conversation.compact(undefined, context), context);
  } else {
    await conversation.reset(undefined, context);
  }
  await conversation.waitForIdle(context);
}

describe("held input across a crash", () => {
  it.each(["a write", "a compaction", "a reset"])(
    "withdraws on opening what a crash left queued after the pause, and %s starts none of it",
    async (what) => {
      const path = file();
      const asked = world({ state: "queued" }, hanging);
      const before = await machine(await openNodeSqliteStorage(path));
      const conversation = await before.create({ historyId: "h1" });
      await before.submit(conversation, "first");
      await until(() => asked.length === 1);
      const queued = await conversation.submit({ type: "input", content: "second" }, context);
      vi.spyOn(before.harness, "abortSubmission").mockImplementation(crash);
      await expect(before.hold([conversation])).rejects.toThrow("crash");
      const inbox = await before.harness.snapshot(InboxDoc, conversation.id, context);
      expect(inbox?.items.map((item) => item.id)).toEqual([queued.id]);

      const after = await reopen(before, path);
      const reopened = (await after.kept({ historyId: "h1" }))!;
      await reopened.waitForIdle(context);
      expect((await after.harness.snapshot(InboxDoc, reopened.id, context))?.items).toEqual([]);
      expect(await after.harness.submission(queued.id, context)).toBeDefined();
      expect((await policyOf(after, reopened))?.pending).toEqual([
        { id: `inbox:${queued.id}`, content: "second" },
      ]);

      await touch(after, reopened, what);
      expect(asked.flat()).not.toContain("second");
      expect((await after.harness.snapshot(LiveDoc, reopened.id, context))?.run).toBeUndefined();
      expect(await userEntries(reopened)).not.toContain("second");

      await (await after.submit(reopened, "continue")).wait(context);
      expect(asked.at(-1)!.slice(-2)).toEqual(["second", "continue"]);
      expect(times(asked.flat(), "second")).toBe(1);
      expect(times(await userEntries(reopened), "second")).toBe(1);
    },
  );

  it("holds input an earlier build kept queued in pi-durable's inbox, when the store opens", async () => {
    const path = file();
    let fail!: () => void;
    const failing = new Promise<void>((resolve) => (fail = resolve));
    const asked = world({ state: "queued" }, async () => {
      await failing;
      return json({ error: { message: "unavailable" } }, 400);
    });
    const before = await machine(await openNodeSqliteStorage(path));
    const conversation = await before.create({ historyId: "h1" });
    await conversation.commit(async (tx) => {
      (await tx.doc(FollowUps, conversation.id)).paused = true;
    }, context);
    // Input an earlier build left queued in an idle conversation, for the next input to place:
    // here queued behind a run that then fails, which leaves it in pi-durable's inbox.
    const first = await conversation.submit({ type: "input", content: "first" }, context);
    await until(() => asked.length === 1);
    const queued = await conversation.submit(
      { type: "input", content: "second", whenBusy: "followUp" },
      context,
    );
    fail();
    expect((await first.wait(context)).status).toBe("unanswered");
    await conversation.waitForIdle(context);
    expect((await queued.status(context)).status).toBe("queued");

    const after = await reopen(before, path);
    const reopened = (await after.kept({ historyId: "h1" }))!;
    await reopened.reset(undefined, context);
    await reopened.waitForIdle(context);
    expect(asked).toHaveLength(1);
    expect((await policyOf(after, reopened))?.pending.map((p) => p.id)).toEqual([
      `inbox:${queued.id}`,
    ]);

    await (await after.submit(reopened, "continue")).wait(context);
    expect(asked).toHaveLength(2);
    expect(asked.at(-1)!.slice(-2)).toEqual(["second", "continue"]);
  });

  it("does not resume the run when a crash came before its abort", async () => {
    const path = file();
    const asked = world({ state: "queued" }, hanging, () => text("All."));
    const before = await machine(await openNodeSqliteStorage(path));
    const conversation = await before.create({ historyId: "h1" });
    await before.submit(conversation, "first");
    await until(() => asked.length === 1);
    await conversation.submit({ type: "input", content: "second" }, context);
    vi.spyOn(conversation, "abort").mockImplementation(() => new Promise(() => {}));
    await before.hold([conversation]);

    const after = await reopen(before, path);
    const reopened = (await after.kept({ historyId: "h1" }))!;
    await reopened.waitForIdle(context);
    expect(asked).toHaveLength(1);
    expect((await policyOf(after, reopened))?.pending).toHaveLength(1);
    await (await after.submit(reopened, "continue")).wait(context);
    expect(asked[1]).toEqual(["first", "second", "continue"]);
  });

  // Where submit() stops: each step it takes calls one of these, which then fails.
  const steps: Array<[string, "submit" | "commit", number]> = [
    ["after the commit that ends the hold", "submit", 0],
    ["after the first input was written", "submit", 1],
    ["before the commit that empties the list", "commit", 1],
    ["before the user's message", "submit", 2],
  ];
  it.each(steps)("delivers each input once when the page closed %s", async (_, step, after) => {
    const path = file();
    const job = { state: "queued" };
    const asked = world(job, hanging, () => text("All."));
    const before = await machine(await openNodeSqliteStorage(path));
    const { conversation } = await heldTwo(before, asked, job);
    const original = conversation[step].bind(conversation) as (...args: unknown[]) => unknown;
    let calls = 0;
    vi.spyOn(conversation, step).mockImplementation(((...args: unknown[]) =>
      ++calls > after ? crash() : original(...args)) as never);
    await expect(before.submit(conversation, "continue")).rejects.toThrow("crash");

    const reopened = await reopen(before, path);
    const kept = (await reopened.kept({ historyId: "h1" }))!;
    await kept.waitForIdle(context);
    expect(asked).toHaveLength(1);
    await (await reopened.submit(kept, "again")).wait(context);
    expect(asked).toHaveLength(2);
    expect(marked(asked[1])).toEqual(["first", "second", true, "again"]);
    expect(marked(await userEntries(kept)).filter((m) => m === true || m === "second")).toEqual([
      "second",
      true,
    ]);
    expect((await policyOf(reopened, kept))?.pending).toEqual([]);
  });
});

describe("delivery racing the user", () => {
  it("delivers each input once to two messages sent together, before both", async () => {
    const job = { state: "queued" };
    const asked = world(
      job,
      hanging,
      () => text("One."),
      () => text("Two."),
    );
    const runtime = await machine();
    const { conversation } = await heldTwo(runtime, asked, job);

    const sent = await Promise.all([
      runtime.submit(conversation, "one"),
      runtime.submit(conversation, "two"),
    ]);
    await Promise.all(sent.map((s) => s.wait(context)));
    await conversation.waitForIdle(context);
    expect(marked(await userEntries(conversation))).toEqual([
      "first",
      "second",
      true,
      "one",
      "two",
    ]);
    expect((await policyOf(runtime, conversation))?.pending).toEqual([]);
  });

  it("loses and repeats nothing when a Stop comes while delivering", async () => {
    const job = { state: "queued" };
    const asked = world(job, hanging, () => text("All."));
    const runtime = await machine();
    const { conversation } = await heldTwo(runtime, asked, job);
    const submit = conversation.submit.bind(conversation);
    let stopped = false;
    vi.spyOn(conversation, "submit").mockImplementation(async (draft, ctx) => {
      if (!stopped) {
        stopped = true;
        await runtime.hold([conversation]);
      }
      return submit(draft, ctx);
    });
    await (await runtime.submit(conversation, "continue")).wait(context);
    await conversation.waitForIdle(context);
    // Olit's worker never lets the two interleave (inOrder); here the message, admitted after the
    // Stop's pause, still runs, with what waited delivered once.
    expect(marked(asked.at(-1)!)).toEqual(["first", "second", true, "continue"]);
    expect((await policyOf(runtime, conversation))?.pending).toEqual([]);
    expect((await policyOf(runtime, conversation))?.paused).toBe(true);
  });
});

describe("the follow-up policy document", () => {
  it("reads a policy stored before follow-ups were kept in it", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "olit-hold-")), "olit.sqlite3");
    const before = defineDoc<{ automatic: number; paused: boolean }>({
      kind: FollowUps.definition.kind,
      version: 2,
      scope: "conversation",
      history: "latest",
      fork: "initial",
      initial: () => ({ automatic: 0, paused: false }),
    });
    const options = { models: {} as Models, registry: createRegistry() };
    const first = await Harness.open(await openNodeSqliteStorage(file), options, context);
    const conversation = await first.createConversation(
      { ownership: { kind: "ownerless" } },
      context,
    );
    await conversation.commit(async (tx) => {
      Object.assign(await tx.doc(before, conversation.id), { automatic: 2, paused: true });
    }, context);
    await first.close(context);

    const second = await Harness.open(await openNodeSqliteStorage(file), options, context);
    expect(await second.snapshot(FollowUps, conversation.id, context)).toEqual({
      automatic: 2,
      paused: true,
      pending: [],
    });
    await second.close(context);
  });
});
