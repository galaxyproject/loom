import { describe, it, expect } from "vitest";
import { detectRepoMoved, forcedRepoMoved, type FetchLike } from "../app/src/main/repo-moved.js";

type Reply = { status: number; body?: unknown; badJson?: boolean } | "offline";

function mockFetch(routes: Record<string, Reply>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const r = routes[url.replace("https://api.github.com/repos/", "")];
    if (r === undefined || r === "offline") throw new TypeError("fetch failed");
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => {
        if (r.badJson) throw new SyntaxError("Unexpected token <");
        return r.body;
      },
    };
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const notFound = { status: 404, body: { message: "Not Found", documentation_url: "x" } };

describe("detectRepoMoved", () => {
  it("reports not-moved when GitHub still calls it galaxyproject/loom", async () => {
    const f = mockFetch({
      "galaxyproject/loom": { status: 200, body: { full_name: "galaxyproject/loom" } },
    });
    expect(await detectRepoMoved(f)).toEqual({ kind: "not-moved" });
    expect(f.calls).toHaveLength(1);
  });

  it("ignores a case-only difference in full_name", async () => {
    const f = mockFetch({
      "galaxyproject/loom": { status: 200, body: { full_name: "GalaxyProject/Loom" } },
    });
    expect(await detectRepoMoved(f)).toEqual({ kind: "not-moved" });
  });

  it("reports moved when the followed redirect returns a new full_name", async () => {
    const f = mockFetch({
      "galaxyproject/loom": { status: 200, body: { full_name: "galaxyproject/orbit" } },
      "galaxyproject/orbit/releases/latest": {
        status: 200,
        body: {
          tag_name: "v0.9.0",
          html_url: "https://github.com/galaxyproject/orbit/releases/tag/v0.9.0",
        },
      },
    });
    expect(await detectRepoMoved(f)).toEqual({
      kind: "moved",
      info: {
        fullName: "galaxyproject/orbit",
        latest: "v0.9.0",
        releaseUrl: "https://github.com/galaxyproject/orbit/releases/tag/v0.9.0",
      },
    });
  });

  it("falls back to the new repo's /releases/latest when the release lookup fails", async () => {
    const f = mockFetch({
      "galaxyproject/loom": { status: 200, body: { full_name: "galaxyproject/orbit" } },
      "galaxyproject/orbit/releases/latest": {
        status: 403,
        body: { message: "API rate limit exceeded" },
      },
    });
    expect(await detectRepoMoved(f)).toEqual({
      kind: "moved",
      info: {
        fullName: "galaxyproject/orbit",
        latest: null,
        releaseUrl: "https://github.com/galaxyproject/orbit/releases/latest",
      },
    });
  });

  it("ignores a release html_url that points outside the new repo", async () => {
    const f = mockFetch({
      "galaxyproject/loom": { status: 200, body: { full_name: "galaxyproject/orbit" } },
      "galaxyproject/orbit/releases/latest": {
        status: 200,
        body: { tag_name: "v0.9.0", html_url: "https://evil.example/x" },
      },
    });
    const out = await detectRepoMoved(f);
    expect(out.kind === "moved" && out.info.releaseUrl).toBe(
      "https://github.com/galaxyproject/orbit/releases/latest",
    );
  });

  it("treats a GitHub 404 as moved only when galaxyproject/orbit exists", async () => {
    const moved = mockFetch({
      "galaxyproject/loom": notFound,
      "galaxyproject/orbit": { status: 200, body: { full_name: "galaxyproject/orbit" } },
      "galaxyproject/orbit/releases/latest": notFound,
    });
    expect(await detectRepoMoved(moved)).toMatchObject({
      kind: "moved",
      info: { fullName: "galaxyproject/orbit" },
    });

    const gone = mockFetch({ "galaxyproject/loom": notFound, "galaxyproject/orbit": notFound });
    expect(await detectRepoMoved(gone)).toEqual({ kind: "unknown" });

    const flaky = mockFetch({ "galaxyproject/loom": notFound, "galaxyproject/orbit": "offline" });
    expect(await detectRepoMoved(flaky)).toEqual({ kind: "unknown" });
  });

  it("does not trust a 404 that isn't GitHub's JSON (captive portal, proxy)", async () => {
    const f = mockFetch({ "galaxyproject/loom": { status: 404, badJson: true } });
    expect(await detectRepoMoved(f)).toEqual({ kind: "unknown" });
    expect(f.calls).toHaveLength(1);
  });

  it("is unknown when offline", async () => {
    expect(await detectRepoMoved(mockFetch({ "galaxyproject/loom": "offline" }))).toEqual({
      kind: "unknown",
    });
  });

  it("is unknown when rate-limited (403 and 429)", async () => {
    for (const status of [403, 429]) {
      const f = mockFetch({
        "galaxyproject/loom": { status, body: { message: "API rate limit exceeded" } },
      });
      expect(await detectRepoMoved(f)).toEqual({ kind: "unknown" });
    }
  });

  it("is unknown on a 5xx", async () => {
    const f = mockFetch({
      "galaxyproject/loom": { status: 502, body: { message: "Server Error" } },
    });
    expect(await detectRepoMoved(f)).toEqual({ kind: "unknown" });
  });

  it("is unknown on malformed JSON or a body without a usable full_name", async () => {
    for (const reply of [
      { status: 200, badJson: true },
      { status: 200, body: null },
      { status: 200, body: { full_name: 42 } },
      { status: 200, body: { full_name: "../../etc" } },
    ]) {
      expect(await detectRepoMoved(mockFetch({ "galaxyproject/loom": reply }))).toEqual({
        kind: "unknown",
      });
    }
  });
});

describe("forcedRepoMoved", () => {
  it("is off unless set", () => {
    expect(forcedRepoMoved(undefined)).toBeNull();
    expect(forcedRepoMoved("")).toBeNull();
    expect(forcedRepoMoved("0")).toBeNull();
  });
  it("fakes a move to galaxyproject/orbit for 1/true", () => {
    for (const v of ["1", "true"]) {
      expect(forcedRepoMoved(v)).toMatchObject({
        fullName: "galaxyproject/orbit",
        releaseUrl: "https://github.com/galaxyproject/orbit/releases/latest",
      });
    }
  });
  it("accepts an explicit owner/repo", () => {
    expect(forcedRepoMoved("someone/else")?.fullName).toBe("someone/else");
  });
});
