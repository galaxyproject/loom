// @vitest-environment node
/**
 * The Orbit worker through the page protocol (slice 3, commits 13 and 15): the messages the page
 * sends, answered by Orbit's brain on pi-host over a fake model and a fake Galaxy. No browser: the
 * worker's `self` is stubbed and the user lookup fails, so storage and the ledger are in memory.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { text, toolCall } from "../fake-model";

const LLM = "http://llm.test/v1";
const GALAXY = "http://galaxy.test";
const JOB = "aaaa000000000001";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Message = { type: string; [key: string]: unknown };

/** A fake Galaxy holding pages, and a hold the test can put on one page's writes. */
function galaxy(
  seed: Array<{ id: string; slug: string; content: string; deleted?: boolean }> = [],
) {
  const pages = new Map<
    string,
    { id: string; slug: string; history_id: string; content: string; deleted?: boolean }
  >(seed.map((page) => [page.id, { history_id: "h1", ...page }]));
  const puts: string[] = [];
  let created = 0;
  let hold: { page: string; gate: Promise<void> } | undefined;
  let jobHold: Promise<void> | undefined;
  let jobAsked = 0;
  const job = { state: "running" };
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/api/users/current") return json({ err_msg: "no session" }, 500);
    if (path === "/api/pages" && request.method === "GET") {
      const history = url.searchParams.get("history_id");
      return json([...pages.values()].filter((p) => p.history_id === history));
    }
    if (path === "/api/pages" && request.method === "POST") {
      const body = (await request.json()) as { slug: string; history_id: string; content: string };
      const id = `page-${++created}`;
      pages.set(id, { id, slug: body.slug, history_id: body.history_id, content: body.content });
      return json(pages.get(id));
    }
    const page = path.match(/^\/api\/pages\/([^/]+)$/)?.[1];
    if (page && pages.has(page)) {
      if (request.method === "PUT") {
        if (hold?.page === page) await hold.gate;
        const body = (await request.json()) as { content: string };
        puts.push(page);
        pages.get(page)!.content = body.content;
      }
      const stored = pages.get(page)!;
      return json({ ...stored, content_editor: stored.content });
    }
    if (path === "/api/tools" && request.method === "POST") {
      return json({ jobs: [{ id: JOB, tool_id: "cat1", history_id: "h1" }], outputs: [] });
    }
    if (path.startsWith("/api/jobs/")) {
      jobAsked += 1;
      if (jobHold) await jobHold;
      return json({ id: JOB, state: job.state, tool_id: "cat1", history_id: "h1", outputs: {} });
    }
    return json({});
  };
  return {
    pages,
    puts,
    job,
    handle,
    get jobAsked() {
      return jobAsked;
    },
    /** Hold every job status request until the returned release. */
    holdJobs() {
      let release!: () => void;
      jobHold = new Promise<void>((r) => (release = r));
      return () => {
        jobHold = undefined;
        release();
      };
    },
    holdWrites(page: string) {
      let release!: () => void;
      hold = { page, gate: new Promise<void>((r) => (release = r)) };
      return () => {
        hold = undefined;
        release();
      };
    },
  };
}

/** The worker, booted from a fresh module graph, and what it has posted to the page. */
async function worker(
  answers: Array<() => Response>,
  capabilities = ["llm", "read", "write"],
  config: Record<string, unknown> = {},
  seed: Parameters<typeof galaxy>[0] = [],
  flavor: object = {},
) {
  vi.resetModules();
  const fake = galaxy(seed);
  let asked = 0;
  const prompts: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (request.url.startsWith(LLM)) {
      prompts.push(await request.clone().text());
      return (answers[asked++] ?? (() => text("done")))();
    }
    return fake.handle(request);
  });
  const posted: Message[] = [];
  const self = {
    postMessage: (message: Message) => void posted.push(message),
    close: () => {},
    location: { href: `${GALAXY}/` },
    onmessage: undefined as undefined | ((event: { data: unknown }) => void),
  };
  vi.stubGlobal("self", self);
  const { startAgentWorker } = await import("../worker");
  startAgentWorker(flavor);
  const send = (data: unknown) => self.onmessage!({ data });
  const seen = (type: string) => posted.filter((m) => m.type === type);
  send({
    type: "open",
    request: {
      pyodideURL: "",
      config: {
        galaxy_root: `${GALAXY}/`,
        ai_base_url: LLM,
        ai_model: "m",
        ai_api_key: "k",
        capabilities,
        ...config,
      },
      placement: { historyId: "h1" },
    },
  });
  await vi.waitFor(
    () => expect(seen("ready").length + seen("failed").length + seen("recoverable").length).toBe(1),
    { timeout: 10_000 },
  );
  return { fake, posted, send, seen, prompts };
}

