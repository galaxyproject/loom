// @vitest-environment node
/**
 * The Orbit brain's durable watch (slice 3, commit 17) on a real harness, with Orbit's poll
 * scripted: what it posts, what follow-up it hands the conversation, when it ends, and that it
 * polls nothing for a conversation the page isn't showing.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
  type Conversation,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PollOptions, TickResult } from "../../../../../extensions/orbit/galaxy-poller";
import type { TerminalEvent } from "../../../../../extensions/orbit/submission-ledger";
import { text } from "../fake-model";
import { agentModels } from "../model";
import { resolve } from "../providers";
import type { Settled } from "../watch";
import { orbitWatch, wakeups, Watching } from "./watch";

const ctx = BACKGROUND_CONTEXT;
const LLM = "http://llm.test/v1";

const key = (id: ConversationId) => `/orbit/${id}/notebook.md`;

const event = (recordKey: string, outcome = "completed"): TerminalEvent => ({
  recordKey,
  kind: "job",
  id: "j1",
  from: "in_progress",
  to: outcome,
  outcome,
  label: "cat1",
  key: `job:j1:${outcome}`,
  state: "confirmed",
});

/** A tick's result: quiet unless told otherwise. */
const tick = (recordKey: string, over: Partial<TickResult> = {}): TickResult => ({
  recordKey,
  transitions: [],
  inProgress: 0,
  pendingEnrichment: 0,
  openSubmissions: 0,
  ...over,
});

const opened: Harness[] = [];

/** A harness with the watch installed, a conversation, and the poll results to answer with. */
async function setup(
  script: (n: number, conversation: ConversationId) => TickResult,
  {
    delivered: deliver = async () => {},
    pollMs = 2,
  }: { delivered?: (keys: readonly string[]) => Promise<void>; pollMs?: number } = {},
) {
  vi.stubGlobal("fetch", async () => text("ok"));
  const polls: PollOptions[] = [];
  const settled: Settled[] = [];
  const delivered: string[][] = [];
  let bound: ConversationId | undefined;
  const { wake, woken } = wakeups();
  const watch = orbitWatch({
    pollMs,
    bound: (id) => id === bound,
    recordKey: key,
    poll: async (options) => {
      polls.push(options);
      return script(polls.length, bound!);
    },
    delivered: async (_key, keys) => {
      await deliver(keys);
      delivered.push([...keys]);
    },
    settled: (_id, s) => void settled.push(s),
    woken,
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "browser-shell", tasks: [watch.task] }));
  const { models, model } = await agentModels().connect(
    resolve({ ai_base_url: LLM, ai_model: "m", ai_api_key: "k" }),
  );
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  opened.push(harness);
  const conversation = await harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model } },
    ctx,
  );
  bound = conversation.id;
  harness.resume();
  const ensure = (options: { recover?: boolean } = {}) =>
    harness.commit((tx) => watch.ensure(tx, conversation.id, options), ctx);
  const active = async () =>
    (await harness.snapshot(Watching, conversation.id, ctx))?.active === true;
  return {
    harness,
    conversation,
    polls,
    settled,
    delivered,
    ensure,
    active,
    bind: (id: ConversationId | undefined) => (bound = id),
    wake,
    checkpoint: async () =>
      (await harness.inspect(ctx)).tasks.find((t) => t.record.kind === "olit.galaxy-watch")?.record
        .state as { checkpoint?: { ticks: number; backoff?: number } } | undefined,
  };
}

const inputs = async (conversation: Conversation) =>
  (await conversation.context(ctx)).messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));

afterEach(async () => {
  for (const harness of opened.splice(0)) await harness.close(ctx).catch(() => {});
  vi.unstubAllGlobals();
});

