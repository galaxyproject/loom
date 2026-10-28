import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  MemoryStorage,
  SystemEntry,
  UsageDoc,
  type Conversation,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { Binding, Sessions } from "./documents";
import { hanging, json, text, toolCall } from "./fake-model";
import saved5 from "./fixtures/saved-v5.json";
import { context, Runtime, type RuntimeConfig } from "./runtime";
import { isSessionDocument, SCHEMA, type SessionDocument } from "./saved";
import type { Python } from "./tool";

/** WRITE=<file> keeps every save this build writes; READ=<file> opens saves another build wrote. */
const WRITE = process.env.NOEXPORT_WRITE;
const READ = process.env.NOEXPORT_READ;
const SYSTEM_KIND = "pi.system";

const ROOT = "http://galaxy.test/";
const LLM = "http://llm.test/v1";
type Answer = (request: Request) => Response | Promise<Response>;
const answers: Answer[] = [];
const sent: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];

function stubFetch() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (!request.url.startsWith(LLM)) {
      return json(request.url.endsWith("api/version") ? { version_major: "26.1" } : {});
    }
    sent.push(JSON.parse(await request.clone().text()));
    return (answers.shift() ?? (() => text("done")))(request);
  });
}

let python: Python = { run: async () => "42", write: async () => {}, read: async () => undefined };
const opened: Runtime[] = [];

async function machine(
  storage: Storage = new MemoryStorage(),
  config: Partial<RuntimeConfig> = {},
) {
  stubFetch();
  const runtime = await Runtime.open({
    storage,
    config: { galaxy_root: ROOT, ai_base_url: LLM, ai_model: "m", ai_api_key: "k", ...config },
    python,
  });
  opened.push(runtime);
  return runtime;
}

afterEach(async () => {
  for (const runtime of opened.splice(0)) await runtime.close().catch(() => {});
  answers.splice(0);
  sent.splice(0);
  python = { run: async () => "42", write: async () => {}, read: async () => undefined };
  vi.unstubAllGlobals();
});

async function say(
  runtime: Runtime,
  conversation: Conversation,
  words: string,
  ...replies: Answer[]
) {
  answers.push(...replies);
  await (await runtime.submit(conversation, words)).wait(context);
  await conversation.waitForIdle(context);
}

const tool = (id: string) => () => toolCall("run_python", { code: "print(6*7)" }, id);
const reply = (words: string) => () => text(words);

async function contextOf(conversation: Conversation) {
  const view = await conversation.context(context);
  return {
    kinds: view.entries.map((e) => e.kind).filter((kind) => kind !== SYSTEM_KIND),
    messages: view.messages.filter((m) => m.role !== "system"),
  };
}

const written: Record<string, { document: SessionDocument; kinds: string[]; messages: Message[] }> =
  {};
afterAll(() => {
  if (WRITE) writeFileSync(WRITE, JSON.stringify(written, null, 2));
});

async function roundTrip(one: Runtime, conversation: Conversation, name: string) {
  const document = JSON.parse(JSON.stringify(await one.export(conversation))) as SessionDocument;
  expect(isSessionDocument(document)).toBe(true);
  const before = await contextOf(conversation);
  written[name] = { document, ...before };
  const two = await machine();
  const reopened = await two.open(structuredClone(document), "v1");
  return { document, two, reopened, before, after: await contextOf(reopened) };
}

const said = (messages: readonly Message[]) =>
  messages.flatMap((m) => (m.role === "user" && typeof m.content === "string" ? [m.content] : []));

