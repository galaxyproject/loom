import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { connect as connectTcp, createServer as createNetServer, type AddressInfo } from "node:net";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@earendil-works/pi-durable";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { Oidc } from "../auth/oidc";
import type { AuthContext } from "../auth/routes";
import { createSession } from "../auth/sessions";
import { migrate } from "../db/migrate";
import { createConversation } from "../dispatch/conversations";
import { Dispatcher } from "../dispatch/dispatcher";
import { galaxyPageRetitler } from "../dispatch/pages";
import { freshDatabase, testDatabase } from "../test-db";
import { startStandIn, textOf, type StandIn } from "../test-stand-in";
import { createTokenCache } from "../tokens/token-cache";
import { bundleWorker } from "../worker/bundle";
import { createHostServer } from "./http";
import { Sockets, type ToPage } from "./socket";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATABASE = testDatabase("orbit_hosted_server");
const SOCKET = process.env.PGHOST ?? "/tmp";
const KEY = Buffer.alloc(32, 5);

let pool: pg.Pool;
let boss: PgBoss;
let standIn: StandIn;
let dispatcher: Dispatcher;
let server: Server;
let origin: string;
let killSwitch: string | undefined;
let sockets: Sockets | undefined;

const unusedOidc = {} as Oidc;

beforeAll(async () => {
  pool = new pg.Pool({ ...(await freshDatabase(DATABASE)), max: 8 });
  await migrate(pool);
  standIn = await startStandIn();
  const bundle = await bundleWorker(
    join(HERE, "..", "worker", "boot.ts"),
    join(HERE, "..", "..", ".scratch", "server", "boot.mjs"),
  );
  boss = new PgBoss({
    host: SOCKET,
    database: DATABASE,
    user: userInfo().username,
    schedule: false,
    supervise: false,
  });
  boss.on("error", () => undefined);
  await boss.start();
  // The public URL has to be known before the server is built, so find a free port first.
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
  await new Promise((resolve) => probe.close(resolve));
  // A token per user, so a test can tell whose a Galaxy request went out as.
  const tokens = createTokenCache({
    refresh: async (sub) => ({ token: `token-${sub}`, expiresAt: Date.now() + 600_000 }),
  });
  const auth: AuthContext = {
    pool,
    oidc: unusedOidc,
    tokens,
    tokenKey: KEY,
    publicUrl: new URL(origin),
    galaxyUrl: new URL(standIn.origin),
    galaxyLinkUrl: new URL("/login/start", standIn.origin),
  };
  dispatcher = new Dispatcher({
    pool,
    boss,
    bundle,
    hostId: `server-${randomUUID()}`,
    databaseUrl: `postgres://${userInfo().username}@/${DATABASE}?host=${encodeURIComponent(SOCKET)}`,
    galaxyUrl: standIn.origin,
    lease: { ttlMs: 60_000, renewMs: 15_000, maxTurnMs: 60_000 },
    limits: { maxTurns: 6, maxToolCalls: 20, outputBytes: 1 << 22 },
    tokens,
    modelFor: (sub) => ({
      baseUrl: `${standIn.origin}/v1`,
      id: "m",
      apiKey: "model-key-0123456789",
      user: sub,
    }),
    pageFor: async (conversation) => `page-${conversation.id}`,
    onEvent: (id, event) => sockets?.deliver(id, event),
    retryDelayMs: () => 300,
  });
  const retitle = galaxyPageRetitler({ galaxyUrl: standIn.origin, tokens });
  sockets = new Sockets({
    auth,
    dispatcher,
    get turnsDisabled() {
      return killSwitch;
    },
    retitlePage: (conversation) =>
      conversation.pageId === "page-unreachable" ? Promise.reject(new Error("Galaxy is down")) : retitle(conversation),
  });
  server = createHostServer({ auth, sockets, health: async () => ({ postgres: true }) });
  const port = Number(new URL(origin).port);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  await dispatcher.start();
});

afterAll(async () => {
  await dispatcher?.shutdown();
  await boss?.stop({ graceful: false });
  await new Promise((resolve) => server?.close(resolve));
  await pool?.end();
  await standIn?.close();
});

/** A signed-in user: their row, a session, and the cookie that carries it. */
async function signedIn(): Promise<{ sub: string; cookie: string }> {
  const sub = `user-${randomUUID()}`;
  const id = await createSession(pool, KEY, {
    sub,
    accessToken: "a",
    accessExpiresAt: Date.now() + 60_000,
    refreshToken: "r",
    refreshExpiresAt: Date.now() + 3_600_000,
    idToken: undefined,
  });
  return { sub, cookie: `orbit_session=${id}` };
}

