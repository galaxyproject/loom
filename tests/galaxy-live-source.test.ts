import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GalaxyLiveTicker,
  fetchGalaxyLiveSnapshot,
  historyIdFromNotebook,
  notebookHasLiveWork,
  projectHistory,
  projectRow,
  serverHostOf,
  type GalaxyLiveDeps,
  type GalaxyLiveTickerDeps,
  type SnapshotResult,
} from "../extensions/loom/galaxy-live-source.js";
import { GalaxyApiError, type GalaxyHistorySummary } from "../extensions/loom/galaxy-api.js";
import {
  armGalaxyLivePanel,
  disarmGalaxyLivePanel,
} from "../extensions/loom/galaxy-live-source.js";
import { getPollTickHook } from "../extensions/loom/galaxy-poller.js";
import {
  GALAXY_LIVE_MAX_ITEMS,
  normalizeGalaxyLivePayload,
} from "../shared/galaxy-live-contract.js";
import type { GalaxyLivePayload, GalaxyLiveState } from "../shared/galaxy-live-contract.js";

const CFG = { url: "https://usegalaxy.org", apiKey: "secret-key" };
const HID = "bbd44e69cb8906b5ad90dfce576d7d18";

function deps(get: GalaxyLiveDeps["get"], config: GalaxyLiveDeps["config"] = () => CFG) {
  return { get, config, now: () => new Date("2026-09-18T06:00:00.000Z") };
}

/** Responses recorded from public Galaxy servers; see the fixtures README. */
function fixture(name: string): unknown {
  const path = resolve(process.cwd(), "tests/fixtures/galaxy-live", `${name}.json`);
  return JSON.parse(readFileSync(path, "utf-8")) as unknown;
}

function stateHistogram(items: { state: GalaxyLiveState }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i.state] = (out[i.state] ?? 0) + 1;
  return out;
}

describe("projectRow", () => {
  it("drops deleted and hidden rows", () => {
    expect(projectRow({ id: "a", deleted: true })).toBeNull();
    expect(projectRow({ id: "a", visible: false })).toBeNull();
  });

  it("collapses an unknown Galaxy state instead of leaking it", () => {
    const row = projectRow({ id: "a", hid: 1, state: "brand_new_state_26_2" });
    expect(row?.state).toBe("other");
  });

  it("reports a collection by its worst element state", () => {
    const row = projectRow({
      id: "c",
      hid: 4,
      history_content_type: "dataset_collection",
      element_count: 12,
      populated_state: "ok",
      job_state_summary: { ok: 8, running: 3, error: 1 },
    });
    expect(row).toMatchObject({ kind: "collection", state: "error", elementCount: 12 });
  });

  it("clamps every Galaxy-supplied string, not only the obvious one", () => {
    // Capping the row count is not capping the payload. 200 rows with a
    // hundred-thousand-character id each is twenty megabytes on one stdout
    // line, every tick, through a cap that says it prevents exactly that.
    const row = projectRow({ id: "f".repeat(100_000), hid: 1, extension: "x".repeat(5_000) });
    expect(row!.id.length).toBeLessThanOrEqual(64);
    expect(row!.extension.length).toBeLessThanOrEqual(32);
  });

  it("clamps a pathological dataset name", () => {
    const row = projectRow({ id: "a", hid: 1, name: "x".repeat(5000) });
    expect(row!.name.length).toBe(200);
    expect(row!.name.endsWith("…")).toBe(true);
  });
});

describe("projectHistory against recorded Galaxy responses", () => {
  it("reads a mid-run history the way the panel will show it", () => {
    const h = projectHistory(
      "6f608228bd012a10",
      fixture("midrun.summary"),
      fixture("midrun.contents"),
    );
    expect(h.name).toBe("Unnamed history");
    expect(h.items).toHaveLength(21);
    expect(h.counts).toEqual({ error: 1, running: 2, ok: 18 });
    expect(h.countsComplete).toBe(true);
    expect(h.truncated).toBe(0);
    // Newest first: the thing a user is waiting on is the thing they launched.
    expect(h.items[0].hid).toBeGreaterThan(h.items[h.items.length - 1].hid);
  });

  it("counts the rows, not Galaxy's histogram, on the history where the two disagree", () => {
    // This fixture is here because of that disagreement. Galaxy's own
    // `contents_states` for it says {error: 10, ok: 57}; the rows say
    // {error: 19, ok: 48}, because nine collections are scored by the
    // collection's state while the row is scored by the worst job inside it.
    // A header that contradicts the list under it is the bug this prevents.
    const h = projectHistory(
      "bbd44e69cb8906b5988ab58ce61eee92",
      fixture("collections.summary"),
      fixture("collections.contents"),
    );
    expect(h.counts).toEqual(stateHistogram(h.items));
    expect(h.counts).toEqual({ error: 19, ok: 48 });
    expect(h.items.filter((i) => i.kind === "collection")).toHaveLength(23);
  });

  it("keeps a paused row out of both the finished and the failed buckets", () => {
    const h = projectHistory(
      "8a5202cb1d990bf9",
      fixture("paused.summary"),
      fixture("paused.contents"),
    );
    // One paused dataset and the collection above it, which is paused because
    // its only job is.
    expect(h.counts.paused).toBe(2);
    expect(h.counts.error ?? 0).toBe(0);
  });

  it("reads an empty history as empty, with its real name", () => {
    const h = projectHistory("dead", fixture("empty.summary"), fixture("empty.contents"));
    expect(h.items).toEqual([]);
    expect(h.counts).toEqual({});
    expect(h.name).toBe("실습 연습");
    expect(h.truncated).toBe(0);
  });

  it("renders a hostile dataset name as data, never interpreting it", () => {
    // No public server is serving this as a dataset name, so it is injected
    // into a recorded row rather than recorded. The row around it stays real.
    const rows = fixture("midrun.contents") as Record<string, unknown>[];
    const hostile = '<img src=x onerror="alert(1)">';
    const poisoned = rows.map((r, i) => (i === 0 ? { ...r, name: hostile } : r));
    const h = projectHistory("6f608228bd012a10", fixture("midrun.summary"), poisoned);
    expect(h.items.find((i) => i.name === hostile)).toBeTruthy();
  });

  it("bounds the payload in bytes, not only in rows", () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({
      id: "f".repeat(100_000),
      hid: i + 1,
      name: "n".repeat(100_000),
      state: "ok",
      extension: "e".repeat(100_000),
    }));
    const h = projectHistory(HID, { update_time: "u".repeat(1_000_000) }, rows);
    const bytes = JSON.stringify(h).length;
    expect(h.items).toHaveLength(200);
    // 200 rows of clamped fields, with room to spare and nothing like a
    // megabyte. Before the token clamp this was 21 MB.
    expect(bytes).toBeLessThan(200_000);
  });

  it("truncates a history too large to send, and says by how much", () => {
    // Built from a recorded row rather than committing a 5,000-row response.
    const [template] = fixture("midrun.contents") as Record<string, unknown>[];
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      ...template,
      id: `d${i}`.padStart(16, "0"),
      hid: i + 1,
    }));
    const h = projectHistory("6f608228bd012a10", { contents_active: { active: 5000 } }, rows);
    expect(h.items).toHaveLength(200);
    expect(h.truncated).toBe(4800);
    expect(h.truncatedExact).toBe(true);
    expect(h.countsComplete).toBe(false);
  });
});

