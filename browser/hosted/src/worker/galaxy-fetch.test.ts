import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { serviceOutageIn } from "../../../../shared/service-outage.js";
import { migrate } from "../db/migrate";
import { LeaseFence } from "../lease/lease-fence";
import { acquireLease } from "../lease/leases";
import { bumpLeaseGen, LeaseLostError } from "../storage/postgres-storage";
import { ensureDatabase, testDatabase } from "../test-db";
import { answerTokenRequest } from "../tokens/serve";
import { createTokenCache } from "../tokens/token-cache";
import { hostedGalaxyFetch, TokenUnavailable, type TokenFailure } from "./galaxy-fetch";

const GALAXY = "https://galaxy.test";

let pool: pg.Pool;

beforeAll(async () => {
  pool = new pg.Pool({ ...(await ensureDatabase(testDatabase("orbit_hosted_galaxy_fetch"))), max: 4 });
  await migrate(pool);
});

afterAll(async () => {
  await pool?.end();
});

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  redirect: RequestRedirect | undefined;
}

async function setup(options: { token?: () => Promise<string>; answer?: (url: string) => Response } = {}) {
  const storeId = `gfetch-${randomUUID()}`;
  const leaseGen = (await acquireLease(pool, storeId, "worker-a", 60_000))!;
  const lost: LeaseLostError[] = [];
  const fence = new LeaseFence({ storeId, leaseGen, db: pool, onLost: (e) => lost.push(e) });
  const sent: Sent[] = [];
  const network = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
    });
    return options.answer?.(String(input)) ?? Response.json({ ok: true });
  }) as typeof fetch;
  const galaxy = hostedGalaxyFetch({ fence, network, token: options.token ?? (async () => "access-token") });
  return { storeId, fetch: galaxy, sent, lost };
}

describe("the hosted Galaxy fetch", () => {
  it("sends the user's token instead of the API key, from a plain object or a Headers", async () => {
    const { fetch, sent } = await setup();
    await fetch(`${GALAXY}/api/histories`, { headers: { "x-api-key": "hosted", accept: "application/json" } });
    await fetch(`${GALAXY}/api/histories`, { headers: new Headers({ "x-api-key": "hosted" }) });
    for (const request of sent) {
      expect(request.headers.get("authorization")).toBe("Bearer access-token");
      expect(request.headers.has("x-api-key")).toBe(false);
    }
    expect(sent[0]!.headers.get("accept")).toBe("application/json");
    // Through the redirect guard, which asks for manual redirects so it can check each hop.
    expect(sent[0]!.redirect).toBe("manual");
  });

  it("refuses a redirect to another origin, so the token never goes there", async () => {
    const { fetch, sent } = await setup({
      answer: (url) =>
        url.startsWith(GALAXY) ? new Response(null, { status: 302, headers: { location: "https://evil.test/x" } }) : Response.json({}),
    });
    await expect(fetch(`${GALAXY}/api/histories`, {})).rejects.toMatchObject({ name: "RedirectRefusedError" });
    expect(sent.map((s) => s.url)).toEqual([`${GALAXY}/api/histories`]);
  });

  it("on a stale lease, still reads but refuses a write", async () => {
    const { storeId, fetch, sent, lost } = await setup();
    await bumpLeaseGen(pool, storeId);
    await fetch(`${GALAXY}/api/histories/h1`, { method: "GET" });
    await expect(fetch(`${GALAXY}/api/histories/h1`, { method: "PUT", body: "{}" })).rejects.toBeInstanceOf(LeaseLostError);
    expect(lost).toHaveLength(1);
    expect(sent.map((s) => s.method)).toEqual(["GET"]);
  });

  it("turns a sign-in outage into a ServiceOutageError, never a 401", async () => {
    const failure: TokenFailure = { kind: "outage", message: "The sign-in service couldn't be reached." };
    const { fetch, sent } = await setup({
      token: async () => {
        throw new TokenUnavailable(failure);
      },
    });
    const error = await fetch(`${GALAXY}/api/histories`, {}).catch((e: unknown) => e);
    expect(serviceOutageIn(error)?.message).toBe(failure.message);
    expect(sent).toEqual([]);
  });

  it("answers an ended session as Galaxy refusing the credential, without asking Galaxy", async () => {
    const { fetch, sent } = await setup({
      token: async () => {
        throw new TokenUnavailable({ kind: "auth", message: "Your sign-in has ended; sign in again." });
      },
    });
    const response = await fetch(`${GALAXY}/api/histories`, {});
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ err_msg: "Your sign-in has ended; sign in again." });
    expect(sent).toEqual([]);
  });
});