class Page {
  readonly received: ToPage[] = [];
  readonly ws: WebSocket;
  readonly opened: Promise<void>;
  constructor(cookie: string | undefined, pageOrigin = origin) {
    this.ws = new WebSocket(`${origin.replace("http", "ws")}/ws`, {
      headers: { ...(cookie ? { cookie } : {}), origin: pageOrigin },
    });
    this.ws.on("message", (raw) => this.received.push(JSON.parse(String(raw)) as ToPage));
    this.opened = new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("unexpected-response", (_req, res) =>
        reject(new Error(`HTTP ${res.statusCode}`)),
      );
      this.ws.once("error", reject);
    });
  }
  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }
  events(): AgentEvent[] {
    return this.received.flatMap((m) => (m.type === "events" ? [...m.events] : []));
  }
  close(): void {
    this.ws.close();
  }
}

async function until<T>(
  check: () => T | undefined | false | Promise<T | undefined | false>,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const modelSaw = (text: string) =>
  standIn.seen.filter((s) => s.to === "model" && s.userText === text).length;
const userEntries = (events: AgentEvent[], text: string) =>
  events
    .filter((e): e is Extract<AgentEvent, { type: "snapshot" }> => e.type === "snapshot")
    .at(-1)
    ?.entries.filter((e) => {
      // A user message is a pi.user entry carrying the model's view of it.
      const { kind, model } = e as {
        kind?: string;
        model?: Array<{ role?: string; content?: unknown }>;
      };
      return (
        kind === "pi.user" &&
        (model ?? []).some((m) => m.role === "user" && textOf(m.content) === text)
      );
    }) ?? [];

describe("the WebSocket", () => {
  it("only lets in a signed-in page from Orbit's own origin", async () => {
    await expect(new Page(undefined).opened).rejects.toThrow("HTTP 401");
    const { cookie } = await signedIn();
    await expect(new Page(cookie, "https://evil.test").opened).rejects.toThrow("HTTP 403");
    const page = new Page(cookie);
    await page.opened;
    page.close();
  });

  it("runs a turn end to end, and a page that reconnects mid-conversation redraws it without duplicates", async () => {
    const { sub, cookie } = await signedIn();
    const c = await createConversation(pool, sub);
    const page = new Page(cookie);
    await page.opened;
    page.send({ type: "open", conversationId: c.id });
    await until(() => page.received.some((m) => m.type === "ready"), "ready");
    await until(() => page.events().some((e) => e.type === "snapshot"), "the stored snapshot");
    page.send({ type: "submit", conversationId: c.id, text: "hello there" });
    await until(() => modelSaw("hello there") > 0, "the model to hear it");
    await until(() => page.events().some((e) => e.type === "run_end"), "the run to end");

    const again = new Page(cookie);
    await again.opened;
    again.send({ type: "open", conversationId: c.id });
    await until(
      () => userEntries(again.events(), "hello there").length > 0,
      "a snapshot from the worker",
    );
    expect(userEntries(again.events(), "hello there")).toHaveLength(1);
    page.close();
    again.close();
  });

  it("carries the first message's title to a Galaxy page made before there was one, and a failure doesn't stop the turn", async () => {
    for (const pageId of ["page-generic", "page-unreachable"]) {
      const { sub, cookie } = await signedIn();
      const c = await createConversation(pool, sub);
      await pool.query("UPDATE orbit_conversations SET page_id = $2 WHERE id = $1", [c.id, pageId]);
      const page = new Page(cookie);
      await page.opened;
      page.send({ type: "open", conversationId: c.id });
      await until(() => page.received.some((m) => m.type === "ready"), "ready");
      const text = `Name the page ${pageId}`;
      page.send({ type: "submit", conversationId: c.id, text });
      await until(() => modelSaw(text) > 0, "the model to hear it");
      await until(() => page.events().some((e) => e.type === "run_end"), "the run to end");
      const retitled = standIn.seen.filter((s) => s.to === "galaxy" && s.method === "PUT" && s.path === `/api/pages/${pageId}`);
      expect(retitled.map((s) => s.authorization)).toEqual(pageId === "page-generic" ? [`Bearer token-${sub}`] : []);
      page.close();
    }
  });

  it("survives an upgrade request it can't parse", async () => {
    const answer = await new Promise<string>((resolve) => {
      const raw = connectTcp(Number(new URL(origin).port), "127.0.0.1", () =>
        raw.write(
          "GET http://a:zz/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        ),
      );
      let text = "";
      raw.on("data", (chunk) => (text += String(chunk)));
      raw.on("close", () => resolve(text));
      raw.on("error", () => resolve(text));
    });
    expect(answer).toMatch(/^HTTP\/1\.1 400/);
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
  });

  it("ends a socket whose session was signed out elsewhere", async () => {
    const { sub, cookie } = await signedIn();
    const c = await createConversation(pool, sub);
    const page = new Page(cookie);
    await page.opened;
    const closed = new Promise<number>((resolve) => page.ws.once("close", (code) => resolve(code)));
    await pool.query("DELETE FROM orbit_sessions WHERE user_sub = $1", [sub]);
    page.send({ type: "submit", conversationId: c.id, text: "after sign-out" });
    expect(await closed).toBe(4401);
    expect(page.received.find((m) => m.type === "failed")).toBeDefined();
    expect(modelSaw("after sign-out")).toBe(0);
  });

  it("refuses a message naming another user's conversation, and nothing reaches the model", async () => {
    const owner = await signedIn();
    const c = await createConversation(pool, owner.sub);
    const stranger = await signedIn();
    const page = new Page(stranger.cookie);
    await page.opened;
    page.send({ type: "submit", conversationId: c.id, text: "not yours" });
    page.send({ type: "open", conversationId: c.id });
    await until(
      () => page.received.filter((m) => m.type === "failed").length >= 2,
      "both refusals",
    );
    expect(page.received.some((m) => m.type === "events")).toBe(false);
    expect(modelSaw("not yours")).toBe(0);
    page.close();
  });

  it("still readies a page that opened a running conversation whose worker exited before its snapshot", async () => {
    const { sub, cookie } = await signedIn();
    const c = await createConversation(pool, sub);
    const page = new Page(cookie);
    await page.opened;
    // A worker that is live when the page opens and gone before it answers the snapshot request.
    const { isLive, snapshot } = dispatcher;
    let asked!: () => void;
    const snapshotAsked = new Promise<void>((resolve) => (asked = resolve));
    dispatcher.isLive = (id) => id === c.id || isLive.call(dispatcher, id);
    dispatcher.snapshot = (id) => (id === c.id ? (asked(), true) : snapshot.call(dispatcher, id));
    try {
      page.send({ type: "open", conversationId: c.id });
      await snapshotAsked;
    } finally {
      dispatcher.isLive = isLive;
      dispatcher.snapshot = snapshot;
    }
    sockets!.deliver(c.id, { type: "worker-exit", code: 75 });
    await until(() => page.received.some((m) => m.type === "ready"), "ready");
    expect(page.events().some((e) => e.type === "snapshot")).toBe(true);
    page.close();
  });

  it("shows a pending confirm, again to a page that reconnects, and the answer runs the call", async () => {
    const { sub, cookie } = await signedIn();
    const c = await createConversation(pool, sub);
    const page = new Page(cookie);
    await page.opened;
    page.send({ type: "open", conversationId: c.id });
    const puts = standIn.galaxyCalls("PUT", "/api/histories/h1");
    page.send({ type: "submit", conversationId: c.id, text: "DELETE_H1" });
    const confirm = await until(
      () =>
        page.received.find((m): m is Extract<ToPage, { type: "confirm" }> => m.type === "confirm"),
      "the confirm",
    );
    expect(confirm.title).toBe("Confirm destructive Galaxy operation");
    page.close();

    const back = new Page(cookie);
    await back.opened;
    back.send({ type: "open", conversationId: c.id });
    const shown = await until(
      () =>
        back.received.find((m): m is Extract<ToPage, { type: "confirm" }> => m.type === "confirm"),
      "the confirm, again",
    );
    expect(shown.id).toBe(confirm.id);
    back.send({ type: "confirmed", conversationId: c.id, id: shown.id, approved: true });
    await until(() => standIn.galaxyCalls("PUT", "/api/histories/h1") === puts + 1, "the delete");
    back.close();
  });

  it("takes a confirm's first answer from either of two pages, and closes the other page's dialog", async () => {
    const { sub, cookie } = await signedIn();
    const c = await createConversation(pool, sub);
    const one = new Page(cookie);
    const two = new Page(cookie);
    await Promise.all([one.opened, two.opened]);
    one.send({ type: "open", conversationId: c.id });
    two.send({ type: "open", conversationId: c.id });
    await until(() => two.received.some((m) => m.type === "ready"), "the second page");
    const puts = standIn.galaxyCalls("PUT", "/api/histories/h1");
    one.send({ type: "submit", conversationId: c.id, text: "DELETE_H1" });
    const confirmOf = (page: Page) => page.received.find((m): m is Extract<ToPage, { type: "confirm" }> => m.type === "confirm");
    const asked = await until(() => confirmOf(one), "the confirm");
    await until(() => confirmOf(two), "the confirm on the other page");
    one.send({ type: "confirmed", conversationId: c.id, id: asked.id, approved: true });
    await until(
      () => two.received.some((m) => m.type === "withdrawn" && m.id === asked.id),
      "the other page's dialog to close",
    );
    expect(one.received.some((m) => m.type === "withdrawn")).toBe(false);
    two.send({ type: "confirmed", conversationId: c.id, id: asked.id, approved: false });
    await until(() => standIn.galaxyCalls("PUT", "/api/histories/h1") === puts + 1, "the delete");
    one.close();
    two.close();
  });

  it("turns every message away with the kill switch's notice", async () => {
    const { sub, cookie } = await signedIn();
    const c = await createConversation(pool, sub);
    const page = new Page(cookie);
    await page.opened;
    killSwitch = "Orbit is paused for maintenance.";
    try {
      page.send({ type: "submit", conversationId: c.id, text: "while paused" });
      // failed, which takes the shell out of its busy state, rather than a notice that would leave it there.
      const refused = await until(
        () => page.received.find((m) => m.type === "failed"),
        "the refusal",
      );
      expect(refused).toEqual({ type: "failed", message: "Orbit is paused for maintenance." });
      expect(modelSaw("while paused")).toBe(0);
    } finally {
      killSwitch = undefined;
      page.close();
    }
  });
});

describe("two users side by side", () => {
  it("share no stream, Galaxy request, token or page", async () => {
    const alice = await signedIn();
    const bob = await signedIn();
    const theirs = new Map<string, string>();
    const pages = await Promise.all(
      [alice, bob].map(async (who) => {
        const conversation = await createConversation(pool, who.sub);
        theirs.set(conversation.id, who.sub);
        const page = new Page(who.cookie);
        await page.opened;
        page.send({ type: "open", conversationId: conversation.id });
        return {
          who,
          conversation,
          page,
          history: `h${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        };
      }),
    );
    const from = standIn.seen.length;
    // At the same time, each reading a history of their own.
    for (const { page, conversation, history } of pages) {
      page.send({
        type: "submit",
        conversationId: conversation.id,
        text: `READ_HISTORY ${history}`,
      });
    }
    for (const { page, history } of pages) {
      await until(
        () => standIn.galaxyCalls("GET", `/api/histories/${history}`) > 0,
        `${history} to be read`,
      );
      await until(() => page.events().some((e) => e.type === "run_end"), "the run to end");
    }
    const [a, b] = pages as [(typeof pages)[0], (typeof pages)[0]];
    // Each page saw its own conversation and nothing of the other's.
    expect(JSON.stringify(a.page.events())).toContain(a.history);
    expect(JSON.stringify(a.page.events())).not.toContain(b.history);
    expect(JSON.stringify(b.page.events())).toContain(b.history);
    expect(JSON.stringify(b.page.events())).not.toContain(a.history);
    // Every Galaxy request about one user's history or page went out as that user.
    const galaxy = standIn.seen.slice(from).filter((s) => s.to === "galaxy");
    for (const request of galaxy) {
      const owner = request.path.endsWith(a.history)
        ? alice.sub
        : request.path.endsWith(b.history)
          ? bob.sub
          : undefined;
      const page = /page-([0-9a-f-]{36})/.exec(request.path)?.[1];
      const expected = owner ?? (page ? theirs.get(page) : undefined);
      if (expected) expect(request.authorization).toBe(`Bearer token-${expected}`);
      expect([`Bearer token-${alice.sub}`, `Bearer token-${bob.sub}`]).toContain(
        request.authorization,
      );
    }
    expect(galaxy.filter((s) => s.path.endsWith(a.history)).length).toBeGreaterThan(0);
    // Separate pages, and no Galaxy token ever reached the model.
    const rows = await pool.query<{ page_id: string }>(
      "SELECT page_id FROM orbit_conversations WHERE id = ANY($1)",
      [pages.map((p) => p.conversation.id)],
    );
    expect(new Set(rows.rows.map((r) => r.page_id)).size).toBe(2);
    const toModel = standIn.seen.slice(from).filter((s) => s.to === "model");
    for (const request of toModel) expect(request.body).not.toContain("token-");
    a.page.close();
    b.page.close();
  });
});

describe("the HTTP API", () => {
  it("lists and creates the user's own conversations, and refuses a cross-site create", async () => {
    const { sub, cookie } = await signedIn();
    const mine = await createConversation(pool, sub);
    await createConversation(pool, (await signedIn()).sub);
    const list = (await (
      await fetch(`${origin}/api/conversations`, { headers: { cookie } })
    ).json()) as Array<{ id: string }>;
    expect(list.map((c) => c.id)).toEqual([mine.id]);
    const refused = await fetch(`${origin}/api/conversations`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.test" },
    });
    expect(refused.status).toBe(403);
    const created = await fetch(`${origin}/api/conversations`, {
      method: "POST",
      headers: { cookie, origin },
    });
    expect(created.status).toBe(201);
    expect((await fetch(`${origin}/api/conversations`)).status).toBe(401);
  });
});
