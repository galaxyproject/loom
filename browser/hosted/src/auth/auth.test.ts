import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../db/migrate";
import { freshDatabase, testDatabase } from "../test-db";
import { createTokenCache } from "../tokens/token-cache";
import { TokenUnavailable } from "../worker/galaxy-fetch";
import { startMockOidc, type MockOidc } from "./mock-oidc";
import { connectOidc, type Oidc } from "./oidc";
import { handleAuth, SESSION_COOKIE, type AuthContext } from "./routes";
import { findSession, hashSessionId, refreshForUser } from "./sessions";

const KEY = Buffer.alloc(32, 9);

let pool: pg.Pool;
let keycloak: MockOidc;
let oidc: Oidc;
let server: Server;
let base: URL;
/** What the stand-in Galaxy says about whoever asks. */
let galaxyAnswer: () => Response;
const KNOWN = () => Response.json({ id: "galaxy-user-1" });
// Galaxy's own words for a decoded token with no account behind it.
const UNMAPPED = () =>
  Response.json(
    {
      err_msg: "Cannot locate user by access token. The user should log into Galaxy at least once with this OIDC provider.",
      err_code: 401001,
    },
    { status: 401 },
  );

beforeAll(async () => {
  pool = new pg.Pool({ ...(await freshDatabase(testDatabase("orbit_hosted_auth"))), max: 6 });
  await migrate(pool);
  keycloak = await startMockOidc({ clientSecret: "s3cret" });
  oidc = await connectOidc({ issuer: keycloak.issuer, clientId: "orbit", clientSecret: "s3cret", allowHttp: true });
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const context: AuthContext = {
    pool,
    oidc,
    tokens: createTokenCache({ refresh: refreshForUser(pool, KEY, oidc) }),
    tokenKey: KEY,
    publicUrl: base,
    galaxyUrl: new URL("https://galaxy.test"),
    galaxyLinkUrl: new URL("https://galaxy.test/login/start"),
    fetch: (async () => galaxyAnswer()) as typeof fetch,
  };
  server.on("request", (req, res) => {
    handleAuth(context, req, res).then(
      (handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      },
      () => {
        res.writeHead(500);
        res.end();
      },
    );
  });
});

afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await keycloak?.close();
  await pool?.end();
});

beforeEach(() => {
  galaxyAnswer = KNOWN;
  keycloak.down = false;
});

/** A browser: follows nothing on its own, keeps cookies by name. */
class Browser {
  cookies = new Map<string, string>();
  async go(url: string | URL, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";").map((p) => p.trim());
      const [name, ...value] = pair!.split("=");
      if (attrs.some((a) => a === "Max-Age=0")) this.cookies.delete(name!);
      else this.cookies.set(name!, value.join("="));
    }
    return response;
  }
  /** Sign in as `user` and land wherever the host sends the browser. */
  async signIn(user: string, back = "/"): Promise<Response> {
    keycloak.user = user;
    const login = await this.go(new URL(`/auth/login?return=${encodeURIComponent(back)}`, base));
    const authorize = await this.go(login.headers.get("location")!);
    return this.go(authorize.headers.get("location")!);
  }
}

const sessionRows = async (sub: string) =>
  (await pool.query<{ refresh_token: Buffer }>("SELECT refresh_token FROM orbit_sessions WHERE user_sub = $1", [sub])).rows;

describe("Keycloak sign-in", () => {
  it("runs the code flow with PKCE and leaves only an HttpOnly session cookie in the browser", async () => {
    const browser = new Browser();
    keycloak.user = "alice";
    const login = await browser.go(new URL("/auth/login?return=/c/42", base));
    expect(login.status).toBe(302);
    const authorize = new URL(login.headers.get("location")!);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("redirect_uri")).toBe(new URL("/auth/callback", base).href);
    const callback = await browser.go(authorize);
    const landed = await browser.go(callback.headers.get("location")!);
    expect(landed.status).toBe(302);
    expect(landed.headers.get("location")).toBe("/c/42");
    const setCookie = landed.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect([...browser.cookies.keys()]).toEqual([SESSION_COOKIE]);
    expect(await (await browser.go(new URL("/auth/me", base))).json()).toEqual({ sub: "alice" });
    const galaxy = await pool.query("SELECT galaxy_user_id FROM orbit_users WHERE sub = 'alice'");
    expect(galaxy.rows[0]).toEqual({ galaxy_user_id: "galaxy-user-1" });
  });

  it("refuses a callback without the browser's own sign-in state, and an off-site return", async () => {
    const browser = new Browser();
    keycloak.user = "mallory";
    const login = await browser.go(new URL("/auth/login?return=//evil.test/x", base));
    const callback = new URL((await browser.go(login.headers.get("location")!)).headers.get("location")!);
    const stranger = new Browser();
    expect((await stranger.go(callback)).status).toBe(400);
    const landed = await browser.go(callback);
    expect(landed.headers.get("location")).toBe("/");
  });

  it("sends a user Galaxy doesn't know yet to link their account once", async () => {
    galaxyAnswer = UNMAPPED;
    const browser = new Browser();
    const landed = await browser.signIn("bob");
    expect(landed.headers.get("location")).toBe("/auth/link");
    const page = await (await browser.go(new URL("/auth/link", base))).text();
    expect(page).toContain("https://galaxy.test/login/start");
  });

  it("lets the user in when Galaxy fails some other way, rather than sending them to link", async () => {
    const failures: Array<[string, () => Response]> = [
      ["an invalid-token 401", () => Response.json({ err_msg: "Invalid access token.", err_code: 401001 }, { status: 401 })],
      ["a 401 that isn't Galaxy's JSON", () => new Response("Unauthorized", { status: 401 })],
      ["a 403", () => Response.json({ err_msg: "forbidden" }, { status: 403 })],
      ["a crash", () => new Response("Internal Server Error", { status: 500 })],
      ["an outage", () => new Response("Bad Gateway", { status: 502 })],
      ["an anonymous answer", () => Response.json({})],
      [
        "an unreachable Galaxy",
        () => {
          throw new TypeError("fetch failed");
        },
      ],
    ];
    for (const [what, answer] of failures) {
      galaxyAnswer = answer;
      const landed = await new Browser().signIn("carol");
      expect(landed.headers.get("location"), what).toBe("/");
    }
  });

  it("keeps the refresh token sealed at rest", async () => {
    await new Browser().signIn("carol");
    const [row] = await sessionRows("carol");
    expect(row!.refresh_token.length).toBeGreaterThan(28);
    // Keycloak's refresh tokens are base64url; nothing like one sits in the row in the clear.
    expect(row!.refresh_token.toString("latin1")).not.toMatch(/[A-Za-z0-9_-]{32}/);
  });
});