describe("projectHistory arithmetic", () => {
  it("orders newest first and caps the list", () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({
      id: `d${i}`,
      hid: i + 1,
      name: `ds ${i}`,
      state: i % 2 === 0 ? "ok" : "running",
    }));
    const h = projectHistory(HID, { name: "My analysis", update_time: "t1" }, rows, 200);
    expect(h.items[0].hid).toBe(250);
    expect(h.items).toHaveLength(200);
    expect(h.counts.ok! + h.counts.running!).toBe(200);
  });

  it("knows rows were withheld even when the server sent no counts at all", () => {
    // An older Galaxy silently drops an unknown `keys=` and answers 200, so
    // `contents_active` is simply missing. The overflow row is what is left to
    // detect truncation with -- without it a 5000-dataset history renders a
    // page and claims there is nothing more.
    const rows = Array.from({ length: 11 }, (_, i) => ({ id: `d${i}`, hid: i + 1, state: "ok" }));
    const h = projectHistory(HID, {}, rows, 10);
    expect(h.items).toHaveLength(10);
    expect(h.truncated).toBe(1);
    expect(h.truncatedExact).toBe(false);
    expect(h.countsComplete).toBe(false);
  });

  it("uses the server's active count for an exact figure when it has one", () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ id: `d${i}`, hid: i + 1, state: "ok" }));
    const h = projectHistory(HID, { contents_active: { active: 900 } }, rows, 10);
    expect(h.truncated).toBe(890);
    expect(h.truncatedExact).toBe(true);
  });

  it("never undercounts, over every combination of server count and page size", () => {
    // The bound is `max`, not `min`. With `min` this assertion cannot fail in
    // the direction it is named after: active=0 and twelve rows fetched is the
    // exact case where the arithmetic used to report nothing hidden while
    // seven rows were, and `min` waves it through.
    for (let active = 0; active <= 12; active++) {
      for (let fetched = 0; fetched <= 12; fetched++) {
        const rows = Array.from({ length: fetched }, (_, i) => ({
          id: `d${i}`,
          hid: i + 1,
          state: "ok",
        }));
        const h = projectHistory(HID, { contents_active: { active } }, rows, 5);
        expect(h.truncated).toBeGreaterThanOrEqual(0);
        expect(
          h.items.length + h.truncated,
          `active=${active} fetched=${fetched}`,
        ).toBeGreaterThanOrEqual(Math.max(active, fetched));
        // And it must never claim completeness while rows are missing.
        if (h.items.length < fetched) expect(h.countsComplete).toBe(false);
      }
    }
  });

  it("does not believe a server count that is smaller than the rows it sent", () => {
    // The summary probe and the contents fetch are a second apart, so a history
    // that grew in between returns more rows than the count admits to. Trusting
    // the count outright drew a page and said nothing was hidden.
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, hid: i + 1, state: "ok" }));
    const h = projectHistory(HID, { contents_active: { active: 5 } }, rows, 5);
    expect(h.items).toHaveLength(5);
    expect(h.truncated).toBe(7);
    expect(h.truncatedExact).toBe(false);
    expect(h.countsComplete).toBe(false);
  });

  it("reports no truncation when the page is the whole history", () => {
    const rows = [{ id: "a", hid: 1, state: "ok" }];
    const h = projectHistory(HID, { contents_active: { active: 1 } }, rows, 10);
    expect(h.truncated).toBe(0);
    expect(h.truncatedExact).toBe(true);
    expect(h.countsComplete).toBe(true);
  });

  it("folds a state Galaxy invented into other rather than showing it raw", () => {
    const h = projectHistory(HID, {}, [
      { id: "a", hid: 1, state: "ok" },
      { id: "b", hid: 2, state: "warp_drive" },
    ]);
    expect(h.counts).toEqual({ ok: 1, other: 1 });
  });

  it("sorts ascending rows from a server that ignored order=hid-dsc", () => {
    const rows = [1, 2, 3].map((hid) => ({ id: `d${hid}`, hid, state: "ok" }));
    expect(projectHistory(HID, {}, rows).items.map((i) => i.hid)).toEqual([3, 2, 1]);
  });

  it("survives a contents response that is not a list", () => {
    const h = projectHistory(HID, {}, { err: "nope" });
    expect(h.items).toEqual([]);
    expect(h.name).toBe("Untitled history");
  });

  it.each([0, -3, NaN])("a nonsense row cap (%s) keeps rows rather than none", (keep) => {
    const rows = [{ id: "a", hid: 1, state: "ok" }];
    expect(projectHistory(HID, {}, rows, keep).items).toHaveLength(1);
  });
});

describe("serverHostOf", () => {
  it("reduces a url with credentials, a path and a query to its host alone", () => {
    expect(serverHostOf("https://u:p@galaxy.example:8443/gx/sub?key=abc#f")).toBe(
      "galaxy.example:8443",
    );
    expect(serverHostOf("not a url")).toBeNull();
    expect(serverHostOf(undefined)).toBeNull();
  });
});

