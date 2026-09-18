import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { galaxyGetMostRecentHistory } from "./galaxy-api.js";

describe("galaxyGetMostRecentHistory", () => {
  const origFetch = global.fetch;
  beforeEach(() => {
    process.env.GALAXY_URL = "https://g.example";
    process.env.GALAXY_API_KEY = "k";
  });
  afterEach(() => {
    global.fetch = origFetch;
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
    vi.restoreAllMocks();
  });

  it("calls most_recently_used with the api key and returns the history", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ id: "h1", name: "My History" }) });
    global.fetch = fetchMock as unknown as typeof fetch;
    const h = await galaxyGetMostRecentHistory();
    expect(h?.id).toBe("h1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://g.example/api/histories/most_recently_used",
      expect.objectContaining({ headers: { "x-api-key": "k" } }),
    );
  });

  it("returns null when Galaxy returns an empty body", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => null }) as unknown as typeof fetch;
    expect(await galaxyGetMostRecentHistory()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Redirects. Two real servers, because the thing being tested is what undici
// does with a credential header on a hop the mock layer never models.
// ---------------------------------------------------------------------------

import http from "node:http";
import type { AddressInfo } from "node:net";
import { galaxyGet, galaxyPost } from "./galaxy-api.js";

describe("galaxy API redirect handling", () => {
  const KEY = "SEKRET-CANARY-123";
  let target: http.Server;
  let configured: http.Server;
  let targetOrigin: string;
  let configuredOrigin: string;
  let keysSeenByTarget: (string | null)[] = [];
  let keysSeenByConfigured: (string | null)[] = [];
  let mode: "cross" | "same" | "plain" = "cross";

  beforeAll(async () => {
    target = http.createServer((req, res) => {
      keysSeenByTarget.push((req.headers["x-api-key"] as string | undefined) ?? null);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "leaked" }));
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    targetOrigin = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;

    configured = http.createServer((req, res) => {
      keysSeenByConfigured.push((req.headers["x-api-key"] as string | undefined) ?? null);
      if (mode === "plain" || req.url?.endsWith("/settled")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "h1" }));
        return;
      }
      const location =
        mode === "cross" ? `${targetOrigin}${req.url}` : `${configuredOrigin}/api/settled`;
      res.writeHead(302, { location });
      res.end();
    });
    await new Promise<void>((r) => configured.listen(0, "127.0.0.1", r));
    configuredOrigin = `http://127.0.0.1:${(configured.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => target.close(() => r()));
    await new Promise<void>((r) => configured.close(() => r()));
  });

  beforeEach(() => {
    keysSeenByTarget = [];
    keysSeenByConfigured = [];
    process.env.GALAXY_URL = configuredOrigin;
    process.env.GALAXY_API_KEY = KEY;
  });

  afterEach(() => {
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
  });

  it("does not hand the API key to a host the configured server redirects to", async () => {
    mode = "cross";
    const err = await galaxyGet("/histories/most_recently_used").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("GALAXY_URL");
    expect((err as Error).message).toContain(targetOrigin);
    expect(keysSeenByTarget).toEqual([]);
  });

  it("does not hand the key over on a POST either, nor replay the body", async () => {
    mode = "cross";
    const err = await galaxyPost("/tools/fetch", { history_id: "h1" }).catch((e: Error) => e);
    expect((err as Error).message).toContain(targetOrigin);
    expect(keysSeenByTarget).toEqual([]);
  });

  it("still follows a redirect that stays on the configured server", async () => {
    mode = "same";
    await expect(galaxyGet("/histories/most_recently_used")).resolves.toEqual({ id: "h1" });
    // Both hops went to the configured server, both carrying the key.
    expect(keysSeenByConfigured).toEqual([KEY, KEY]);
    expect(keysSeenByTarget).toEqual([]);
  });
});
