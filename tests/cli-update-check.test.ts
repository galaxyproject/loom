import { describe, it, expect } from "vitest";
import { parseCache, noticeFor, fetchOrbitLatest } from "../bin/update-check.js";

describe("parseCache", () => {
  const now = 1_000_000_000_000;
  it("returns a fresh success entry", () => {
    const raw = JSON.stringify({ fetchedAt: now - 1000, latest: "0.3.0", channel: "latest" });
    expect(parseCache(raw, now)).toEqual({
      fetchedAt: now - 1000,
      latest: "0.3.0",
      channel: "latest",
    });
  });
  it("drops a success entry past the 24h TTL", () => {
    const raw = JSON.stringify({
      fetchedAt: now - 25 * 3600_000,
      latest: "0.3.0",
      channel: "latest",
    });
    expect(parseCache(raw, now)).toBeNull();
  });
  it("drops a failure entry past the 1h TTL but keeps a fresh one", () => {
    const fresh = JSON.stringify({ fetchedAt: now - 1000, failed: true });
    expect(parseCache(fresh, now)).toEqual({ fetchedAt: now - 1000, failed: true });
    const stale = JSON.stringify({ fetchedAt: now - 2 * 3600_000, failed: true });
    expect(parseCache(stale, now)).toBeNull();
  });
  it("keeps an entry exactly at the TTL boundary and drops it 1ms past", () => {
    const atBoundary = JSON.stringify({
      fetchedAt: now - 24 * 3600_000,
      latest: "0.3.0",
      channel: "latest",
    });
    expect(parseCache(atBoundary, now)).not.toBeNull();
    const justPast = JSON.stringify({
      fetchedAt: now - 24 * 3600_000 - 1,
      latest: "0.3.0",
      channel: "latest",
    });
    expect(parseCache(justPast, now)).toBeNull();
  });
  it("returns null for garbage", () => {
    expect(parseCache("{not json", now)).toBeNull();
    expect(parseCache(JSON.stringify({ nope: 1 }), now)).toBeNull();
  });
});

describe("noticeFor", () => {
  it("returns a message when the cached version is newer", () => {
    const cache = { fetchedAt: 1, latest: "0.3.0", channel: "latest" };
    const msg = noticeFor("0.2.0", cache);
    expect(msg).toContain("0.3.0");
    expect(msg).toContain("0.2.0");
    expect(msg).toContain("npm i -g @galaxyproject/loom@latest");
  });
  it("uses the cached channel in the install hint", () => {
    const cache = { fetchedAt: 1, latest: "0.3.0-alpha.5", channel: "alpha" };
    expect(noticeFor("0.3.0-alpha.4", cache)).toContain("@galaxyproject/loom@alpha");
  });
  it("returns null when up to date, ahead of cache, on failure, or no cache", () => {
    expect(noticeFor("0.3.0", { fetchedAt: 1, latest: "0.3.0", channel: "latest" })).toBeNull();
    expect(noticeFor("0.4.0", { fetchedAt: 1, latest: "0.3.0", channel: "latest" })).toBeNull();
    expect(noticeFor("0.2.0", { fetchedAt: 1, failed: true })).toBeNull();
    expect(noticeFor("0.2.0", null)).toBeNull();
  });
});

describe("Loom is now Orbit notice", () => {
  const MOVED = "Loom is now Orbit -- `npm i -g @galaxyproject/orbit`";
  const base = { fetchedAt: 1, latest: "0.8.0", channel: "latest" };

  it("replaces the update notice once @galaxyproject/orbit has a real release", () => {
    expect(noticeFor("0.8.0", { ...base, orbitLatest: "0.9.0" })).toBe(MOVED);
    expect(noticeFor("0.7.0", { ...base, orbitLatest: "0.9.0" })).toBe(MOVED);
  });

  it("stays quiet for the 0.0.0 placeholder or no orbit release", () => {
    expect(noticeFor("0.8.0", { ...base, orbitLatest: "0.0.0" })).toBeNull();
    expect(noticeFor("0.8.0", base)).toBeNull();
    expect(noticeFor("0.7.0", { ...base, orbitLatest: "0.0.0" })).toContain("loom 0.8.0");
  });

  it("round-trips orbitLatest through the cache and drops a non-string one", () => {
    const now = 1_000_000;
    const raw = JSON.stringify({
      fetchedAt: now,
      latest: "0.8.0",
      channel: "latest",
      orbitLatest: "0.9.0",
    });
    expect(parseCache(raw, now)).toMatchObject({ orbitLatest: "0.9.0" });
    const bad = JSON.stringify({
      fetchedAt: now,
      latest: "0.8.0",
      channel: "latest",
      orbitLatest: 9,
    });
    expect(parseCache(bad, now)).not.toHaveProperty("orbitLatest");
  });
});

describe("fetchOrbitLatest", () => {
  type Reply = { status: number; body?: unknown; badJson?: boolean } | "offline";
  const fake = (reply: Reply) =>
    (async () => {
      if (reply === "offline") throw new TypeError("fetch failed");
      return {
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        json: async () => {
          if (reply.badJson) throw new SyntaxError("bad json");
          return reply.body;
        },
      };
    }) as unknown as typeof fetch;

  it("returns the latest dist-tag when published", async () => {
    expect(
      await fetchOrbitLatest(fake({ status: 200, body: { "dist-tags": { latest: "0.9.0" } } })),
    ).toBe("0.9.0");
  });

  it("returns the placeholder as-is (noticeFor decides it isn't a move)", async () => {
    expect(
      await fetchOrbitLatest(fake({ status: 200, body: { "dist-tags": { latest: "0.0.0" } } })),
    ).toBe("0.0.0");
  });

  it("returns null when unpublished, offline, rate-limited, erroring, or malformed", async () => {
    for (const reply of [
      { status: 404, body: { error: "Not found" } },
      "offline" as const,
      { status: 403, body: {} },
      { status: 429, body: {} },
      { status: 503, body: {} },
      { status: 200, badJson: true },
      { status: 200, body: { "dist-tags": {} } },
      { status: 200, body: null },
    ]) {
      expect(await fetchOrbitLatest(fake(reply))).toBeNull();
    }
  });
});
