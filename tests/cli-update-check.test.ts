import { describe, it, expect } from "vitest";
import { parseCache, noticeFor } from "../bin/update-check.js";

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