afterEach(async () => {
  const { setCapabilityProfile } = await import("../../../../../shared/capability-profile.js");
  setCapabilityProfile(null);
  vi.unstubAllGlobals();
});

// Each case boots the brain from scratch, which takes a few seconds under a busy suite.
describe("the Orbit worker", { timeout: 30_000 }, () => {
  it("opens on Orbit's brain and says so", async () => {
    const { seen } = await worker([]);
    expect(seen("failed")).toEqual([]);
    expect(seen("ready")[0]).toMatchObject({ brain: "orbit" });
    // The page shows the conversation from a snapshot on.
    expect(seen("events")[0]).toMatchObject({ events: [{ type: "snapshot" }] });
    // The brain's history defaults go to the conversation's, past session_start's reset.
    const { getCurrentHistoryId } = await import("../../../../../extensions/orbit/state");
    expect(getCurrentHistoryId()).toBe("h1");
  });

  describe("a history with earlier records", () => {
    // Orbit's own record, the browser brain's, and a deleted one of Orbit's.
    const seed = [
      { id: "page-old", slug: "orbit-orbit-sess-a", content: "Earlier analysis notes." },
      { id: "page-browser", slug: "orbit-sess-b", content: "The browser brain's." },
      { id: "page-gone", slug: "orbit-orbit-sess-c", content: "Deleted.", deleted: true },
    ];
    const submit = [
      () => toolCall("run_tool", { history_id: "h1", tool_id: "cat1", inputs: {} }),
      () => text("submitted"),
    ];

    it("offers only Orbit's live records, and starts nothing until the user picks", async () => {
      const { fake, seen } = await worker([], undefined, undefined, seed);
      expect(seen("recoverable")).toHaveLength(1);
      expect(seen("recoverable")[0].records).toEqual([
        expect.objectContaining({ pageId: "page-old", sessionId: "sess-a" }),
      ]);
      expect(seen("ready")).toEqual([]);
      expect(seen("events")).toEqual([]);
      expect(fake.pages.size).toBe(3);
    });

    it("continues the picked record: the model reads it and the run lands on that page", async () => {
      const { fake, send, seen, prompts } = await worker(submit, undefined, undefined, seed);
      send({ type: "recover", pageId: "page-old" });
      await vi.waitFor(() => expect(seen("ready")).toHaveLength(1), { timeout: 10_000 });
      expect(seen("ready")[0]).toMatchObject({ brain: "orbit" });
      send({ type: "submit", text: "run cat on it" });
      await vi.waitFor(() => expect(fake.puts).toContain("page-old"), { timeout: 10_000 });
      expect(prompts[0]).toContain("Earlier analysis notes.");
      expect(fake.pages.size).toBe(3);
    });

    it("starts a new record when the user picks none", async () => {
      const { fake, send, seen } = await worker(submit, undefined, undefined, seed);
      send({ type: "recover" });
      await vi.waitFor(() => expect(seen("ready")).toHaveLength(1), { timeout: 10_000 });
      send({ type: "submit", text: "run cat on it" });
      await vi.waitFor(() => expect(fake.pages.size).toBe(4), { timeout: 10_000 });
      const made = [...fake.pages.values()].at(-1)!;
      expect(made.slug).toMatch(/^orbit-orbit-/);
      expect(made.slug).not.toBe("orbit-orbit-sess-a");
      expect(made.history_id).toBe("h1");
      expect(fake.puts).not.toContain("page-old");
    });
  });

  it("keeps each conversation's approvals in its own registry, so /pending never shows another's", async () => {
    const { send, seen } = await worker([]);
    const { getSessionRegistry } = await import("../../../../../extensions/orbit/registry-runtime");
    const first = getSessionRegistry()!;
    expect(first.store.mode).toBe("writer");
    send({ type: "reset" });
    const snapshots = () =>
      seen("events").filter((m) => (m.events as Message[])[0]?.type === "snapshot");
    await vi.waitFor(() => expect(snapshots()).toHaveLength(2), { timeout: 10_000 });
    const second = getSessionRegistry()!;
    expect(second.analysisDir).toMatch(/^\/orbit\/[^/]+$/);
    expect(second.analysisDir).not.toBe(first.analysisDir);
    expect(second.store.registryPath).not.toBe(first.store.registryPath);
    expect(second.store.mode).toBe("writer");
  });

  it("goes back to the conversation that was shown when a switch fails partway, and says so", async () => {
    // The brand is read when each record store is made: fail that once, for the new conversation.
    let failNext = false;
    const flavor = {
      get brand() {
        if (failNext) {
          failNext = false;
          throw new Error("the record could not be made");
        }
        return undefined;
      },
    };
    const { send, seen } = await worker(
      [() => text("first answer"), () => text("still here")],
      undefined,
      undefined,
      undefined,
      flavor,
    );
    const snapshots = () =>
      seen("events").filter((m) => (m.events as Message[])[0]?.type === "snapshot");
    send({ type: "submit", text: "hello" });
    await vi.waitFor(
      () =>
        expect(seen("events").some((m) => JSON.stringify(m.events).includes("first answer"))).toBe(
          true,
        ),
      { timeout: 10_000 },
    );
    failNext = true;
    send({ type: "reset" });
    await vi.waitFor(() => expect(seen("failed")).toHaveLength(1), { timeout: 10_000 });
    expect(seen("failed")[0].message).toContain("the record could not be made");
    // Shown again: the page's last snapshot is the first conversation's, its turn and all.
    expect(JSON.stringify(snapshots().at(-1)!.events)).toContain("first answer");
    // The history continues the conversation shown again, not the one the failed reset made.
    const { orbitSession } = await import("./worker");
    const { runtime, conversation } = orbitSession();
    expect((await runtime!.kept({ historyId: "h1" }))?.id).toBe(conversation!.id);
    send({ type: "submit", text: "are you there?" });
    await vi.waitFor(
      () =>
        expect(seen("events").some((m) => JSON.stringify(m.events).includes("still here"))).toBe(
          true,
        ),
      { timeout: 10_000 },
    );
  });

  it("takes the conversation back whole when leaving it fails partway through a reset", async () => {
    const { send, seen } = await worker([() => text("still here")]);
    const { orbitSession } = await import("./worker");
    const host = orbitSession().host!;
    // After its calls are quiesced: the conversation shown again has to admit them once more.
    vi.spyOn(host, "settle").mockRejectedValueOnce(new Error("the calls would not settle"));
    send({ type: "reset" });
    await vi.waitFor(() => expect(seen("failed")).toHaveLength(1), { timeout: 10_000 });
    expect(seen("failed")[0].message).toContain("the calls would not settle");
    const notices = seen("notice").length;
    send({ type: "submit", text: "/pending" });
    await vi.waitFor(() => expect(seen("quiet")).toHaveLength(1), { timeout: 10_000 });
    expect(seen("notice").length).toBeGreaterThan(notices);
    send({ type: "submit", text: "are you there?" });
    await vi.waitFor(
      () =>
        expect(seen("events").some((m) => JSON.stringify(m.events).includes("still here"))).toBe(
          true,
        ),
      { timeout: 10_000 },
    );
  });

  it("puts a message sent during a reset into the new conversation", async () => {
    const { send, seen } = await worker([() => text("hello again")]);
    send({ type: "reset" });
    send({ type: "submit", text: "the first words of the new conversation" });
    const snapshots = () =>
      seen("events").filter((m) => (m.events as Message[])[0]?.type === "snapshot");
    await vi.waitFor(() => expect(snapshots()).toHaveLength(2), { timeout: 10_000 });
    const second = seen("events").indexOf(snapshots()[1]);
    await vi.waitFor(
      () =>
        expect(
          seen("events")
            .slice(second)
            .some((m) =>
              JSON.stringify(m.events).includes("the first words of the new conversation"),
            ),
        ).toBe(true),
      { timeout: 10_000 },
    );
  });

  it("withdraws a waiting confirmation at Stop and ends the call", async () => {
    const { send, seen } = await worker([
      () => toolCall("update_history", { history_id: "h1", deleted: true }),
      () => text("stopped"),
    ]);
    send({ type: "submit", text: "delete my history" });
    await vi.waitFor(() => expect(seen("confirm")).toHaveLength(1), { timeout: 10_000 });
    const asked = seen("confirm")[0] as unknown as { id: number };
    send({ type: "stop" });
    await vi.waitFor(
      () => expect(seen("withdrawn")).toContainEqual({ type: "withdrawn", id: asked.id }),
      {
        timeout: 10_000,
      },
    );
    await vi.waitFor(
      () =>
        expect(
          seen("events").some((m) =>
            (m.events as Message[]).some((e) => e.type === "tool_execution_end"),
          ),
        ).toBe(true),
      { timeout: 10_000 },
    );
  });

  it("withdraws a waiting confirmation at Stop while a slower message is still in order", async () => {
    const { send, seen } = await worker([
      () => toolCall("update_history", { history_id: "h1", deleted: true }),
      () => text("stopped"),
    ]);
    // A model switch whose server never answers holds every message after it in order.
    const LOCAL = "http://local.test";
    const fetched = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input instanceof Request ? input.url : input).startsWith(LOCAL)
        ? new Promise<Response>(() => {})
        : fetched(input, init),
    );
    send({ type: "submit", text: "delete my history" });
    await vi.waitFor(() => expect(seen("confirm")).toHaveLength(1), { timeout: 10_000 });
    const asked = seen("confirm")[0] as unknown as { id: number };
    send({ type: "switch", id: 7, config: { ai_provider: "ollama", ai_base_url: LOCAL } });
    send({ type: "stop" });
    await vi.waitFor(
      () =>
        expect(
          seen("events").some((m) =>
            (m.events as Message[]).some((e) => e.type === "tool_execution_end"),
          ),
        ).toBe(true),
      { timeout: 10_000 },
    );
    expect(seen("withdrawn")).toContainEqual({ type: "withdrawn", id: asked.id });
    expect(seen("reply")).toHaveLength(0);
  });

  it("offers a read-only launch no Galaxy writer to call", async () => {
    const { send, seen, prompts } = await worker(
      [() => toolCall("update_history", { history_id: "h1", deleted: true }), () => text("ok")],
      ["llm", "read"],
    );
    send({ type: "submit", text: "delete my history" });
    await vi.waitFor(() => expect(prompts).toHaveLength(2), { timeout: 10_000 });
    expect(prompts[0]).toContain('"get_histories"');
    expect(prompts[0]).not.toContain('"update_history"');
    // Not run, so nothing asked the user.
    expect(seen("confirm")).toHaveLength(0);
  });

  it("answers a slash command with a notice and tells the page nothing is running", async () => {
    const { send, seen } = await worker([]);
    send({ type: "submit", text: "/pending" });
    await vi.waitFor(() => expect(seen("quiet")).toHaveLength(1));
    expect(seen("notice").length).toBeGreaterThan(0);
  });

  it("lands a submission whose capture is still writing when the user resets in the first conversation's page", async () => {
    const { fake, send, seen } = await worker([
      () => toolCall("run_tool", { history_id: "h1", tool_id: "cat1", inputs: {} }),
      () => text("submitted"),
    ]);
    // The first write to the conversation's page is capture's job block: hold it.
    let release: (() => void) | undefined;
    const watching = setInterval(() => {
      if (!release && fake.pages.size === 1) release = fake.holdWrites([...fake.pages.keys()][0]);
    }, 1);
    send({ type: "submit", text: "run cat on it" });
    await vi.waitFor(() => expect(release).toBeDefined(), { timeout: 10_000 });
    clearInterval(watching);
    const [first] = [...fake.pages.keys()];
    const snapshots = () =>
      seen("events").filter((m) => (m.events as Message[])[0]?.type === "snapshot");
    send({ type: "reset" });
    // The switch waits for the capture: settle waits on its end events, and the outgoing
    // session's summary waits on the record lock the capture holds.
    await new Promise((r) => setTimeout(r, 50));
    expect(snapshots()).toHaveLength(1);
    release!();
    await vi.waitFor(() => expect(snapshots()).toHaveLength(2), { timeout: 10_000 });
    const { galaxyMarkdownToOrbit } =
      await import("../../../../../extensions/orbit/galaxy-markdown-adapter");
    expect(galaxyMarkdownToOrbit(fake.pages.get(first)!.content)).toContain(`job_id: ${JOB}`);
    // The new conversation got no page of its own from it.
    expect(fake.pages.size).toBe(1);
    expect(new Set(fake.puts)).toEqual(new Set([first]));
  }, 20_000);

  it("watches a submission to its end: the block, the page's settled line, and one follow-up turn", async () => {
    const { fake, send, seen, prompts } = await worker(
      [
        () => toolCall("run_tool", { history_id: "h1", tool_id: "cat1", inputs: {} }),
        () => text("submitted"),
        () => text("followed up"),
      ],
      ["llm", "read", "write"],
      { poll_ms: 5 },
    );
    const { galaxyMarkdownToOrbit } =
      await import("../../../../../extensions/orbit/galaxy-markdown-adapter");
    const record = () => galaxyMarkdownToOrbit([...fake.pages.values()][0]?.content ?? "");
    send({ type: "submit", text: "run cat on it" });
    await vi.waitFor(() => expect(record()).toContain(`job_id: ${JOB}`), { timeout: 10_000 });
    fake.job.state = "ok";
    await vi.waitFor(() => expect(seen("settled")).toHaveLength(1), { timeout: 10_000 });
    expect(seen("settled")[0]).toMatchObject({
      settled: { watched: { kind: "job", id: JOB }, outcome: "completed" },
    });
    await vi.waitFor(() => expect(prompts).toHaveLength(3), { timeout: 10_000 });
    expect(prompts[2]).toContain(JOB);
    expect(record()).toMatch(/status: completed/);
    // Delivered once: later ticks hand over nothing more.
    await new Promise((r) => setTimeout(r, 100));
    expect(prompts).toHaveLength(3);
    expect(seen("settled")).toHaveLength(1);
  });

  it("lets a poll that was in flight when the user switched land on the conversation it was for", async () => {
    const { fake, send, seen, posted, prompts } = await worker(
      [
        () => toolCall("run_tool", { history_id: "h1", tool_id: "cat1", inputs: {} }),
        () => text("submitted"),
      ],
      ["llm", "read", "write"],
      { poll_ms: 5 },
    );
    const { galaxyMarkdownToOrbit } =
      await import("../../../../../extensions/orbit/galaxy-markdown-adapter");
    send({ type: "submit", text: "run cat on it" });
    await vi.waitFor(() => expect(fake.pages.size).toBe(1), { timeout: 10_000 });
    const [left] = [...fake.pages.keys()];
    const record = () => galaxyMarkdownToOrbit(fake.pages.get(left)!.content);
    await vi.waitFor(() => expect(prompts).toHaveLength(2), { timeout: 10_000 });
    // The job finishes while the tick asking about it is held mid-poll.
    const release = fake.holdJobs();
    const asked = fake.jobAsked;
    fake.job.state = "ok";
    await vi.waitFor(() => expect(fake.jobAsked).toBeGreaterThan(asked), { timeout: 10_000 });
    send({ type: "reset" });
    await new Promise((r) => setTimeout(r, 50));
    release();
    const snapshots = () =>
      seen("events").filter((m) => (m.events as Message[])[0]?.type === "snapshot");
    await vi.waitFor(() => expect(snapshots()).toHaveLength(2), { timeout: 10_000 });
    await vi.waitFor(() => expect(record()).toMatch(/status: completed/), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 100));
    // The switch waits for Galaxy work in flight, so the tick lands while the first conversation
    // is still shown: its Settled goes out before the new conversation's snapshot, never after.
    const second = posted.indexOf(snapshots()[1]);
    expect(seen("settled")).toHaveLength(1);
    expect(posted.indexOf(seen("settled")[0])).toBeLessThan(second);
    expect(fake.pages.size).toBe(1);
  });

  it("keeps a conversation's record current after Reset leaves it, with no follow-up nobody sees", async () => {
    const { fake, send, seen, prompts } = await worker(
      [
        () => toolCall("run_tool", { history_id: "h1", tool_id: "cat1", inputs: {} }),
        () => text("submitted"),
      ],
      ["llm", "read", "write"],
      { poll_ms: 5 },
    );
    const { galaxyMarkdownToOrbit } =
      await import("../../../../../extensions/orbit/galaxy-markdown-adapter");
    send({ type: "submit", text: "run cat on it" });
    await vi.waitFor(() => expect(fake.pages.size).toBe(1), { timeout: 10_000 });
    const [left] = [...fake.pages.keys()];
    const record = () => galaxyMarkdownToOrbit(fake.pages.get(left)!.content);
    await vi.waitFor(() => expect(record()).toContain(`job_id: ${JOB}`), { timeout: 10_000 });
    await vi.waitFor(() => expect(prompts).toHaveLength(2), { timeout: 10_000 });
    send({ type: "reset" });
    const snapshots = () =>
      seen("events").filter((m) => (m.events as Message[])[0]?.type === "snapshot");
    await vi.waitFor(() => expect(snapshots()).toHaveLength(2), { timeout: 10_000 });
    fake.job.state = "ok";
    await vi.waitFor(() => expect(record()).toMatch(/status: completed/), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 100));
    expect(prompts).toHaveLength(2);
    expect(seen("settled")).toEqual([]);
  });
});
