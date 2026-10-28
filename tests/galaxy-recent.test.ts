import { describe, it, expect, vi } from "vitest";
import { fetchGalaxyActivity, GalaxyActivityFeed } from "../extensions/loom/galaxy-activity";
import { resolveGalaxyActivityOpenUrl } from "../app/src/main/galaxy-status";
import type { GalaxyActivitySnapshot } from "../shared/loom-shell-contract.js";

// Explicit test fixtures; these IDs are never submitted to a Galaxy server.
const historyId = "bbd44e69cb8906b579031c61c5da0079";
const runId = "d426ce413085bb90";
const workflowId = "71ab77d140f07717";
const userId = "c539ec64488526c0";
const config = { url: "https://galaxy.example/subpath", apiKey: "test-only-key" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const snapshot = (server = config.url): GalaxyActivitySnapshot => ({
  server,
  phase: "ready",
  histories: [
    { id: historyId, name: "Test history", updatedAt: "2026-09-21T12:00:00Z", published: false },
  ],
  invocations: [],
  historiesUpdatedAt: "2026-09-21T12:00:00Z",
});

describe("recent Galaxy account retrieval", () => {
  it("sorts on the server, preserves scheduled state, and resolves exact workflow instances", async () => {
    const requests: string[] = [];
    const mock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      requests.push(u.pathname + u.search);
      expect(init?.headers).toEqual({ "x-api-key": "test-only-key" });
      expect(init?.redirect).toBe("error");
      if (u.pathname.endsWith("/users/current")) return response({ id: userId, is_admin: true });
      if (u.pathname.endsWith("/histories"))
        return response([{ id: historyId, name: "History", count: 9, update_time: "2026-09-21" }]);
      if (u.pathname.endsWith("/invocations"))
        return response([
          {
            id: runId,
            workflow_id: workflowId,
            history_id: historyId,
            state: "scheduled",
            create_time: "2026-09-21",
          },
        ]);
      return response({ name: "Original workflow version" });
    });
    const result = await fetchGalaxyActivity(
      config,
      new AbortController().signal,
      mock as typeof fetch,
    );
    expect(requests[0]).toContain("order=update_time-dsc");
    // Galaxy legacy history filters do not support the archived column.
    expect(new URL(requests[0], config.url).searchParams.getAll("q")).toEqual([
      "deleted",
      "purged",
    ]);
    const invocationsRequest = requests.find((r) => r.includes("/invocations?"))!;
    expect(invocationsRequest).toContain("sort_by=create_time&sort_desc=true");
    expect(new URL(invocationsRequest, config.url).searchParams.get("user_id")).toBe(userId);
    expect(requests.indexOf("/subpath/api/users/current")).toBeLessThan(
      requests.indexOf(invocationsRequest),
    );
    expect(requests).toContain(`/subpath/api/workflows/${workflowId}?instance=true`);
    expect(result.histories[0].count).toBe(9);
    expect(result.invocations[0]).toMatchObject({
      state: "scheduled",
      name: "Original workflow version",
      historyName: "History",
    });
    expect(JSON.stringify(result)).not.toContain(config.apiKey);
  });

  it("retains a working list when the other fails and never echoes response bodies", async () => {
    const mock = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/users/current")
        ? response({ id: userId })
        : String(url).includes("/histories?")
          ? response("secret server debug body", 403)
          : response([]),
    );
    const result = await fetchGalaxyActivity(
      config,
      new AbortController().signal,
      mock as typeof fetch,
    );
    expect(result.historiesError).toMatch(/sign-in failed/);
    expect(result.invocationsUpdatedAt).toBeTruthy();
    expect(result.invocationsError).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("secret server");
  });

  it("lists the current admin's runs even when the global page contains only other users", async () => {
    const requests: URL[] = [];
    const own = { id: runId, workflow_id: workflowId, history_id: historyId };
    const mock = vi.fn(async (url: string | URL | Request) => {
      const u = new URL(String(url));
      requests.push(u);
      if (u.pathname.endsWith("/users/current")) return response({ id: userId, is_admin: true });
      if (u.pathname.endsWith("/invocations")) {
        return response(
          u.searchParams.get("user_id") === userId
            ? [own]
            : Array.from({ length: 12 }, (_, i) => ({
                id: `ff${i.toString(16)}`,
                workflow_id: "deadbeef",
                history_id: "feedface",
              })),
        );
      }
      if (u.pathname.endsWith("/histories")) return response([]);
      return response({ name: "My workflow" });
    });
    const result = await fetchGalaxyActivity(
      config,
      new AbortController().signal,
      mock as typeof fetch,
    );
    expect(result.invocations.map((r) => r.id)).toEqual([runId]);
    const listings = requests.filter((r) => r.pathname.endsWith("/invocations"));
    expect(listings).toHaveLength(1);
    expect(listings[0].searchParams.get("user_id")).toBe(userId);
    expect(listings[0].searchParams.get("limit")).toBe("12");
    expect(requests.some((r) => /deadbeef|feedface/.test(r.pathname))).toBe(false);
  });

  it.each([
    [401, { detail: "private server body" }],
    [500, { detail: "private server body" }],
    [200, null],
    [200, {}],
    [200, { id: null }],
    [200, { id: "not-an-encoded-id" }],
    [200, { id: userId, is_anonymous: true }],
  ])("does not request invocations if current-user lookup fails (%s, %j)", async (status, user) => {
    const requests: string[] = [];
    const mock = vi.fn(async (url: string | URL | Request) => {
      const pathname = new URL(String(url)).pathname;
      requests.push(pathname);
      if (pathname.endsWith("/users/current")) return response(user, status as number);
      if (pathname.endsWith("/histories")) return response([{ id: historyId, name: "My history" }]);
      throw new Error("Unexpected activity request");
    });
    const result = await fetchGalaxyActivity(
      config,
      new AbortController().signal,
      mock as typeof fetch,
    );
    expect(result.histories.map((h) => h.id)).toEqual([historyId]);
    expect(result.invocations).toEqual([]);
    expect(result.invocationsError).toBeTruthy();
    expect(result.invocationsUpdatedAt).toBeUndefined();
    expect(requests.some((r) => r.includes("/invocations"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private server body");
  });

  it("resolves invocation ownership from each refresh's API key", async () => {
    const otherUserId = "f0e1d2c3b4a59687";
    const listingUsers: string[] = [];
    const mock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("/users/current")) {
        const key = new Headers(init?.headers).get("x-api-key");
        return response({ id: key === config.apiKey ? userId : otherUserId });
      }
      if (u.pathname.endsWith("/invocations")) listingUsers.push(u.searchParams.get("user_id")!);
      return response([]);
    });
    await fetchGalaxyActivity(config, new AbortController().signal, mock as typeof fetch);
    await fetchGalaxyActivity(
      { ...config, apiKey: "other-test-key" },
      new AbortController().signal,
      mock as typeof fetch,
    );
    expect(listingUsers).toEqual([userId, otherUserId]);
  });

  it("rejects an unsafe URL before sending a credential", async () => {
    const mock = vi.fn();
    await expect(
      fetchGalaxyActivity(
        { ...config, url: "http://external.example" },
        new AbortController().signal,
        mock,
      ),
    ).rejects.toThrow();
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("activity feed lifetime", () => {
  it("coalesces refreshes and discards old-account responses even on the same server", async () => {
    let current = config;
    const pending: Array<(value: GalaxyActivitySnapshot) => void> = [];
    const fetcher = vi.fn(
      () => new Promise<GalaxyActivitySnapshot>((resolve) => pending.push(resolve)),
    );
    const publish = vi.fn();
    const feed = new GalaxyActivityFeed(publish, () => current, fetcher);
    const first = feed.refresh();
    expect(feed.refresh()).toBe(first);
    current = { ...config, apiKey: "other-test-account" };
    const second = feed.refresh();
    pending[0](snapshot());
    await first;
    expect(publish.mock.calls.every(([value]) => value.phase === "loading")).toBe(true);
    pending[1]({ ...snapshot(), histories: [] });
    await second;
    expect(publish.mock.lastCall?.[0].histories).toEqual([]);
    feed.stop();
  });

  it("preserves same-account stale rows, then clears them on disconnect", async () => {
    let current: typeof config | null = config;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce({
        ...snapshot(),
        phase: "error",
        histories: [],
        historiesError: "offline",
      });
    const publish = vi.fn();
    const feed = new GalaxyActivityFeed(publish, () => current, fetcher);
    await feed.refresh();
    await feed.refresh();
    expect(publish.mock.lastCall?.[0]).toMatchObject({
      histories: snapshot().histories,
      historiesError: "offline",
    });
    current = null;
    await feed.refresh();
    expect(publish.mock.lastCall?.[0]).toMatchObject({
      server: null,
      phase: "disconnected",
      histories: [],
      invocations: [],
    });
    feed.stop();
  });

  it("does not publish a response after session shutdown", async () => {
    let resolve!: (value: GalaxyActivitySnapshot) => void;
    const publish = vi.fn();
    const feed = new GalaxyActivityFeed(
      publish,
      () => config,
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = feed.refresh();
    feed.stop();
    publish.mockClear();
    resolve(snapshot());
    await pending;
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("activity link boundary", () => {
  it("opens history and invocation links only within the configured deployment", () => {
    const base = config.url;
    expect(
      resolveGalaxyActivityOpenUrl(`${base}/workflows/invocations/${runId}`, base),
    ).toBeTruthy();
    expect(
      resolveGalaxyActivityOpenUrl(`${base}/histories/view?id=${historyId}`, base),
    ).toBeTruthy();
    for (const url of [
      `https://other.example/workflows/invocations/${runId}`,
      `https://galaxy.example/workflows/invocations/${runId}`,
      `${base}/workflows/invocations/../delete`,
      `${base}/api/histories`,
      `javascript:alert(1)`,
    ]) {
      expect(resolveGalaxyActivityOpenUrl(url, base)).toBeNull();
    }
  });
});