describe("fetchGalaxyLiveSnapshot", () => {
  it("reports not-configured without touching the network", async () => {
    const get = vi.fn();
    const res = await fetchGalaxyLiveSnapshot(
      HID,
      {},
      deps(get, () => null),
    );
    expect(res.payload!.unavailable).toBe("not-configured");
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    [".", "single dot: `new URL` collapses the segment to the collection endpoint"],
    ["..", "parent segment"],
    ["../histories", "traversal"],
    ["..%2f..", "encoded traversal"],
    ["", "empty"],
    ["  bbd44e69cb8906b5  ", "surrounding whitespace"],
    ["bbd44e69cb8906b5\n", "trailing newline"],
    ["0x1f", "non-hex prefix"],
    ["abc", "shorter than a Galaxy id"],
    ["a".repeat(500), "absurdly long"],
  ])("refuses history id %j (%s) before any request", async (id) => {
    const get = vi.fn();
    const res = await fetchGalaxyLiveSnapshot(id, {}, deps(get));
    expect(res.payload!.unavailable).toBe("no-history");
    expect(get).not.toHaveBeenCalled();
  });

  it("would otherwise hit the histories COLLECTION for a dot id, which answers 200", () => {
    // Measured against usegalaxy.org on 2026-09-18 through node's fetch, which
    // is what galaxyGet uses: `new URL("https://usegalaxy.org/api/histories/.")`
    // normalizes the path to `/api/histories/`, and that endpoint answers
    // 200 [] anonymously. Without the id guard the probe would take that for a
    // real history and the panel would draw an empty "Untitled history".
    // A reviewer probing with curl or python sees a 400 instead, because
    // neither normalizes the dot segment -- so the guard looks like dead code
    // from the outside and is not.
    expect(new URL("https://usegalaxy.org/api/histories/.").pathname).toBe("/api/histories/");
    expect(new URL("https://usegalaxy.org/api/histories/..").pathname).toBe("/api/");
  });

  it("accepts a real Galaxy id and asks for exactly the two intended paths", async () => {
    const paths: string[] = [];
    const get = vi.fn(async (path: string) => {
      paths.push(path);
      return path.includes("/contents") ? [] : { update_time: "t" };
    }) as unknown as GalaxyLiveDeps["get"];
    await fetchGalaxyLiveSnapshot(HID, {}, deps(get));
    expect(paths).toEqual([
      `/histories/${HID}?keys=name,update_time,state,contents_active`,
      `/histories/${HID}/contents?v=dev&q=deleted&qv=False&q=visible&qv=True&order=hid-dsc&limit=201`,
    ]);
  });

  it("returns no payload at all when update_time has not moved", async () => {
    const get = vi.fn(async () => ({ update_time: "t1", name: "h" }));
    const res = await fetchGalaxyLiveSnapshot(HID, { knownUpdateTime: "t1" }, deps(get));
    expect(res.unchanged).toBe(true);
    // Not "a payload with history: null" -- that renders as "No history yet."
    // and would blank a populated panel if a caller forwarded it.
    expect(res.payload).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("refetches contents when update_time moves", async () => {
    const get = vi.fn(async (path: string) =>
      path.includes("/contents")
        ? [{ id: "a", hid: 1, name: "reads.fastq", state: "running" }]
        : { update_time: "t2", name: "h" },
    ) as unknown as GalaxyLiveDeps["get"];
    const res = await fetchGalaxyLiveSnapshot(HID, { knownUpdateTime: "t1" }, deps(get));
    expect(res.unchanged).toBe(false);
    expect(res.payload!.history?.items[0].name).toBe("reads.fastq");
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "no-history"],
    [400, "no-history"],
    [500, "unreachable"],
    [502, "unreachable"],
  ])("maps HTTP %i to %s", async (status, expected) => {
    const get = vi.fn(async () => {
      throw new GalaxyApiError(status, "", "err");
    });
    const res = await fetchGalaxyLiveSnapshot(HID, {}, deps(get));
    expect(res.payload!.unavailable).toBe(expected);
  });

  it("does not conflate a rejected key with a history that is not yours", async () => {
    // Galaxy answers 401 "Provided API key is not valid." for a bad key and 403
    // for a good key on someone else's history. Sending that second user to
    // re-enter a working key is its own bug, so the two must not share a state.
    const of = async (status: number) => {
      const get = vi.fn(async () => {
        throw new GalaxyApiError(status, "", "err");
      });
      return (await fetchGalaxyLiveSnapshot(HID, {}, deps(get))).payload!.unavailable;
    };
    expect(await of(401)).not.toBe(await of(403));
  });

  it("treats a network failure as unreachable, not as a credential problem", async () => {
    const dead = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    expect((await fetchGalaxyLiveSnapshot(HID, {}, deps(dead))).payload!.unavailable).toBe(
      "unreachable",
    );
  });

  it("a caller-aborted tick is silent, not a Galaxy failure", async () => {
    const controller = new AbortController();
    const get = vi.fn(async () => {
      controller.abort();
      throw new Error("The operation was aborted");
    });
    const res = await fetchGalaxyLiveSnapshot(HID, { signal: controller.signal }, deps(get));
    expect(res.aborted).toBe(true);
    expect(res.payload).toBeNull();
  });

  it.each([
    ["JSON null", null],
    ["a bare list", []],
    ["a string a proxy substituted", "<html>login</html>"],
  ])("refuses a 200 whose history summary is %s", async (_label, body) => {
    // Never-throws is this function's whole contract, and `null` broke it: the
    // TypeError escaped into the poller's catch, so the tick died with no
    // payload, no backoff and nothing on screen to say anything had happened.
    const get = vi.fn(async () => body) as unknown as GalaxyLiveDeps["get"];
    const res = await fetchGalaxyLiveSnapshot(HID, {}, deps(get));
    expect(res.payload!.unavailable).toBe("unreachable");
    expect(res.payload!.history).toBeNull();
    // One request, not two: there is nothing to compare an update_time against.
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("refuses a 200 whose contents are not a list, rather than drawing it empty", async () => {
    // The projection turns a non-array into no rows, which on screen is
    // "No datasets yet." -- a confident answer about someone's real history.
    const get = vi.fn(async (path: string) =>
      path.includes("/contents") ? { err: "not a list" } : { update_time: "t1", name: "mine" },
    ) as unknown as GalaxyLiveDeps["get"];
    const res = await fetchGalaxyLiveSnapshot(HID, {}, deps(get));
    expect(res.payload!.unavailable).toBe("unreachable");
    expect(res.payload!.history).toBeNull();
  });

  it("bounds a contents response from a server that ignored the limit", async () => {
    // We ask for 201 rows. A server handing back the whole history means
    // projectRow and the sort run over the lot on the 15 s timer, every tick.
    // Dropping the surplus rather than refusing it matters: refusing pins the
    // panel on "Galaxy did not answer" for the session, because the next tick
    // gets the same oversized answer.
    const rows = Array.from({ length: 5_000 }, (_, i) => ({
      id: `d${i}`,
      hid: 5_000 - i, // hid-descending, as we asked
      state: "ok",
    }));
    const get = vi.fn(async (path: string) =>
      path.includes("/contents") ? rows : { update_time: "t1", name: "mine" },
    ) as unknown as GalaxyLiveDeps["get"];

    const res = await fetchGalaxyLiveSnapshot(HID, {}, deps(get));
    expect(res.payload!.unavailable).toBeUndefined();
    const history = res.payload!.history!;
    // The newest rows, which is what the panel is for.
    expect(history.items[0].hid).toBe(5_000);
    expect(history.items).toHaveLength(GALAXY_LIVE_MAX_ITEMS);
    // And only the bounded set was projected at all. `truncated` counts the
    // rows that reached the projection and did not survive its own cap, so it
    // reads 1,800 for the 2,000 rows this looked at and 4,800 if it looked at
    // every one of the 5,000 -- which is the assertion that the bound happened.
    expect(history.truncated).toBe(GALAXY_LIVE_MAX_ITEMS * 10 - GALAXY_LIVE_MAX_ITEMS);
  });

  it("takes the newest rows even from a server that ignored the order too", async () => {
    // `projectHistory` sorts what it is handed, so cutting the head of an
    // ascending list would hand it the oldest rows in the history and the panel
    // would confidently show work the user finished long ago.
    const rows = Array.from({ length: 5_000 }, (_, i) => ({
      id: `d${i}`,
      hid: i + 1, // ascending: order=hid-dsc was ignored
      state: "ok",
    }));
    const get = vi.fn(async (path: string) =>
      path.includes("/contents") ? rows : { update_time: "t1", name: "mine" },
    ) as unknown as GalaxyLiveDeps["get"];

    const history = (await fetchGalaxyLiveSnapshot(HID, {}, deps(get))).payload!.history!;
    expect(history.items[0].hid).toBe(5_000);
  });

  it("bounds a Galaxy that never answers, so ticks cannot stack", async () => {
    // galaxyGet is a bare fetch with no timeout of its own and this runs on a
    // repeating timer, so the bound has to come from here.
    const seen: (AbortSignal | undefined)[] = [];
    const get = vi.fn(async (_path: string, signal?: AbortSignal) => {
      seen.push(signal);
      return { update_time: "t" };
    }) as unknown as GalaxyLiveDeps["get"];
    await fetchGalaxyLiveSnapshot(HID, { timeoutMs: 5 }, deps(get));
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    await new Promise((r) => setTimeout(r, 25));
    expect(seen[0]!.aborted).toBe(true);
  });

  it("never puts the api key, credentials or a path in the payload", async () => {
    const get = vi.fn(async (path: string) =>
      path.includes("/contents")
        ? [{ id: "a", hid: 1, name: "x", state: "ok" }]
        : { update_time: "t", name: "h", contents_active: { active: 1 } },
    ) as unknown as GalaxyLiveDeps["get"];
    const res = await fetchGalaxyLiveSnapshot(
      HID,
      {},
      deps(get, () => ({
        url: "https://svc:hunter2@galaxy.example/gx?token=sekrit",
        apiKey: "secret-key",
      })),
    );
    const json = JSON.stringify(res.payload);
    for (const leak of ["secret-key", "hunter2", "sekrit", "svc:", "/gx", "https://", "?"]) {
      expect(json, `payload leaked ${leak}`).not.toContain(leak);
    }
    expect(res.payload!.serverHost).toBe("galaxy.example");
  });
});

// ── Which history, and when to ask ───────────────────────────────────────────

const BINDING = (server: string, historyId: string) =>
  [
    "```loom-galaxy-page",
    "page_id: p1",
    "page_slug: slug",
    `galaxy_server_url: ${server}`,
    `history_id: ${historyId}`,
    "last_synced_revision: ",
    "bound_at: 2026-09-18T05:00:00Z",
    "```",
  ].join("\n");

const INVOCATION = (status: string) =>
  [
    "```loom-invocation",
    "invocation_id: aaaa1111bbbb2222",
    "galaxy_server_url: https://usegalaxy.org",
    "notebook_anchor: step-1",
    "label: RNA-seq",
    "submitted_at: 2026-09-18T05:00:00Z",
    `status: ${status}`,
    "```",
  ].join("\n");

describe("historyIdFromNotebook", () => {
  it("uses the notebook's binding for the server we are talking to", () => {
    const content = `# Notes\n\n${BINDING("https://usegalaxy.org", HID)}\n`;
    expect(historyIdFromNotebook(content, "https://usegalaxy.org")).toBe(HID);
  });

  it("ignores a binding written against a different Galaxy", () => {
    // A notebook copied from another server names a history id that means
    // nothing here; probing it would report "this history belongs to another
    // account" forever instead of falling back to the user's own.
    const content = BINDING("https://usegalaxy.eu", HID);
    expect(historyIdFromNotebook(content, "https://usegalaxy.org")).toBeNull();
  });

  it("takes the most recent binding when the notebook has several", () => {
    const content = [
      BINDING("https://usegalaxy.org", "1111111111111111"),
      BINDING("https://usegalaxy.org", "2222222222222222"),
    ].join("\n");
    expect(historyIdFromNotebook(content, "https://usegalaxy.org")).toBe("2222222222222222");
  });

  it("has nothing to say about a notebook that is absent or unbound", () => {
    expect(historyIdFromNotebook(null, "https://usegalaxy.org")).toBeNull();
    expect(historyIdFromNotebook("# just prose\n", "https://usegalaxy.org")).toBeNull();
  });
});

describe("notebookHasLiveWork", () => {
  it("is true while an invocation is in flight and false once it lands", () => {
    expect(notebookHasLiveWork(INVOCATION("in_progress"))).toBe(true);
    expect(notebookHasLiveWork(INVOCATION("completed"))).toBe(false);
    expect(notebookHasLiveWork(null)).toBe(false);
  });
});

// ── Cadence ──────────────────────────────────────────────────────────────────

interface TickerHarness {
  ticker: GalaxyLiveTicker;
  pushes: GalaxyLivePayload[];
  snapshot: ReturnType<typeof vi.fn>;
  advance(ms: number): void;
  deps: GalaxyLiveTickerDeps;
}

function historyPayload(updateTime: string): GalaxyLivePayload {
  return {
    version: 1,
    serverHost: "usegalaxy.org",
    history: {
      id: HID,
      name: "h",
      updateTime,
      counts: { ok: 1 },
      countsComplete: true,
      items: [{ id: "a", hid: 1, name: "x", state: "ok", extension: "txt", kind: "dataset" }],
      truncated: 0,
      truncatedExact: true,
    },
    updatedAt: "2026-09-18T06:00:00.000Z",
  };
}

function tickerHarness(
  over: Partial<GalaxyLiveTickerDeps> = {},
  results: SnapshotResult[] = [],
): TickerHarness {
  let clock = 1_000_000;
  const pushes: GalaxyLivePayload[] = [];
  let i = 0;
  const snapshot = vi.fn(
    async () =>
      results[Math.min(i++, results.length - 1)] ?? {
        payload: historyPayload("t1"),
        unchanged: false,
        aborted: false,
      },
  );
  const deps: GalaxyLiveTickerDeps = {
    snapshot: snapshot as unknown as GalaxyLiveTickerDeps["snapshot"],
    config: () => CFG,
    mostRecentHistory: async () => ({ id: HID, name: "most recent" }),
    push: (p) => pushes.push(p),
    now: () => clock,
    ...over,
  };
  return {
    ticker: new GalaxyLiveTicker(deps),
    pushes,
    snapshot,
    advance: (ms) => {
      clock += ms;
    },
    deps,
  };
}

const bound = `# Notes\n\n${BINDING("https://usegalaxy.org", HID)}\n`;

describe("GalaxyLiveTicker cadence", () => {
  it("says not-configured once and then asks Galaxy nothing", async () => {
    const h = tickerHarness({ config: () => null });
    await h.ticker.tick(bound);
    h.advance(600_000);
    await h.ticker.tick(bound);
    expect(h.snapshot).not.toHaveBeenCalled();
    // Once, not once a minute: there is no clock on that sentence to refresh.
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0].unavailable).toBe("not-configured");
    expect(h.pushes[0].serverHost).toBeNull();
  });

  it("polls every tick while something Loom launched is still running", async () => {
    const h = tickerHarness();
    const content = `${bound}\n${INVOCATION("in_progress")}`;
    await h.ticker.tick(content);
    h.advance(15_000);
    await h.ticker.tick(content);
    h.advance(15_000);
    await h.ticker.tick(content);
    expect(h.snapshot).toHaveBeenCalledTimes(3);
  });

  it("drops to a slow cadence when nothing is in flight", async () => {
    const h = tickerHarness();
    const content = `${bound}\n${INVOCATION("completed")}`;
    await h.ticker.tick(content);
    // Three more poller ticks inside the idle window buy nothing.
    for (let i = 0; i < 3; i++) {
      h.advance(15_000);
      await h.ticker.tick(content);
    }
    expect(h.snapshot).toHaveBeenCalledTimes(1);
    h.advance(20_000);
    await h.ticker.tick(content);
    expect(h.snapshot).toHaveBeenCalledTimes(2);
  });

  it("widens the gap while Galaxy keeps failing and closes it again on success", async () => {
    const fail: SnapshotResult = {
      payload: {
        version: 1,
        serverHost: "usegalaxy.org",
        history: null,
        unavailable: "unreachable",
        updatedAt: "2026-09-18T06:00:00.000Z",
      },
      unchanged: false,
      aborted: false,
    };
    const h = tickerHarness({}, [fail, fail, fail]);
    const content = `${bound}\n${INVOCATION("in_progress")}`;
    await h.ticker.tick(content);
    expect(h.snapshot).toHaveBeenCalledTimes(1);
    // One failure: the next active-cadence tick is too early now.
    h.advance(15_000);
    await h.ticker.tick(content);
    expect(h.snapshot).toHaveBeenCalledTimes(1);
    h.advance(20_000);
    await h.ticker.tick(content);
    expect(h.snapshot).toHaveBeenCalledTimes(2);
  });

  it("does not refetch contents when Galaxy says the history has not moved", async () => {
    const unchanged: SnapshotResult = { payload: null, unchanged: true, aborted: false };
    const h = tickerHarness({}, [
      { payload: historyPayload("t1"), unchanged: false, aborted: false },
      unchanged,
    ]);
    const content = `${bound}\n${INVOCATION("in_progress")}`;
    await h.ticker.tick(content);
    h.advance(15_000);
    await h.ticker.tick(content);
    // The second call carries the update_time from the first, which is the
    // whole of the cheap path: a 179-byte probe instead of a contents refetch.
    expect(h.snapshot.mock.calls[1][1]).toMatchObject({ knownUpdateTime: "t1" });
  });

  it("pushes once for an unchanged history, then again only to refresh the clock", async () => {
    const unchanged: SnapshotResult = { payload: null, unchanged: true, aborted: false };
    const h = tickerHarness({}, [
      { payload: historyPayload("t1"), unchanged: false, aborted: false },
      unchanged,
      unchanged,
    ]);
    const content = `${bound}\n${INVOCATION("in_progress")}`;
    await h.ticker.tick(content);
    expect(h.pushes).toHaveLength(1);
    h.advance(15_000);
    await h.ticker.tick(content);
    // Same content, and the staleness line is still honest, so nothing crosses.
    expect(h.pushes).toHaveLength(1);
    h.advance(60_000);
    await h.ticker.tick(content);
    expect(h.pushes).toHaveLength(2);
    expect(h.pushes[1].history).toEqual(h.pushes[0].history);
    expect(h.pushes[1].updatedAt).not.toBe(h.pushes[0].updatedAt);
  });

  it("does not wedge on a false error after one blip", async () => {
    // The sequence that broke it: a good read, one 502, then a healthy server
    // whose history has not changed since. The unchanged branch re-stamped the
    // LAST payload, which was the error, so the panel sat on "Galaxy did not
    // answer" for the rest of the session -- and for a settled history whose
    // update_time never moves again, forever.
    const good: SnapshotResult = {
      payload: historyPayload("t1"),
      unchanged: false,
      aborted: false,
    };
    const blip: SnapshotResult = {
      payload: {
        version: 1,
        serverHost: "usegalaxy.org",
        history: null,
        unavailable: "unreachable",
        updatedAt: "2026-09-18T06:00:00.000Z",
      },
      unchanged: false,
      aborted: false,
    };
    const h = tickerHarness({}, [good, blip, good, good, good]);
    const content = `${bound}\n${INVOCATION("in_progress")}`;
    await h.ticker.tick(content);
    expect(h.pushes.at(-1)!.history).not.toBeNull();
    h.advance(20_000);
    await h.ticker.tick(content);
    expect(h.pushes.at(-1)!.unavailable).toBe("unreachable");
    // Galaxy is fine again from here. The panel must come back.
    for (let i = 0; i < 6; i++) {
      h.advance(400_000);
      await h.ticker.tick(content);
    }
    expect(h.pushes.at(-1)!.unavailable).toBeUndefined();
    expect(h.pushes.at(-1)!.history).not.toBeNull();
  });

  it("re-asks for contents after a failure instead of trusting the old update_time", async () => {
    // The mechanism behind the wedge: keeping `knownUpdateTime` across a
    // failure lets the next healthy tick take the cheap no-change path and
    // never fetch the contents that would replace the error on screen.
    const blip: SnapshotResult = {
      payload: {
        version: 1,
        serverHost: "usegalaxy.org",
        history: null,
        unavailable: "unreachable",
        updatedAt: "2026-09-18T06:00:00.000Z",
      },
      unchanged: false,
      aborted: false,
    };
    const h = tickerHarness({}, [
      { payload: historyPayload("t1"), unchanged: false, aborted: false },
      blip,
      { payload: historyPayload("t1"), unchanged: false, aborted: false },
    ]);
    const content = `${bound}\n${INVOCATION("in_progress")}`;
    await h.ticker.tick(content);
    h.advance(20_000);
    await h.ticker.tick(content);
    h.advance(400_000);
    await h.ticker.tick(content);
    expect(h.snapshot.mock.calls[2][1].knownUpdateTime).toBeUndefined();
  });

  it("closes the gap again once Galaxy answers", async () => {
    const blip: SnapshotResult = {
      payload: {
        version: 1,
        serverHost: "usegalaxy.org",
        history: null,
        unavailable: "unreachable",
        updatedAt: "2026-09-18T06:00:00.000Z",
      },
      unchanged: false,
      aborted: false,
    };
    const h = tickerHarness({}, [
      blip,
      blip,
      { payload: historyPayload("t9"), unchanged: false, aborted: false },
    ]);
    const content = `${bound}\n${INVOCATION("in_progress")}`;
    await h.ticker.tick(content);
    h.advance(400_000);
    await h.ticker.tick(content);
    h.advance(400_000);
    await h.ticker.tick(content);
    expect(h.snapshot).toHaveBeenCalledTimes(3);
    // Two failures widened the gap; the success has to close it, or a run that
    // blipped once stays on a five-minute cadence for the rest of its life.
    h.advance(15_000);
    await h.ticker.tick(content);
    expect(h.snapshot).toHaveBeenCalledTimes(4);
  });

  it("re-asks which history is current once the cached answer expires", async () => {
    const mostRecentHistory = vi.fn(async () => ({ id: HID, name: "most recent" }));
    const h = tickerHarness({ mostRecentHistory });
    await h.ticker.tick("# no binding\n");
    h.advance(200_000);
    await h.ticker.tick("# no binding\n");
    expect(mostRecentHistory).toHaveBeenCalledTimes(1);
    h.advance(200_000);
    await h.ticker.tick("# no binding\n");
    expect(mostRecentHistory).toHaveBeenCalledTimes(2);
  });

  it("never forwards an unchanged result as a history-less payload", async () => {
    // The shape that would blank a populated panel: `history: null` renders as
    // "No history yet.", so an unchanged tick must not produce one.
    const h = tickerHarness({}, [
      { payload: historyPayload("t1"), unchanged: false, aborted: false },
      { payload: null, unchanged: true, aborted: false },
    ]);
    const content = `${bound}\n${INVOCATION("in_progress")}`;
    await h.ticker.tick(content);
    h.advance(120_000);
    await h.ticker.tick(content);
    expect(h.pushes.every((p) => p.history !== null)).toBe(true);
  });

  it("falls back to the most recent history when the notebook has no binding", async () => {
    const mostRecentHistory = vi.fn(async () => ({ id: HID, name: "most recent" }));
    const h = tickerHarness({ mostRecentHistory });
    await h.ticker.tick("# no binding here\n");
    expect(h.snapshot.mock.calls[0][0]).toBe(HID);
    // Reused rather than re-asked on the next poll.
    h.advance(120_000);
    await h.ticker.tick("# no binding here\n");
    expect(mostRecentHistory).toHaveBeenCalledTimes(1);
  });

  it("says no-history rather than guessing when Galaxy reports none", async () => {
    const h = tickerHarness({ mostRecentHistory: async () => null });
    await h.ticker.tick("# no binding here\n");
    expect(h.snapshot).not.toHaveBeenCalled();
    expect(h.pushes[0].unavailable).toBe("no-history");
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [500, "unreachable"],
  ])(
    "reports a %i while asking which history is current as %s, not as 'no history'",
    async (status, expected) => {
      // Telling someone their analysis is not attached to a history, when the
      // truth is that Galaxy rejected their key, sends them to fix the wrong
      // thing. The two sentences are not interchangeable.
      const h = tickerHarness({
        mostRecentHistory: async () => {
          throw new GalaxyApiError(status, "", "err");
        },
      });
      await h.ticker.tick("# no binding here\n");
      expect(h.snapshot).not.toHaveBeenCalled();
      expect(h.pushes[0].unavailable).toBe(expected);
    },
  );

  it("reports a dead network while resolving as unreachable", async () => {
    const h = tickerHarness({
      mostRecentHistory: async () => {
        throw new Error("fetch failed");
      },
    });
    await h.ticker.tick("# no binding here\n");
    expect(h.pushes[0].unavailable).toBe("unreachable");
  });

  it("backs off after a failed resolve, and not after an honest empty answer", async () => {
    // Counted on the resolve call itself: the pushes are identical either way,
    // because a repeated failure de-duplicates, so only the request count can
    // tell a widened gap from an unwidened one.
    const deadResolve = vi.fn(async (): Promise<GalaxyHistorySummary | null> => {
      throw new Error("fetch failed");
    });
    const dead = tickerHarness({ mostRecentHistory: deadResolve });
    await dead.ticker.tick("# no binding\n");
    dead.advance(20_000);
    await dead.ticker.tick(INVOCATION("in_progress"));
    // One failure widened the gap past the 15s active cadence.
    expect(deadResolve).toHaveBeenCalledTimes(1);
    dead.advance(15_000);
    await dead.ticker.tick(INVOCATION("in_progress"));
    expect(deadResolve).toHaveBeenCalledTimes(2);

    const emptyResolve = vi.fn(async (): Promise<GalaxyHistorySummary | null> => null);
    const none = tickerHarness({ mostRecentHistory: emptyResolve });
    await none.ticker.tick("# no binding\n");
    none.advance(20_000);
    await none.ticker.tick(INVOCATION("in_progress"));
    // Galaxy answering "you have no histories" is not a failure, so the next
    // active tick still asks -- a history created in between shows up at once.
    expect(emptyResolve).toHaveBeenCalledTimes(2);
    expect(none.snapshot).not.toHaveBeenCalled();
    expect(none.pushes[0].unavailable).toBe("no-history");
  });

  it("bounds the history resolve and lets go of it on stop", async () => {
    // `galaxyGet` has no timeout of its own, and this one is not behind the
    // snapshot's: a stalling server measured 301 s before the bare fetch threw,
    // and for all of it `running` stayed true and every later tick was dropped.
    let seen: AbortSignal | undefined;
    let settle: (() => void) | null = null;
    const hang = new Promise<void>((r) => {
      settle = r;
    });
    const h = tickerHarness({
      mostRecentHistory: async (signal?: AbortSignal) => {
        seen = signal;
        await hang;
        return { id: HID, name: "most recent" };
      },
    });

    const inFlight = h.ticker.tick("# no binding\n");
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(false);

    h.ticker.stop();
    expect(seen!.aborted).toBe(true);

    settle!();
    await inFlight;
    // Stopped mid-read: no error payload for a shutdown, and no further asks.
    expect(h.pushes).toEqual([]);
    expect(h.snapshot).not.toHaveBeenCalled();
    h.advance(120_000);
    await h.ticker.tick(bound);
    expect(h.snapshot).not.toHaveBeenCalled();
  });

  it("hands the snapshot something to cancel while it is still in flight", async () => {
    let seen: AbortSignal | undefined;
    let settle: (() => void) | null = null;
    const hang = new Promise<void>((r) => {
      settle = r;
    });
    const h = tickerHarness({
      snapshot: (async (_id: string, opts: { signal?: AbortSignal }) => {
        seen = opts.signal;
        await hang;
        return { payload: historyPayload("t1"), unchanged: false, aborted: true };
      }) as unknown as GalaxyLiveTickerDeps["snapshot"],
    });

    const inFlight = h.ticker.tick(bound);
    await new Promise((r) => setImmediate(r));
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(false);

    h.ticker.stop();
    expect(seen!.aborted).toBe(true);
    settle!();
    await inFlight;
  });

  it("does not pile a signal per tick onto one that lives for the session", async () => {
    // `AbortSignal.any` registers the composite on every source for as long as
    // that source lives and Node never takes it off again, so hanging one per
    // tick off the session's signal grows a list nothing empties -- measured at
    // one retained entry per call. Each tick owns its signal and releases it.
    const h = tickerHarness();
    const sessionSignal = (h.ticker as unknown as { abort: AbortController }).abort.signal;
    const listenerCount = (): number => {
      const sizes = Object.getOwnPropertySymbols(sessionSignal)
        .map((k) => (sessionSignal as unknown as Record<symbol, { size?: number }>)[k]?.size)
        .filter((n): n is number => typeof n === "number");
      // Guard against the test going vacuous if Node renames its internals: if
      // nothing here has a size, this is measuring nothing and should say so.
      expect(sizes.length).toBeGreaterThan(0);
      return sizes.reduce((a, b) => a + b, 0);
    };

    expect(listenerCount()).toBe(0);
    for (let i = 0; i < 50; i++) {
      h.advance(120_000);
      await h.ticker.tick(bound);
    }
    expect(h.snapshot.mock.calls.length).toBeGreaterThan(10);
    expect(listenerCount()).toBe(0);
  });

  it("forgets the previous history's update_time when the binding changes", async () => {
    const h = tickerHarness();
    await h.ticker.tick(`${BINDING("https://usegalaxy.org", "1111111111111111")}`);
    h.advance(120_000);
    await h.ticker.tick(`${BINDING("https://usegalaxy.org", "2222222222222222")}`);
    expect(h.snapshot.mock.calls[1][0]).toBe("2222222222222222");
    // Carrying t1 across would suppress the first real read of the new history.
    expect(h.snapshot.mock.calls[1][1].knownUpdateTime).toBeUndefined();
  });

  it("does not stack ticks when Galaxy is slow", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = tickerHarness({
      snapshot: (async () => {
        await gate;
        return { payload: historyPayload("t1"), unchanged: false, aborted: false };
      }) as unknown as GalaxyLiveTickerDeps["snapshot"],
    });
    const first = h.ticker.tick(bound);
    h.advance(120_000);
    await h.ticker.tick(bound);
    release!();
    await first;
    expect(h.pushes).toHaveLength(1);
  });

  it("swallows a throwing push rather than taking the poller tick down", async () => {
    const h = tickerHarness({
      push: () => {
        throw new Error("ctx is stale after session replacement or reload");
      },
    });
    await expect(h.ticker.tick(bound)).resolves.toBeUndefined();
  });

  it("an aborted read changes nothing the panel can see", async () => {
    const h = tickerHarness({}, [{ payload: null, unchanged: false, aborted: true }]);
    await h.ticker.tick(bound);
    expect(h.pushes).toEqual([]);
  });

  it("a fresh arming starts from nothing, which is what a new session wants", async () => {
    // There is no `reset()`: `armGalaxyLivePanel` builds a new ticker per
    // session, so a new session reads at once rather than waiting out an
    // interval measured against the previous one.
    const first = tickerHarness();
    await first.ticker.tick(bound);
    expect(first.pushes).toHaveLength(1);
    const second = tickerHarness();
    await second.ticker.tick(bound);
    expect(second.snapshot).toHaveBeenCalledTimes(1);
    expect(second.pushes).toHaveLength(1);
  });
});