describe("hostile input", () => {
  it("ignores a cookie that isn't valid percent-encoding, and a return that would break the header", async () => {
    const bad = await fetch(new URL("/auth/me", base), { headers: { cookie: `${SESSION_COOKIE}=%E0` } });
    expect(bad.status).toBe(401);
    const browser = new Browser();
    const landed = await browser.signIn("henry", "/x\nSet-Cookie:evil=1");
    expect(landed.status).toBe(302);
    expect(landed.headers.get("location")).toBe("/");
  });

  it("refuses an expired sign-in state", async () => {
    const browser = new Browser();
    keycloak.user = "ivy";
    const login = await browser.go(new URL("/auth/login", base));
    const callback = (await browser.go(login.headers.get("location")!)).headers.get("location")!;
    const later = Date.now() + 11 * 60_000;
    const realNow = Date.now;
    Date.now = () => later;
    try {
      expect((await browser.go(callback)).status).toBe(400);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("refresh", () => {
  it("rotates the refresh token, and two refreshes at once take turns instead of spending one token twice", async () => {
    await new Browser().signIn("dave");
    const refresh = refreshForUser(pool, KEY, oidc);
    const [before] = await sessionRows("dave");
    const both = await Promise.all([refresh("dave"), refresh("dave")]);
    expect(both.map((t) => typeof t.token)).toEqual(["string", "string"]);
    const [after] = await sessionRows("dave");
    expect(after!.refresh_token.equals(before!.refresh_token)).toBe(false);
  });

  it("refreshes the session the user last used, not the newest, so an older browser in use stays signed in", async () => {
    const laptop = new Browser();
    await laptop.signIn("dora");
    await new Browser().signIn("dora");
    const laptopId = laptop.cookies.get(SESSION_COOKIE)!;
    const refreshTokenOf = async (id: string) =>
      (await pool.query<{ refresh_token: Buffer }>("SELECT refresh_token FROM orbit_sessions WHERE id_hash = $1", [hashSessionId(id)]))
        .rows[0]!.refresh_token;
    const before = await refreshTokenOf(laptopId);
    expect(await findSession(pool, laptopId)).toMatchObject({ sub: "dora" });
    await refreshForUser(pool, KEY, oidc)("dora");
    expect((await refreshTokenOf(laptopId)).equals(before)).toBe(false);
  });

  it("still finds a session at once while a refresh has its row locked", async () => {
    const browser = new Browser();
    await browser.signIn("dora");
    const id = browser.cookies.get(SESSION_COOKIE)!;
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM orbit_sessions WHERE id_hash = $1 FOR UPDATE", [hashSessionId(id)]);
      expect(await findSession(pool, id)).toMatchObject({ sub: "dora" });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });

  it("ends the session when Keycloak revoked it, as auth", async () => {
    await new Browser().signIn("erin");
    keycloak.revokeUser("erin");
    const error = await refreshForUser(pool, KEY, oidc)("erin").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokenUnavailable);
    expect((error as TokenUnavailable).failure.kind).toBe("auth");
    expect(await sessionRows("erin")).toEqual([]);
  });

  it("keeps the session through a Keycloak outage, as outage", async () => {
    await new Browser().signIn("frank");
    keycloak.down = true;
    const error = await refreshForUser(pool, KEY, oidc)("frank").catch((e: unknown) => e);
    expect((error as TokenUnavailable).failure.kind).toBe("outage");
    expect(await sessionRows("frank")).toHaveLength(1);
    keycloak.down = false;
    expect(typeof (await refreshForUser(pool, KEY, oidc)("frank")).token).toBe("string");
  });
});

describe("sign-out", () => {
  it("only from Orbit itself; then revokes at Keycloak, deletes the session and clears the cookie", async () => {
    const browser = new Browser();
    await browser.signIn("gina");
    expect((await browser.go(new URL("/auth/logout", base), { method: "POST" })).status).toBe(403);
    const out = await browser.go(new URL("/auth/logout", base), { method: "POST", headers: { origin: base.origin } });
    expect(out.status).toBe(303);
    expect(new URL(out.headers.get("location")!).pathname).toBe("/realms/test/logout");
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
    expect(await sessionRows("gina")).toEqual([]);
    expect((await browser.go(new URL("/auth/me", base))).status).toBe(401);
  });
});
