import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchSameOriginOnly, originOf, RedirectRefusedError } from "../shared/redirect-guard.js";

const KEY = "SEKRET-CANARY-123";

interface Seen {
  url: string;
  method: string;
  key: string | null;
  body: string;
  contentType: string | null;
  contentLength: string | null;
}

/**
 * A throwaway HTTP server that records every request it sees. Ports are
 * ephemeral so parallel runs never collide.
 */
async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen[]) => void,
): Promise<{ origin: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        url: req.url ?? "",
        method: req.method ?? "",
        key: (req.headers["x-api-key"] as string | undefined) ?? null,
        body: Buffer.concat(chunks).toString("utf8"),
        contentType: req.headers["content-type"] ?? null,
        contentLength: req.headers["content-length"] ?? null,
      });
      handler(req, res, seen);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function ok(res: http.ServerResponse) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

describe("originOf", () => {
  it("reduces a URL to scheme, host and port, dropping path, query and userinfo", () => {
    expect(originOf("https://galaxy.example/api/histories?key=abc")).toBe("https://galaxy.example");
    expect(originOf("http://user:pw@galaxy.example:8080/x")).toBe("http://galaxy.example:8080");
    expect(originOf("not a url")).toBeNull();
  });
});

describe("fetchSameOriginOnly against real servers", () => {
  let a: Awaited<ReturnType<typeof startServer>>;
  let b: Awaited<ReturnType<typeof startServer>>;
  // The status server A answers with; each test sets it before calling.
  let redirectStatus = 302;
  let redirectTo: "b" | "a-same" | "loop" | "none" = "b";

  beforeAll(async () => {
    b = await startServer((_req, res) => ok(res));
    a = await startServer((req, res) => {
      if (redirectTo === "none" || req.url === "/final") return ok(res);
      const location =
        redirectTo === "b"
          ? `${b.origin}${req.url}`
          : redirectTo === "loop"
            ? `${a.origin}/loop`
            : `${a.origin}/final`;
      res.writeHead(redirectStatus, { location });
      res.end();
    });
  });

  afterAll(async () => {
    await a.close();
    await b.close();
  });

  function reset(status: number, to: typeof redirectTo) {
    redirectStatus = status;
    redirectTo = to;
    a.seen.length = 0;
    b.seen.length = 0;
  }

  for (const status of [301, 302, 303, 307, 308]) {
    it(`refuses a ${status} to another origin and sends it no key`, async () => {
      reset(status, "b");
      const err = await fetchSameOriginOnly(
        `${a.origin}/api/histories`,
        { headers: { "x-api-key": KEY } },
        { serverLabel: "Galaxy", urlSettingLabel: "GALAXY_URL" },
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(RedirectRefusedError);
      const refused = err as RedirectRefusedError;
      expect(refused.kind).toBe("cross-origin");
      expect(refused.status).toBe(status);
      expect(refused.toOrigin).toBe(b.origin);

      expect(a.seen).toHaveLength(1);
      expect(a.seen[0].key).toBe(KEY);
      // The whole point: the second host was never contacted at all.
      expect(b.seen).toHaveLength(0);
    });
  }

  it("names the status and the target origin, and nothing else", async () => {
    reset(302, "b");
    const err = (await fetchSameOriginOnly(
      `${a.origin}/api/histories/deadbeef?dataset_token=SHOULD-NOT-APPEAR`,
      { headers: { "x-api-key": KEY } },
      { serverLabel: "Galaxy", urlSettingLabel: "GALAXY_URL" },
    ).catch((e: unknown) => e)) as RedirectRefusedError;

    expect(err.message).toContain("HTTP 302");
    expect(err.message).toContain(b.origin);
    expect(err.message).toContain(a.origin);
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain("SHOULD-NOT-APPEAR");
    expect(err.message).not.toContain("deadbeef");
  });

  it("follows a same-origin redirect and delivers the key to that origin only", async () => {
    reset(302, "a-same");
    const res = await fetchSameOriginOnly(`${a.origin}/api/histories`, {
      headers: { "x-api-key": KEY },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(a.seen.map((s) => s.url)).toEqual(["/api/histories", "/final"]);
    expect(a.seen.every((s) => s.key === KEY)).toBe(true);
    expect(b.seen).toHaveLength(0);
  });

  it("gives up on a same-origin redirect loop instead of spinning", async () => {
    reset(302, "loop");
    const err = await fetchSameOriginOnly(`${a.origin}/api/histories`, {
      headers: { "x-api-key": KEY },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedirectRefusedError);
    expect((err as RedirectRefusedError).kind).toBe("too-many-hops");
    // Default limit is three hops, so four requests go out and then it stops.
    expect(a.seen).toHaveLength(4);
  });

  it("honours a smaller hop limit", async () => {
    reset(302, "loop");
    const err = await fetchSameOriginOnly(
      `${a.origin}/api/histories`,
      { headers: { "x-api-key": KEY } },
      { maxHops: 1 },
    ).catch((e: unknown) => e);
    expect((err as RedirectRefusedError).kind).toBe("too-many-hops");
    expect(a.seen).toHaveLength(2);
  });

  it("keeps the default hop limit when handed a non-integer one", async () => {
    reset(302, "loop");
    const err = await fetchSameOriginOnly(
      `${a.origin}/api/histories`,
      { headers: { "x-api-key": KEY } },
      { maxHops: Number.POSITIVE_INFINITY },
    ).catch((e: unknown) => e);
    expect((err as RedirectRefusedError).kind).toBe("too-many-hops");
    expect(a.seen).toHaveLength(4);
  });

  it("does not replay a POST body to another origin", async () => {
    reset(307, "b");
    const err = await fetchSameOriginOnly(
      `${a.origin}/api/tools/fetch`,
      {
        method: "POST",
        headers: { "x-api-key": KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ history_id: "h1" }),
      },
      { serverLabel: "Galaxy", urlSettingLabel: "GALAXY_URL" },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RedirectRefusedError);
    expect(a.seen[0].body).toContain("history_id");
    expect(b.seen).toHaveLength(0);
  });

  it("turns a POST into a bodiless GET on a same-origin 303, per fetch's own rules", async () => {
    reset(303, "a-same");
    const res = await fetchSameOriginOnly(`${a.origin}/api/tools/fetch`, {
      method: "POST",
      headers: { "x-api-key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ history_id: "h1" }),
    });
    expect(res.status).toBe(200);
    expect(a.seen[0].method).toBe("POST");
    expect(a.seen[1].method).toBe("GET");
    expect(a.seen[1].body).toBe("");
    expect(a.seen[1].key).toBe(KEY);
  });

  it("keeps method and body on a same-origin 308", async () => {
    reset(308, "a-same");
    const res = await fetchSameOriginOnly(`${a.origin}/api/tools/fetch`, {
      method: "POST",
      headers: { "x-api-key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ history_id: "h1" }),
    });
    expect(res.status).toBe(200);
    expect(a.seen[1].method).toBe("POST");
    expect(a.seen[1].body).toContain("history_id");
  });

  it("refuses a chain that turns cross-origin only on the last hop", async () => {
    // Two honest same-origin hops, then a jump. The guard compares every hop
    // against the origin the caller started from, not against the last one.
    reset(302, "none");
    let hops = 0;
    const chain = http.createServer((req, res) => {
      hops += 1;
      if (hops <= 2) {
        res.writeHead(302, { location: `${chainOrigin}/hop-${hops}` });
        res.end();
        return;
      }
      res.writeHead(302, { location: `${b.origin}${req.url}` });
      res.end();
    });
    await new Promise<void>((r) => chain.listen(0, "127.0.0.1", r));
    const chainOrigin = `http://127.0.0.1:${(chain.address() as AddressInfo).port}`;

    const err = await fetchSameOriginOnly(
      `${chainOrigin}/api/histories`,
      { headers: { "x-api-key": KEY } },
      { serverLabel: "Galaxy", urlSettingLabel: "GALAXY_URL" },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RedirectRefusedError);
    expect((err as RedirectRefusedError).kind).toBe("cross-origin");
    expect(hops).toBe(3);
    expect(b.seen).toHaveLength(0);
    await new Promise<void>((r) => chain.close(() => r()));
  });

  it("drops the body headers when a same-origin redirect turns a POST into a GET", async () => {
    reset(303, "a-same");
    await fetchSameOriginOnly(`${a.origin}/api/tools/fetch`, {
      method: "POST",
      headers: { "x-api-key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ history_id: "h1" }),
    });
    expect(a.seen[0].contentType).toBe("application/json");
    expect(a.seen[1].contentType).toBeNull();
    expect(a.seen[1].contentLength).toBeNull();
  });

  it("passes a non-redirect response straight through", async () => {
    reset(302, "none");
    const res = await fetchSameOriginOnly(`${a.origin}/api/histories`, {
      headers: { "x-api-key": KEY },
    });
    expect(res.status).toBe(200);
    expect(a.seen).toHaveLength(1);
  });
});

describe("fetchSameOriginOnly error wording", () => {
  function redirectOnce(location: string): typeof fetch {
    let served = false;
    return vi.fn(async () => {
      if (served) return new Response("{}", { status: 200 });
      served = true;
      return new Response(null, { status: 302, headers: { location } });
    }) as unknown as typeof fetch;
  }

  it("tells an http-configured user to switch their URL to https", async () => {
    const err = (await fetchSameOriginOnly(
      "http://galaxy.example/api/histories",
      { headers: { "x-api-key": KEY } },
      {
        fetchImpl: redirectOnce("https://galaxy.example/api/histories"),
        serverLabel: "Galaxy",
        urlSettingLabel: "GALAXY_URL",
      },
    ).catch((e: unknown) => e)) as RedirectRefusedError;

    expect(err.kind).toBe("cross-origin");
    expect(err.message).toContain("Set GALAXY_URL to https://galaxy.example");
  });

  it("points at a proxy or sign-in page when the host changes too", async () => {
    const err = (await fetchSameOriginOnly(
      "https://galaxy.example/api/histories",
      { headers: { "x-api-key": KEY } },
      {
        fetchImpl: redirectOnce("https://idp.example/saml/login?RelayState=abc"),
        serverLabel: "Galaxy",
        urlSettingLabel: "GALAXY_URL",
      },
    ).catch((e: unknown) => e)) as RedirectRefusedError;

    expect(err.toOrigin).toBe("https://idp.example");
    expect(err.message).toContain("proxy or a sign-in page");
    expect(err.message).not.toContain("RelayState");
  });

  it("refuses a Location it cannot resolve rather than guessing", async () => {
    const err = (await fetchSameOriginOnly(
      "https://galaxy.example/api/histories",
      { headers: { "x-api-key": KEY } },
      { fetchImpl: redirectOnce("http://[oops"), serverLabel: "Galaxy" },
    ).catch((e: unknown) => e)) as RedirectRefusedError;

    expect(err.kind).toBe("unparsable");
    expect(err.message).toContain("HTTP 302");
  });

  it("leaves a redirect status with no Location to the caller's own status handling", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302 }),
    ) as unknown as typeof fetch;
    const res = await fetchSameOriginOnly("https://galaxy.example/api/x", {}, { fetchImpl });
    expect(res.status).toBe(302);
  });

  it("passes a 304 through, since it is not a redirect", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 304 }),
    ) as unknown as typeof fetch;
    const res = await fetchSameOriginOnly("https://galaxy.example/api/x", {}, { fetchImpl });
    expect(res.status).toBe(304);
  });

  it("refuses a redirect whose headers it cannot read rather than passing it on", async () => {
    // The shape a hand-rolled test double takes: a status and a body, no headers.
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 307,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const err = (await fetchSameOriginOnly(
      "https://galaxy.example/api/x",
      { headers: { "x-api-key": KEY } },
      { fetchImpl, serverLabel: "Galaxy" },
    ).catch((e: unknown) => e)) as RedirectRefusedError;
    expect(err).toBeInstanceOf(RedirectRefusedError);
    expect(err.kind).toBe("unreadable");
  });

  it("strips userinfo off a same-origin Location instead of handing it to fetch", async () => {
    const calls: string[] = [];
    let served = false;
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (served) return new Response("{}", { status: 200 });
      served = true;
      return new Response(null, {
        status: 302,
        headers: { location: "https://user:pw@galaxy.example/final?token=SHOULD-NOT-APPEAR" },
      });
    }) as unknown as typeof fetch;

    const res = await fetchSameOriginOnly(
      "https://galaxy.example/api/x",
      { headers: { "x-api-key": KEY } },
      { fetchImpl },
    );
    expect(res.status).toBe(200);
    // Same origin, so it is followed -- but without the credentials, which
    // fetch refuses outright with a TypeError quoting the whole URL.
    expect(calls[1]).toBe("https://galaxy.example/final?token=SHOULD-NOT-APPEAR");
    expect(calls[1]).not.toContain("user:pw");
  });
});