describe("the token cache", () => {
  it("shares one refresh among concurrent requests, and reuses the token until near expiry", async () => {
    let clock = 0;
    let refreshes = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const cache = createTokenCache({
      now: () => clock,
      skewMs: 10,
      refresh: async () => {
        refreshes += 1;
        await gate;
        return { token: `t${refreshes}`, expiresAt: clock + 100 };
      },
    });
    const all = Promise.all([cache.token("u"), cache.token("u"), cache.token("u")]);
    release();
    expect(await all).toEqual(["t1", "t1", "t1"]);
    clock = 80;
    expect(await cache.token("u")).toBe("t1");
    clock = 95;
    expect(await cache.token("u")).toBe("t2");
    expect(refreshes).toBe(2);
  });

  it("doesn't keep a failed refresh, and a sign-out beats a refresh in flight", async () => {
    let fail = true;
    let refreshes = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const cache = createTokenCache({
      refresh: async () => {
        refreshes += 1;
        if (fail) throw new TokenUnavailable({ kind: "outage", message: "down" });
        await gate;
        return { token: `fresh${refreshes}`, expiresAt: Date.now() + 60_000 };
      },
    });
    await expect(cache.token("u")).rejects.toBeInstanceOf(TokenUnavailable);
    fail = false;
    const inFlight = cache.token("u");
    cache.forget("u");
    release();
    // Asked before the sign-out, answered after it: the caller doesn't get the ended session's token.
    await expect(inFlight).rejects.toBeInstanceOf(TokenUnavailable);
    // Nor is it kept: the next ask refreshes.
    expect(await cache.token("u")).toBe("fresh3");
    expect(refreshes).toBe(3);
  });
});

describe("answering a worker's token request", () => {
  const cache = createTokenCache({ refresh: async () => ({ token: "access", expiresAt: Date.now() + 60_000 }) });

  it("hands the token to the worker holding the current generation", async () => {
    const storeId = `serve-${randomUUID()}`;
    const leaseGen = (await acquireLease(pool, storeId, "worker-a", 60_000))!;
    expect(await answerTokenRequest({ sub: "u", storeId, leaseGen, db: pool, tokens: cache })).toEqual({ token: "access" });
  });

  it("never hands one to a worker whose lease moved on", async () => {
    const storeId = `serve-${randomUUID()}`;
    const leaseGen = (await acquireLease(pool, storeId, "worker-a", 60_000))!;
    await bumpLeaseGen(pool, storeId);
    expect(await answerTokenRequest({ sub: "u", storeId, leaseGen, db: pool, tokens: cache })).toMatchObject({
      failure: { kind: "lease" },
    });
  });

  it("reports a refresh that broke unexpectedly as an outage, not an ended session", async () => {
    const storeId = `serve-${randomUUID()}`;
    const leaseGen = (await acquireLease(pool, storeId, "worker-a", 60_000))!;
    const broken = createTokenCache({
      refresh: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(await answerTokenRequest({ sub: "u", storeId, leaseGen, db: pool, tokens: broken })).toEqual({
      failure: { kind: "outage", message: "The sign-in service couldn't be reached." },
    });
  });
});
