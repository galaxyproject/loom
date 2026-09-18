// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeAge,
  galaxyHistoryWidget,
  renderGalaxyHistory,
  summarizeCounts,
} from "../app/src/renderer/dashboard/widgets/galaxy-history.js";
import { projectHistory } from "../extensions/loom/galaxy-live-source.js";
import { DashboardSources } from "../app/src/renderer/dashboard/data-sources.js";
import type { GalaxyLivePayload } from "../shared/galaxy-live-contract.js";

const CONFIG = { limit: 25, activeOnly: false };
const NOW = Date.parse("2026-09-18T06:00:05.000Z");

/** Resolved from the repo root, not from `import.meta.url`: under happy-dom
 *  that is a page URL, not a file path. */
function fixture(name: string): unknown {
  const path = resolve(process.cwd(), "tests/fixtures/galaxy-live", `${name}.json`);
  return JSON.parse(readFileSync(path, "utf-8")) as unknown;
}

function payload(over: Partial<GalaxyLivePayload> = {}): GalaxyLivePayload {
  return {
    version: 1,
    serverHost: "usegalaxy.org",
    updatedAt: "2026-09-18T06:00:00.000Z",
    history: {
      id: "bbd4",
      name: "RNA-seq run",
      updateTime: "2026-09-18T05:59:00Z",
      counts: { ok: 2, running: 1 },
      countsComplete: true,
      items: [
        {
          id: "c",
          hid: 3,
          name: "counts.tabular",
          state: "running",
          extension: "tabular",
          kind: "dataset",
        },
        { id: "b", hid: 2, name: "aligned.bam", state: "ok", extension: "bam", kind: "dataset" },
        {
          id: "a",
          hid: 1,
          name: "reads",
          state: "ok",
          extension: "",
          kind: "collection",
          elementCount: 6,
        },
      ],
      truncated: 0,
      truncatedExact: true,
    },
    ...over,
  };
}

function draw(p: GalaxyLivePayload | null, config = CONFIG, now = NOW): HTMLElement {
  const root = document.createElement("div");
  renderGalaxyHistory(root, p, config, { now, mountedAt: now });
  return root;
}

describe("summarizeCounts", () => {
  it("leads with what is broken, then what is moving, in words not state names", () => {
    expect(summarizeCounts({ ok: 18, running: 3, error: 1 })).toBe(
      "1 failed, 3 running, 18 finished",
    );
  });

  it("merges the two states that both mean failed", () => {
    // "1 failed, 1 failed" on one line reads as a bug, because it is one.
    expect(summarizeCounts({ error: 1, failed_metadata: 1 })).toBe("2 failed");
  });

  it("never shows a Galaxy state string", () => {
    const text = summarizeCounts({
      setting_metadata: 1,
      failed_metadata: 1,
      other: 1,
      new: 1,
      empty: 1,
    });
    for (const machine of ["setting_metadata", "failed_metadata", "other", "new"]) {
      expect(text).not.toContain(machine);
    }
  });

  it("does not use the word 'empty' for 'no items', since empty is also a state", () => {
    expect(summarizeCounts({})).toBe("nothing yet");
    expect(summarizeCounts({ empty: 3 })).toBe("3 empty");
  });
});

describe("describeAge", () => {
  it.each([
    [0, "just now"],
    [30_000, "just now"],
    [120_000, "2 min ago"],
    [3_600_000, "1 hour ago"],
    [6 * 86_400_000, "6 days ago"],
    // The last millisecond of each bucket used to round up past the bucket it
    // was in: "60 min ago" sat immediately before "1 hour ago".
    [3_599_999, "59 min ago"],
    [86_399_999, "23 hours ago"],
  ])("reads %i ms as %s", (ms, expected) => {
    expect(describeAge(ms)).toBe(expected);
  });

  it("does not call an unreadable stamp 'just now'", () => {
    // "just now" is the one direction this line must never guess in.
    expect(describeAge(NaN)).toBe("an unknown time ago");
    expect(describeAge(Infinity)).toBe("an unknown time ago");
  });
});