describe.skipIf(READ)("save then open, on this build", () => {
  it("across tool calls", async () => {
    const one = await machine();
    const conversation = await one.create({ historyId: "h1", datasetId: "d1" });
    await say(one, conversation, "compute it", tool("call_a"), reply("it is 42"));
    await say(one, conversation, "and again", tool("call_b"), reply("still 42"));
    const { document, two, reopened, before, after } = await roundTrip(one, conversation, "tools");
    expect(document.olit_session).toBe(SCHEMA);
    expect(after).toEqual(before);
    expect(after.messages.filter((m) => m.role === "toolResult")).toHaveLength(2);
    expect(await two.harness.snapshot(Binding, reopened.id, context)).toMatchObject({
      sessionId: document.session.id,
      historyId: "h1",
      datasetId: "d1",
    });
    expect(
      (await two.harness.snapshot(UsageDoc, reopened.id, context))?.models.saved,
    ).toMatchObject({ input: document.session.usage.input, output: document.session.usage.output });
    // It continues after opening.
    await say(two, reopened, "and once more", reply("42 again"));
    expect(said((await contextOf(reopened)).messages)).toEqual([
      "compute it",
      "and again",
      "and once more",
    ]);
  });

  it("across a compaction, which still starts the context", async () => {
    const one = await machine(new MemoryStorage(), { ai_keep_recent_tokens: 1 });
    const conversation = await one.create({});
    await say(one, conversation, "first", tool("call_c"), reply("one"));
    await say(one, conversation, "second", reply("two"));
    answers.push(reply("<summary>first and second</summary>"));
    await one.harness.waitForTask(await conversation.compact(undefined, context), context);
    await conversation.waitForIdle(context);
    await say(one, conversation, "third", reply("three"));
    const { document, before, after } = await roundTrip(one, conversation, "compacted");
    expect(document.entries.find((e) => e.kind === "pi.compaction")?.head).toEqual({ entry: 5 });
    // The whole history is saved, not just the context.
    expect(document.entries.filter((e) => e.kind === "pi.user")).toHaveLength(3);
    expect(after.kinds[0]).toBe("pi.compaction");
    expect(after).toEqual(before);
  });

  it("across a reset with a handoff", async () => {
    const one = await machine();
    const conversation = await one.create({});
    await say(one, conversation, "before the reset", tool("call_d"), reply("done before"));
    await conversation.reset("Handoff: the answer was 42.", context);
    await conversation.waitForIdle(context);
    await say(one, conversation, "after the reset", reply("done after"));
    const { before, after } = await roundTrip(one, conversation, "reset");
    expect(after.kinds[0]).toBe("pi.reset");
    expect(said(after.messages)).toEqual(["Handoff: the answer was 42.", "after the reset"]);
    expect(after).toEqual(before);
  });

  it("from a fork", async () => {
    const one = await machine();
    const parent = await one.create({});
    await say(one, parent, "shared start", tool("call_e"), reply("shared reply"));
    const shared = (await parent.context(context)).entries.at(-1)!;
    await say(one, parent, "parent only", reply("parent reply"));
    const fork = await parent.fork(shared.id, { ownership: { kind: "ownerless" } }, context);
    await say(one, fork, "fork only", reply("fork reply"));
    const { before, after } = await roundTrip(one, fork, "fork");
    expect(said(after.messages)).toEqual(["shared start", "fork only"]);
    expect(after).toEqual(before);
  });

  it("after a model switch rewrote the system entries", async () => {
    const one = await machine();
    const conversation = await one.create({});
    await say(one, conversation, "first", reply("one"));
    await one.switchModel(conversation, { ai_model: "m2" });
    await say(one, conversation, "second", reply("two"));
    const { document, before, after } = await roundTrip(one, conversation, "switched");
    expect(document.entries.some((e) => e.kind === SYSTEM_KIND)).toBe(false);
    expect(after).toEqual(before);
  });

  it("a head on a system entry saves as the entry itself, which opens again", async () => {
    const one = await machine();
    const conversation = await one.create({});
    await say(one, conversation, "first", reply("one"));
    await conversation.commit(async (tx) => {
      const system = await tx.appendEntry(SystemEntry, conversation.id, {
        model: [{ role: "system", content: "" }] as unknown as Message[],
      });
      await tx.appendEntry(conversation.id, {
        kind: "pi.compaction",
        model: [{ role: "user", content: "<summary>first</summary>", timestamp: 0 }],
        head: system.id,
      });
    }, context);
    // pi's export names the entry itself by position here, which isSessionDocument refuses. The
    // system entries are not saved, so the context starts at the compaction either way.
    const document = JSON.parse(JSON.stringify(await one.export(conversation)));
    expect(document.entries.at(-1).head).toBe("self");
    expect(isSessionDocument(document)).toBe(true);
    const reopened = await (await machine()).open(document, "v1");
    expect(said((await contextOf(reopened)).messages)).toEqual(["<summary>first</summary>"]);
  });

  it("a context edit is not saved, as with pi's own export", async () => {
    const one = await machine();
    const conversation = await one.create({});
    await say(one, conversation, "my token is SECRET-123", reply("noted"));
    const view = await conversation.context(context);
    const [secret] = view.entries.filter((e) => e.kind !== SYSTEM_KIND);
    const redacted: Message = { role: "user", content: "[redacted]", timestamp: 0 };
    await (
      await conversation.submit(
        {
          type: "write",
          entry: {
            kind: "olit.redaction",
            edits: [{ target: secret.id, action: "replace", messages: [redacted] }],
          },
        },
        context,
      )
    ).wait(context);
    const { document, before, after } = await roundTrip(one, conversation, "edit");
    delete written.edit;
    expect(said(before.messages)).toEqual(["[redacted]"]);
    expect(document.entries.some((e) => "edits" in e)).toBe(false);
    expect(said(after.messages)).toEqual(["my token is SECRET-123"]);
  });

  it("from a save taken during a run", async () => {
    let started = false;
    python = {
      run: (_code, signal) => {
        started = true;
        return new Promise<string>((_, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      },
      write: async () => {},
      read: async () => undefined,
    };
    const one = await machine();
    const conversation = await one.create({});
    answers.push(tool("call_f"), hanging);
    await one.submit(conversation, "loop forever");
    for (let i = 0; i < 200 && !started; i++) await new Promise((r) => setTimeout(r, 10));
    const { before, after } = await roundTrip(one, conversation, "mid-run");
    expect(after).toEqual(before);
    await conversation.abort(context);
  });

  it("after the harness closes and its storage opens again", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "olit-noexport-")), "olit.sqlite3");
    const one = await machine(await openNodeSqliteStorage(file));
    const conversation = await one.create({ historyId: "h1" });
    await say(one, conversation, "compute it", tool("call_g"), reply("it is 42"));
    const before = await contextOf(conversation);
    const document = JSON.parse(JSON.stringify(await one.export(conversation)));
    await one.close();
    opened.splice(opened.indexOf(one), 1);
    const two = await machine(await openNodeSqliteStorage(file));
    const reopened = await two.open(document, "v1");
    expect(await contextOf(reopened)).toEqual(before);
    expect((await two.open(document, "v1")).id).toBe(reopened.id);
    expect((await two.harness.snapshot(Sessions, context))?.byHistory.h1).toBe(reopened.id);
  });
});