// ── Arming ───────────────────────────────────────────────────────────────────

describe("armGalaxyLivePanel", () => {
  // The armed ticker resolves credentials from the real environment, so a
  // developer with GALAXY_URL exported would otherwise have these tests talk to
  // a live server. Take the env away for the duration.
  const prior: Record<string, string | undefined> = {};
  for (const key of ["LOOM_SHELL_KIND", "GALAXY_URL", "GALAXY_API_KEY"]) {
    prior[key] = process.env[key];
  }
  beforeEach(() => {
    delete process.env.GALAXY_URL;
    delete process.env.GALAXY_API_KEY;
  });
  afterEach(() => {
    disarmGalaxyLivePanel();
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function fakeCtx(): { ctx: { ui: { setWidget: ReturnType<typeof vi.fn> } } } {
    return { ctx: { ui: { setWidget: vi.fn() } } };
  }

  it("costs the terminal nothing: no hook, so the poller tick does no extra work", () => {
    delete process.env.LOOM_SHELL_KIND;
    const { ctx } = fakeCtx();
    armGalaxyLivePanel(ctx as never);
    expect(getPollTickHook()).toBeNull();
  });

  it("registers one hook in a shell that draws a dashboard, and clears it on shutdown", () => {
    process.env.LOOM_SHELL_KIND = "orbit";
    const { ctx } = fakeCtx();
    armGalaxyLivePanel(ctx as never);
    expect(getPollTickHook()).toBeTypeOf("function");
    disarmGalaxyLivePanel();
    expect(getPollTickHook()).toBeNull();
  });

  it("a second session_start replaces the hook rather than leaving two tickers", async () => {
    process.env.LOOM_SHELL_KIND = "orbit";
    const first = fakeCtx();
    armGalaxyLivePanel(first.ctx as never);
    const stale = getPollTickHook()!;
    const second = fakeCtx();
    armGalaxyLivePanel(second.ctx as never);
    // The hook the first arming installed is gone; calling the one that is
    // installed must not drive the ticker the first arming made.
    await stale(null);
    expect(first.ctx.ui.setWidget).not.toHaveBeenCalled();
  });

  it("pushes the projection under the galaxy-live widget key", async () => {
    process.env.LOOM_SHELL_KIND = "orbit";
    const { ctx } = fakeCtx();
    armGalaxyLivePanel(ctx as never);
    await getPollTickHook()!(null);
    // No Galaxy credentials in the test env, so this is the not-configured
    // payload -- what matters is the key and that it is one JSON line.
    expect(ctx.ui.setWidget).toHaveBeenCalledTimes(1);
    const [key, lines] = ctx.ui.setWidget.mock.calls[0];
    expect(key).toBe("galaxy-live");
    expect(JSON.parse((lines as string[])[0])).toMatchObject({
      version: 1,
      unavailable: "not-configured",
    });
  });

  it("drops the panel instead of spamming stderr when the session ctx goes stale", async () => {
    process.env.LOOM_SHELL_KIND = "orbit";
    const ctx = {
      ui: {
        setWidget: vi.fn(() => {
          throw new Error("ctx is stale after session replacement or reload");
        }),
      },
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    armGalaxyLivePanel(ctx as never);
    await getPollTickHook()!(null);
    expect(spy).not.toHaveBeenCalled();
    expect(getPollTickHook()).toBeNull();
    spy.mockRestore();
  });
});

// ── The boundary between two versions ────────────────────────────────────────

describe("normalizeGalaxyLivePayload", () => {
  // The brain ships on npm independently of the Orbit build, so this is a
  // boundary between two versions and not only between two processes. A shape
  // the shell does not recognise is a thing that happens.
  it.each([
    ["not an object", 42],
    ["null", null],
    ["an array", []],
    ["no version", { serverHost: "h", history: null, updatedAt: "" }],
    ["a version from the future", { version: 2, history: null, updatedAt: "" }],
  ])("refuses %s", (_label, raw) => {
    expect(normalizeGalaxyLivePayload(raw)).toBeNull();
  });

  it("keeps a payload whose history is the wrong type away from the widget", () => {
    // `items` as a string threw `items.filter is not a function` out of the
    // render, and the host turns that into a sticky error card only a click
    // recovers. One malformed push used to cost the panel.
    const p = normalizeGalaxyLivePayload({
      version: 1,
      serverHost: "usegalaxy.org",
      history: { id: "x", name: "n", items: "not an array" },
      updatedAt: "2026-09-18T06:00:00.000Z",
    });
    expect(p!.history!.items).toEqual([]);
  });

  it("drops rows that are not rows and folds a state it does not model", () => {
    const p = normalizeGalaxyLivePayload({
      version: 1,
      serverHost: "h",
      history: {
        id: "x",
        name: "n",
        items: [null, 7, { id: "a", hid: 1, state: "warp_drive" }],
        counts: { ok: 1, nonsense: 4, running: "many" },
      },
      updatedAt: "",
    });
    expect(p!.history!.items).toHaveLength(1);
    expect(p!.history!.items[0].state).toBe("other");
    expect(p!.history!.counts).toEqual({ ok: 1 });
  });

  it("keeps an unavailable reason it does not know, as a reason", () => {
    // Dropping the payload would leave the panel on stale rows; keeping the
    // unknown string would render a blank card. It becomes a reason the shell
    // does have a sentence for.
    const p = normalizeGalaxyLivePayload({
      version: 1,
      serverHost: "h",
      history: null,
      unavailable: "rate-limited",
      updatedAt: "",
    });
    expect(p!.history).toBeNull();
    expect(p!.unavailable).toBe("unreachable");
  });

  it("clamps a payload built to be enormous", () => {
    const p = normalizeGalaxyLivePayload({
      version: 1,
      serverHost: "h".repeat(100_000),
      history: {
        id: "i".repeat(100_000),
        name: "n".repeat(100_000),
        updateTime: "u".repeat(100_000),
        items: Array.from({ length: 5000 }, () => ({
          id: "x".repeat(100_000),
          name: "y".repeat(100_000),
          extension: "z".repeat(100_000),
        })),
      },
      updatedAt: "d".repeat(100_000),
    });
    expect(p!.history!.items).toHaveLength(200);
    expect(JSON.stringify(p).length).toBeLessThan(200_000);
  });

  it("round-trips a payload the brain actually built", () => {
    const history = projectHistory(
      "6f608228bd012a10",
      fixture("midrun.summary"),
      fixture("midrun.contents"),
    );
    const real: GalaxyLivePayload = {
      version: 1,
      serverHost: "usegalaxy.org.au",
      history,
      updatedAt: "2026-09-18T06:00:00.000Z",
    };
    expect(normalizeGalaxyLivePayload(JSON.parse(JSON.stringify(real)))).toEqual(real);
  });
});