describe("renderGalaxyHistory", () => {
  it("draws a row per item with its state in plain language", () => {
    const root = draw(payload());
    const rows = root.querySelectorAll(".gx-live-row");
    expect(rows).toHaveLength(3);
    expect(root.querySelector(".gx-live-counts")?.textContent).toBe("1 running, 2 finished");
    expect(root.querySelector(".gx-live-host")?.textContent).toBe("usegalaxy.org");
    expect(rows[0].querySelector(".gx-live-pill")?.textContent).toContain("Running");
    expect(rows[2].textContent).toContain("collection (6)");
  });

  it("carries the state without relying on colour", () => {
    // Every pill has a mark and a word, so the state survives greyscale and
    // survives a reader who cannot separate the reds from the greens.
    const p = payload();
    p.history!.items[0].state = "error";
    const pill = draw(p).querySelector(".gx-live-row .gx-live-pill")!;
    expect(pill.querySelector(".gx-live-mark")?.textContent).toBeTruthy();
    expect(pill.textContent).toContain("Failed");
  });

  it("keeps the staleness line out of the part that scrolls", () => {
    // A panel three grid rows tall scrolls its list. Anything below the list is
    // off-screen, and the line saying how old these numbers are is the one that
    // must not be.
    const root = draw(payload());
    const checked = root.querySelector(".gx-live-checked")!;
    expect(checked.closest(".gx-live-scroll")).toBeNull();
    expect(root.querySelector(".gx-live-list")?.closest(".gx-live-scroll")).toBeTruthy();
  });

  it("always says when Galaxy was last asked", () => {
    // A bar nobody has refreshed in an hour and a bar that has not moved in an
    // hour look identical. This line is the difference.
    expect(draw(payload()).querySelector(".gx-live-checked")?.textContent).toBe("Checked just now");
    const old = payload({ updatedAt: "2026-09-12T06:00:00.000Z" });
    const line = draw(old).querySelector(".gx-live-checked")!;
    expect(line.textContent).toBe("Checked 6 days ago");
    expect(line.classList.contains("gx-live-stale")).toBe(true);
  });

  it("renders a hostile dataset name as text, never as markup", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const p = payload();
    p.history!.items = [
      { id: "x", hid: 1, name: hostile, state: "ok", extension: "txt", kind: "dataset" },
    ];
    const root = draw(p);
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector(".gx-live-name")?.textContent).toBe(hostile);
    expect(root.querySelector(".gx-live-name")?.getAttribute("title")).toBe(hostile);
  });

  it("renders a hostile history name and server host as text too", () => {
    const p = payload({ serverHost: "<script>x</script>" });
    p.history!.name = "<b>not bold</b>";
    const root = draw(p);
    expect(root.querySelector("b")).toBeNull();
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector(".gx-live-title")?.textContent).toBe("<b>not bold</b>");
  });

  it("says something for a reason this build has never heard of", () => {
    // The brain ships on npm independently of the shell, so a newer reason
    // reaching an older panel is a supported configuration. It used to render
    // a header above an empty paragraph.
    const root = draw(payload({ history: null, unavailable: "rate-limited" as never }));
    expect(root.querySelector(".gx-live-empty")?.textContent).toBeTruthy();
  });

  it("says when Galaxy was last asked even when the stamp is unreadable", () => {
    // The line disappearing takes the panel's one promise with it.
    const root = draw(payload({ updatedAt: "not a date" }));
    const line = root.querySelector(".gx-live-checked")!;
    expect(line.textContent).toBe("Checked an unknown time ago");
    expect(line.classList.contains("gx-live-stale")).toBe(true);
  });

  it("turns each unavailable reason into its own sentence and no rows", () => {
    const seen = new Set<string>();
    for (const reason of [
      "not-configured",
      "no-history",
      "unreachable",
      "unauthorized",
      "forbidden",
    ] as const) {
      const root = draw(payload({ history: null, unavailable: reason }));
      expect(root.querySelectorAll(".gx-live-row")).toHaveLength(0);
      const text = root.querySelector(".gx-live-empty")?.textContent ?? "";
      expect(text).toBeTruthy();
      seen.add(text);
    }
    // A rejected key and someone else's history must not share a sentence:
    // one of them tells the user to fix a credential that is fine.
    expect(seen.size).toBe(5);
  });

  it("counts server-withheld and panel-hidden rows together, from a real projection", () => {
    // Built by projectHistory, not by hand, so this fails if the truncation
    // arithmetic breaks rather than only if the renderer does.
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, hid: i + 1, state: "ok" }));
    const history = projectHistory("bbd4", { contents_active: { active: 45 } }, rows, 5);
    const root = draw({ ...payload(), history }, { limit: 2, activeOnly: false });
    expect(root.querySelectorAll(".gx-live-row")).toHaveLength(2);
    // 40 the server withheld + 3 of the 5 fetched that the budget dropped.
    expect(root.querySelector(".gx-live-more")?.textContent).toBe("+ 43 more");
  });

  it("marks the figure as a lower bound when the server gave no count", () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, hid: i + 1, state: "ok" }));
    const history = projectHistory("bbd4", {}, rows, 5);
    const root = draw({ ...payload(), history });
    expect(root.querySelector(".gx-live-more")?.textContent).toBe("+ 1+ more");
  });

  it("still reports withheld rows when the visible list is empty", () => {
    // The case that matters: activeOnly hides everything on screen while
    // hundreds of rows sit behind the page. "Nothing running" alone is a lie.
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, hid: i + 1, state: "ok" }));
    const history = projectHistory("bbd4", { contents_active: { active: 300 } }, rows, 5);
    const root = draw({ ...payload(), history }, { limit: 25, activeOnly: true });
    expect(root.querySelectorAll(".gx-live-row")).toHaveLength(0);
    expect(root.querySelector(".gx-live-empty")?.textContent).toBe("Nothing running right now.");
    expect(root.querySelector(".gx-live-more")?.textContent).toBe("+ 300 more");
  });

  it("labels the counts as a page when they do not cover the history", () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, hid: i + 1, state: "ok" }));
    const history = projectHistory("bbd4", { contents_active: { active: 300 } }, rows, 5);
    const root = draw({ ...payload(), history });
    expect(root.querySelector(".gx-live-counts")?.textContent).toBe("5 finished (newest 5)");
  });

  it.each([0, -3, NaN, undefined, "25"])(
    "a nonsense row budget (%s) still renders rows",
    (limit) => {
      const root = draw(payload(), { limit: limit as number, activeOnly: false });
      expect(root.querySelectorAll(".gx-live-row").length).toBeGreaterThan(0);
    },
  );

  it("never claims the history is empty while rows are withheld", () => {
    const p = payload();
    p.history!.items = [];
    p.history!.counts = {};
    p.history!.countsComplete = false;
    p.history!.truncated = 12;
    const root = draw(p);
    expect(root.querySelector(".gx-live-empty")?.textContent).not.toContain("no datasets yet");
    expect(root.querySelector(".gx-live-more")?.textContent).toBe("+ 12 more");
  });

  it("never prints a count of nothing", () => {
    // Two lines of a 400px panel saying one thing. The counts line earns its
    // place only when there is something to count -- including the case where
    // the page is empty but rows are withheld, which printed the memorable
    // "nothing yet (newest 0)" above "+ 40 more".
    const history = projectHistory("dead", fixture("empty.summary"), fixture("empty.contents"));
    expect(draw({ ...payload(), history }).querySelector(".gx-live-counts")).toBeNull();
    const withheld = projectHistory("x", { contents_active: { active: 40 } }, [], 5);
    const root = draw({ ...payload(), history: withheld });
    expect(root.querySelector(".gx-live-counts")).toBeNull();
    expect(root.querySelector(".gx-live-more")?.textContent).toBe("+ 40 more");
  });

  it("says the history is empty only when Galaxy agrees it is", () => {
    const history = projectHistory("dead", fixture("empty.summary"), fixture("empty.contents"));
    const root = draw({ ...payload(), history });
    expect(root.querySelector(".gx-live-empty")?.textContent).toBe(
      "This history has no datasets yet.",
    );
  });

  it("activeOnly keeps everything that has not finished cleanly", () => {
    const p = payload();
    // Newest first, the way the projection hands them over.
    p.history!.items.unshift({
      id: "d",
      hid: 4,
      name: "broken.bam",
      state: "error",
      extension: "bam",
      kind: "dataset",
    });
    const root = draw(p, { limit: 25, activeOnly: true });
    const names = [...root.querySelectorAll(".gx-live-name")].map((n) => n.textContent);
    // A failure is the last thing a filter should hide.
    expect(names).toEqual(["broken.bam", "counts.tabular"]);
  });

  it("keeps a state Galaxy invented visible under activeOnly", () => {
    // `other` is the bucket for a state this build has never heard of. Treating
    // it as finished would hide a future failure behind the filter.
    const p = payload();
    p.history!.items = [
      { id: "x", hid: 1, name: "mystery", state: "other", extension: "", kind: "dataset" },
    ];
    const root = draw(p, { limit: 25, activeOnly: true });
    expect(root.querySelectorAll(".gx-live-row")).toHaveLength(1);
    expect(root.querySelector(".gx-live-pill")?.textContent).toContain("Unknown");
  });

  it("draws a recorded mid-run history end to end", () => {
    const history = projectHistory(
      "6f608228bd012a10",
      fixture("midrun.summary"),
      fixture("midrun.contents"),
    );
    const root = draw({ ...payload(), history }, { limit: 50, activeOnly: false });
    expect(root.querySelector(".gx-live-counts")?.textContent).toBe(
      "1 failed, 2 running, 18 finished",
    );
    expect(root.querySelectorAll(".gx-live-row")).toHaveLength(21);
  });

  it("stops saying 'waiting' once nothing has arrived for a while", () => {
    const root = document.createElement("div");
    renderGalaxyHistory(root, null, CONFIG, { now: NOW, mountedAt: NOW });
    expect(root.querySelector(".gx-live-empty")?.textContent).toContain("Waiting");
    const later = document.createElement("div");
    renderGalaxyHistory(later, null, CONFIG, { now: NOW + 120_000, mountedAt: NOW });
    expect(later.querySelector(".gx-live-empty")?.textContent).toBe("No word from Galaxy yet.");
  });
});