/** Saves another build wrote: the schema 5 fixtures, and READ when given. */
const foreign = {
  ...Object.fromEntries(Object.entries(saved5).map(([k, v]) => [`fixture:${k}`, v])),
  ...(READ && existsSync(READ)
    ? Object.fromEntries(
        Object.entries(JSON.parse(readFileSync(READ, "utf8"))).map(([k, v]) => [`read:${k}`, v]),
      )
    : {}),
} as unknown as Record<string, { document: SessionDocument; kinds: string[]; messages: Message[] }>;

describe("a save another build wrote", () => {
  it.each(Object.keys(foreign))(
    "%s opens with the same context, and saves back the same",
    async (name) => {
      const { document, kinds, messages } = foreign[name];
      expect(document.olit_session).toBe(5);
      expect(isSessionDocument(document)).toBe(true);
      const two = await machine();
      const reopened = await two.open(structuredClone(document), name);
      const after = await contextOf(reopened);
      expect(after.kinds).toEqual(kinds.filter((kind) => kind !== SYSTEM_KIND));
      expect(after.messages).toEqual(messages);
      const again = JSON.parse(JSON.stringify(await two.export(reopened)));
      expect(again.olit_session).toBe(5);
      expect(again.entries).toEqual(document.entries);
      // And it continues.
      await say(two, reopened, "go on", reply("going"));
      expect(said((await contextOf(reopened)).messages).at(-1)).toBe("go on");
    },
  );
});