describe("the Orbit watch", () => {
  it("follows a submission to its end: posts it, hands over the follow-up once, and stops", async () => {
    const w = await setup((n, id) =>
      n === 1
        ? tick(key(id), { inProgress: 1 })
        : n === 2
          ? tick(key(id), {
              transitions: [event(key(id))],
              resumePrompt: "[follow-up] j1 completed",
            })
          : tick(key(id)),
    );
    await w.ensure();
    await vi.waitFor(async () => expect(await w.active()).toBe(false));
    expect(w.settled).toEqual([
      {
        watched: { kind: "job", id: "j1", label: "cat1", state: "completed" },
        state: "completed",
        outcome: "completed",
      },
    ]);
    expect(w.delivered).toEqual([["job:j1:completed"]]);
    await vi.waitFor(async () =>
      expect(await inputs(w.conversation)).toEqual(["[follow-up] j1 completed"]),
    );
    expect(w.polls).toHaveLength(2);
  });

  it("stays alive while a capture is still open, and ends once the ledger closes it", async () => {
    const w = await setup((n, id) => tick(key(id), { openSubmissions: n < 4 ? 1 : 0 }));
    await w.ensure();
    await vi.waitFor(async () => expect(await w.active()).toBe(false));
    expect(w.polls).toHaveLength(4);
  });

  it("waits on pending enrichment", async () => {
    const w = await setup((n, id) => tick(key(id), { pendingEnrichment: n < 3 ? 1 : 0 }));
    await w.ensure();
    await vi.waitFor(async () => expect(await w.active()).toBe(false));
    expect(w.polls).toHaveLength(3);
  });

  it("polls nothing for a conversation the page isn't showing, until it is shown again", async () => {
    const w = await setup((_n, id) => tick(key(id)));
    w.bind(undefined);
    await w.ensure();
    await new Promise((r) => setTimeout(r, 50));
    expect(w.polls).toEqual([]);
    expect(await w.active()).toBe(true);
    w.bind(w.conversation.id);
    w.wake(w.conversation.id);
    await vi.waitFor(async () => expect(await w.active()).toBe(false));
    expect(w.polls).toHaveLength(1);
  });

  it("asks the first tick after the conversation is shown to capture and reconcile", async () => {
    const w = await setup((_n, id) => tick(key(id)));
    await w.ensure({ recover: true });
    await vi.waitFor(async () => expect(await w.active()).toBe(false));
    expect(w.polls).toEqual([{ awaitEnrichment: true, reconcile: true, recover: true }]);
  });

  it("is one watch per conversation, however often it's asked for", async () => {
    const w = await setup((_n, id) => tick(key(id), { inProgress: 1 }));
    await w.ensure();
    await w.ensure();
    await w.ensure({ recover: true });
    await new Promise((r) => setTimeout(r, 30));
    const { tasks } = await w.harness.inspect(ctx);
    expect(tasks.filter((t) => t.record.kind === "olit.galaxy-watch")).toHaveLength(1);
  });

  it("hands over a follow-up once even when a crashed tick reported the same transition again", async () => {
    // The first tick dies after posting, before delivered; the next reports the event again.
    const w = await setup((n, id) =>
      n <= 2
        ? tick(key(id), {
            transitions: [event(key(id))],
            resumePrompt: "[follow-up] j1 completed",
            inProgress: n === 1 ? 1 : 0,
          })
        : tick(key(id)),
    );
    await w.ensure();
    await vi.waitFor(async () => expect(await w.active()).toBe(false));
    await vi.waitFor(async () =>
      expect(await inputs(w.conversation)).toEqual(["[follow-up] j1 completed"]),
    );
    expect(w.settled).toHaveLength(2);
  });

  it("discards a tick that ran against another record", async () => {
    let n = 0;
    const w = await setup((_n, id) =>
      ++n === 1
        ? tick("/orbit/other/notebook.md", { transitions: [event("/orbit/other/notebook.md")] })
        : tick(key(id)),
    );
    await w.ensure();
    await vi.waitFor(async () => expect(await w.active()).toBe(false));
    expect(w.settled).toEqual([]);
    expect(w.delivered).toEqual([]);
  });

  it("retries a tick that fails, rather than leaving the conversation unwatched", async () => {
    let failOnce = true;
    const w = await setup(
      (n, id) =>
        n === 1 ? tick(key(id), { transitions: [event(key(id))], inProgress: 1 }) : tick(key(id)),
      {
        delivered: async () => {
          if (failOnce) {
            failOnce = false;
            throw new Error("the ledger file refused the write");
          }
        },
      },
    );
    await w.ensure();
    await vi.waitFor(async () => expect(await w.active()).toBe(false));
    expect(w.polls.length).toBeGreaterThanOrEqual(2);
  });

  it("makes a new watch when the doc says active but names no live task", async () => {
    const w = await setup((_n, id) => tick(key(id)));
    await w.harness.commit(async (tx) => {
      Object.assign(await tx.doc(Watching, w.conversation.id), {
        active: true,
        taskId: "gone" as never,
      });
    }, ctx);
    await w.ensure();
    await vi.waitFor(() => expect(w.polls).toHaveLength(1));
  });

  it("keeps watching when some work settles while more is still running", async () => {
    const w = await setup((n, id) =>
      n === 1
        ? tick(key(id), { inProgress: 2 })
        : n === 2
          ? tick(key(id), { transitions: [event(key(id))], inProgress: 1 })
          : tick(key(id)),
    );
    await w.ensure();
    await vi.waitFor(async () => expect(await w.active()).toBe(false));
    // Ended by its own quiet tick, not faulted on the second: that one polled three times.
    expect(w.polls).toHaveLength(3);
    expect(w.delivered).toEqual([["job:j1:completed"]]);
  });

  it("doesn't end on a quiet tick when a submission arrived while it polled", async () => {
    let w!: Awaited<ReturnType<typeof setup>>;
    w = await setup((n, id) => {
      // The first tick sees nothing open; a submission's ensure lands before it commits.
      if (n === 1) void w.ensure();
      return tick(key(id));
    });
    await w.ensure();
    const first = (await w.harness.snapshot(Watching, w.conversation.id, ctx))?.taskId;
    await vi.waitFor(async () => expect(await w.active()).toBe(false));
    expect(w.polls).toHaveLength(2);
    // The same watch went on: the submission's ensure didn't have to make another.
    const { tasks } = await w.harness.inspect(ctx);
    expect(tasks.filter((t) => t.record.kind === "olit.galaxy-watch")).toEqual([]);
    expect(first).toBeDefined();
  });

  it.each([
    ["while it waits for the conversation to be shown", false],
    ["between ticks", true],
  ])("ends as aborted, with no fault, when its task is aborted %s", async (_when, shown) => {
    const w = await setup((_n, id) => tick(key(id), { inProgress: 1 }), { pollMs: 500 });
    if (!shown) w.bind(undefined);
    await w.ensure();
    if (shown) await vi.waitFor(() => expect(w.polls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    const [live] = (await w.harness.inspect(ctx)).tasks.filter(
      (t) => t.record.kind === "olit.galaxy-watch",
    );
    await w.harness.abortTask(live.record.id, ctx);
    const ended = await w.harness.waitForTask(live.record.id, ctx);
    expect((ended.state as { outcome: { status: string } }).outcome.status).toBe("aborted");
    expect(await w.active()).toBe(false);
  });

  it("starts the backoff over when new work arrives for a live watch", async () => {
    // Slow enough that a reset to 1 is still under 4 when it's sampled.
    const w = await setup((_n, id) => tick(key(id), { inProgress: 1 }), { pollMs: 20 });
    const backoff = async () => (await w.checkpoint())?.checkpoint?.backoff ?? 0;
    await w.ensure();
    await vi.waitFor(async () => expect(await backoff()).toBeGreaterThan(7), { timeout: 3_000 });
    await w.ensure();
    w.wake(w.conversation.id);
    await vi.waitFor(async () => expect(await backoff()).toBeLessThan(4));
  });

  it("writes nothing while the conversation isn't shown", async () => {
    const w = await setup((_n, id) => tick(key(id)));
    w.bind(undefined);
    await w.ensure();
    await new Promise((r) => setTimeout(r, 60));
    expect((await w.checkpoint())?.checkpoint?.ticks).toBe(0);
  });

  it("hands over a written-down follow-up once, after a tick that failed past writing it down", async () => {
    let failOnce = true;
    const w = await setup(
      (n, id) =>
        n === 1
          ? tick(key(id), {
              transitions: [event(key(id))],
              resumePrompt: "[follow-up] j1 completed",
            })
          : tick(key(id)),
      {
        delivered: async () => {
          if (failOnce) {
            failOnce = false;
            throw new Error("died after the hand-over");
          }
        },
      },
    );
    await w.ensure();
    await vi.waitFor(async () => expect(await w.active()).toBe(false));
    await vi.waitFor(async () =>
      expect(await inputs(w.conversation)).toEqual(["[follow-up] j1 completed"]),
    );
    expect(w.delivered).toEqual([["job:j1:completed"]]);
  });
});

describe("wakeups", () => {
  it("keeps a wake that lands after a wait ended by its timer", async () => {
    const { wake, woken } = wakeups();
    const id = 3 as unknown as ConversationId;
    // A wait that ended some other way stops listening, as the watch's pause does.
    const ended = new AbortController();
    void woken(id, ended.signal);
    ended.abort();
    wake(id);
    let resolved = false;
    await woken(id).then(() => (resolved = true));
    expect(resolved).toBe(true);
  });

  it("keeps a wake that came with nobody waiting for the next wait", async () => {
    const { wake, woken } = wakeups();
    const id = 7 as unknown as ConversationId;
    wake(id);
    let resolved = false;
    await woken(id).then(() => (resolved = true));
    expect(resolved).toBe(true);
    // Used up: the next wait waits.
    let again = false;
    void woken(id).then(() => (again = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(again).toBe(false);
    wake(id);
    await new Promise((r) => setTimeout(r, 0));
    expect(again).toBe(true);
  });
});