describe("galaxyHistoryWidget.mount", () => {
  const timers: Array<() => void> = [];
  afterEach(() => {
    while (timers.length) timers.pop()!();
    vi.useRealTimers();
  });

  function harness(source: unknown) {
    const element = document.createElement("div");
    const header = document.createElement("div");
    const config = { ...CONFIG };
    const patches: unknown[] = [];
    const cleanups: Array<() => void> = [];
    const ctx = {
      panelId: "p1",
      config,
      sources: source === undefined ? {} : { galaxy: source },
      header,
      setConfig: (patch: unknown) => patches.push(patch),
      onDispose: (fn: () => void) => cleanups.push(fn),
      subscribe: <T>(
        src: { get(): T; subscribe(l: (v: T) => void): () => void },
        l: (v: T) => void,
      ) => {
        l(src.get());
        return src.subscribe(l);
      },
      fail: () => {},
    };
    timers.push(() => cleanups.forEach((fn) => fn()));
    return { element, header, ctx, patches, cleanups };
  }

  it("renders the current value and repaints on a push", () => {
    let listener: ((v: GalaxyLivePayload | null) => void) | null = null;
    let current: GalaxyLivePayload | null = null;
    const source = {
      get: () => current,
      subscribe: (l: (v: GalaxyLivePayload | null) => void) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    };
    const h = harness(source);
    const dispose = galaxyHistoryWidget.mount(h.element, h.ctx as never);
    expect(h.element.querySelector(".gx-live-empty")?.textContent).toContain("Waiting");

    current = payload();
    listener!(current);
    expect(h.element.querySelectorAll(".gx-live-row")).toHaveLength(3);

    (dispose as () => void)();
    expect(listener).toBeNull();
    expect(h.header.querySelector("button")).toBeNull();
  });

  it("renders without waiting for a push, even if subscribe is not immediate", () => {
    // A harness that calls the listener itself cannot see a blank panel; this
    // one deliberately does not deliver on subscribe.
    const element = document.createElement("div");
    const ctx = {
      panelId: "p1",
      config: { ...CONFIG },
      sources: { galaxy: { get: () => payload(), subscribe: () => () => {} } },
      header: document.createElement("div"),
      setConfig: () => {},
      onDispose: () => {},
      subscribe: <T>(src: { subscribe(l: (v: T) => void): () => void }, l: (v: T) => void) =>
        src.subscribe(l),
      fail: () => {},
    };
    galaxyHistoryWidget.mount(element, ctx as never);
    expect(element.querySelectorAll(".gx-live-row")).toHaveLength(3);
  });

  it("says not connected -- not 'waiting' -- when the shell has no Galaxy source", () => {
    const h = harness(undefined);
    galaxyHistoryWidget.mount(h.element, h.ctx as never);
    const text = h.element.querySelector(".gx-live-empty")?.textContent ?? "";
    expect(text).toBe("Not connected to a Galaxy server.");
    expect(text).not.toContain("Waiting");
  });

  it("reads the real host's galaxy source, which starts empty and takes a push", () => {
    // Against DashboardSources rather than a stand-in, so the widget and the
    // source cannot drift apart without a test noticing.
    const sources = new DashboardSources();
    const h = harness(sources.sources.galaxy);
    galaxyHistoryWidget.mount(h.element, h.ctx as never);
    expect(h.element.querySelector(".gx-live-empty")?.textContent).toContain("Waiting");
    sources.setGalaxyLive(payload());
    expect(h.element.querySelectorAll(".gx-live-row")).toHaveLength(3);
    // A new analysis directory must not leave the old history on screen.
    sources.reset();
    expect(h.element.querySelectorAll(".gx-live-row")).toHaveLength(0);
  });

  it("does not say 'no word from Galaxy' the instant the analysis changes", () => {
    // Switching analysis directory pushes null without re-mounting the widget.
    // Measured from the original mount, a panel open for ten minutes went
    // straight to "No word from Galaxy yet.", which reads as a broken Galaxy
    // rather than as a panel that has been waiting two seconds.
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-18T06:00:00.000Z"));
    const sources = new DashboardSources();
    const h = harness(sources.sources.galaxy);
    galaxyHistoryWidget.mount(h.element, h.ctx as never);
    sources.setGalaxyLive(payload());
    vi.advanceTimersByTime(10 * 60_000);
    sources.reset();
    expect(h.element.querySelector(".gx-live-empty")?.textContent).toContain("Waiting");
  });

  it("a re-mount after dispose leaves exactly one subscription and one toggle", () => {
    let live = 0;
    const source = {
      get: () => payload(),
      subscribe: () => {
        live++;
        return () => {
          live--;
        };
      },
    };
    const h = harness(source);
    for (let i = 0; i < 5; i++) {
      const dispose = galaxyHistoryWidget.mount(h.element, h.ctx as never);
      expect(live).toBe(1);
      expect(h.header.querySelectorAll("button")).toHaveLength(1);
      (dispose as () => void)();
      expect(live).toBe(0);
      expect(h.header.querySelectorAll("button")).toHaveLength(0);
    }
  });

  it("the header toggle asks the host to persist the flip, it does not mutate config", () => {
    const source = { get: () => payload(), subscribe: () => () => {} };
    const h = harness(source);
    galaxyHistoryWidget.mount(h.element, h.ctx as never);
    const btn = h.header.querySelector("button")!;
    expect(btn.textContent).toBe("Only active");
    btn.dispatchEvent(new Event("click"));
    expect(h.patches).toEqual([{ activeOnly: true }]);
    expect(h.ctx.config.activeOnly).toBe(false);
    // The label must not be left saying the opposite of what it just did.
    expect(btn.textContent).toBe("Show all");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  it("registers its clock through onDispose, not the returned dispose", () => {
    // A render that throws turns the panel into an error card and the widget
    // never returns a dispose, so an interval hung off the return value would
    // keep firing against a detached node.
    vi.useFakeTimers();
    const source = { get: () => payload(), subscribe: () => () => {} };
    const h = harness(source);
    galaxyHistoryWidget.mount(h.element, h.ctx as never);
    expect(h.cleanups).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    h.cleanups[0]();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes the staleness line without a push", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-18T06:00:00.000Z"));
    const source = { get: () => payload(), subscribe: () => () => {} };
    const h = harness(source);
    galaxyHistoryWidget.mount(h.element, h.ctx as never);
    expect(h.element.querySelector(".gx-live-checked")?.textContent).toBe("Checked just now");
    vi.advanceTimersByTime(10 * 60_000);
    const line = h.element.querySelector(".gx-live-checked")!;
    expect(line.textContent).toBe("Checked 10 min ago");
    expect(line.classList.contains("gx-live-stale")).toBe(true);
  });
});
