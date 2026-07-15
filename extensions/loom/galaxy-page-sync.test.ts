import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parsePageSyncMode,
  pageSlugForHistory,
  pageTitleForHistory,
  strippedNotebookBody,
  hasBodyChanged,
  createPageSyncEngine,
  type PageSyncDeps,
} from "./galaxy-page-sync.js";

describe("parsePageSyncMode", () => {
  it("is auto only for the exact 'auto' value", () => {
    expect(parsePageSyncMode({ LOOM_GALAXY_PAGE_SYNC: "auto" })).toBe("auto");
    expect(parsePageSyncMode({ LOOM_GALAXY_PAGE_SYNC: "1" })).toBe("off");
    expect(parsePageSyncMode({})).toBe("off");
  });
});

describe("pageSlugForHistory / pageTitleForHistory", () => {
  it("derives a stable per-history slug", () => {
    expect(pageSlugForHistory("abc123")).toBe("orbit-abc123");
  });
  it("derives a readable title", () => {
    expect(pageTitleForHistory("abc12345xyz")).toContain("abc12345");
  });
});

describe("strippedNotebookBody / hasBodyChanged", () => {
  it("removes the binding block and untrusted markers", () => {
    const content = ["# Notebook", "body line", "```loom-galaxy-page", "page_id: p1", "```"].join(
      "\n",
    );
    const stripped = strippedNotebookBody(content);
    expect(stripped).toContain("body line");
    expect(stripped).not.toContain("loom-galaxy-page");
    expect(stripped).not.toContain("page_id");
  });

  it("treats identical stripped bodies as unchanged (breaks self-trigger loop)", () => {
    expect(hasBodyChanged("same", "same")).toBe(false);
    expect(hasBodyChanged("old", "new")).toBe(true);
    expect(hasBodyChanged(null, "first")).toBe(true);
  });
});

function makeDeps(over: Partial<PageSyncDeps> = {}): PageSyncDeps & {
  pushes: Array<{ historyId: string; slug: string; title: string }>;
  fire: () => void;
} {
  let cb: (() => void) | null = null;
  const pushes: Array<{ historyId: string; slug: string; title: string }> = [];
  let body = "first";
  const deps: PageSyncDeps & { pushes: typeof pushes; fire: () => void } = {
    mode: "auto",
    hasGalaxy: () => true,
    getHistoryId: async () => "h1",
    readBody: async () => body,
    findPageId: vi.fn(async () => "page-h1"),
    resume: vi.fn(async () => {}),
    push: vi.fn(async (o) => {
      pushes.push(o);
    }),
    subscribe: (fn) => {
      cb = fn;
      return () => {
        cb = null;
      };
    },
    debounceMs: 100,
    pushes,
    fire: () => cb?.(),
    ...over,
  };
  // let tests mutate the body the watcher will read
  (deps as unknown as { setBody: (b: string) => void }).setBody = (b: string) => {
    body = b;
  };
  return deps;
}

describe("createPageSyncEngine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves the page id by slug and resumes by id", async () => {
    const deps = makeDeps();
    const engine = createPageSyncEngine(deps);
    await engine.init();
    expect(deps.findPageId).toHaveBeenCalledWith("h1", "orbit-h1");
    expect(deps.resume).toHaveBeenCalledWith("page-h1");
  });

  it("does not resume when no page exists for the history (fresh)", async () => {
    const deps = makeDeps({ findPageId: vi.fn(async () => null) });
    const engine = createPageSyncEngine(deps);
    await engine.init();
    expect(deps.resume).not.toHaveBeenCalled();
  });

  it("is a no-op when mode is off", async () => {
    const deps = makeDeps({ mode: "off" });
    const engine = createPageSyncEngine(deps);
    await engine.init();
    expect(deps.resume).not.toHaveBeenCalled();
  });

  it("debounce-pushes a changed body once", async () => {
    const deps = makeDeps();
    const engine = createPageSyncEngine(deps);
    await engine.init();
    (deps as unknown as { setBody: (b: string) => void }).setBody("changed");
    deps.fire();
    deps.fire();
    await vi.advanceTimersByTimeAsync(150);
    expect(deps.pushes).toHaveLength(1);
    expect(deps.pushes[0]).toEqual({
      historyId: "h1",
      slug: "orbit-h1",
      title: expect.any(String),
    });
  });

  it("skips a push when the stripped body is unchanged (self-trigger guard)", async () => {
    const deps = makeDeps();
    const engine = createPageSyncEngine(deps);
    await engine.init(); // body == "first" recorded as last-pushed baseline
    deps.fire(); // body still "first"
    await vi.advanceTimersByTimeAsync(150);
    expect(deps.pushes).toHaveLength(0);
  });

  it("flush() pushes the latest body immediately", async () => {
    const deps = makeDeps();
    const engine = createPageSyncEngine(deps);
    await engine.init();
    (deps as unknown as { setBody: (b: string) => void }).setBody("final");
    await engine.flush();
    expect(deps.pushes).toHaveLength(1);
  });

  it("serializes pushes: flush coalesces with an in-flight push (no concurrent overlap)", async () => {
    let releasePush: () => void = () => {};
    let calls = 0;
    const deps = makeDeps({
      push: vi.fn(async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          releasePush = () => resolve();
        });
      }),
    });
    const engine = createPageSyncEngine(deps);
    await engine.init(); // lastBody baseline = "first"
    (deps as unknown as { setBody: (b: string) => void }).setBody("changed");
    deps.fire();
    await vi.advanceTimersByTimeAsync(150); // debounce fires -> push #1 starts and hangs
    expect(calls).toBe(1);
    // The body is unchanged since push #1 started; flush must await the in-flight
    // push, not launch a second concurrent one (the pre-fix code did, because
    // lastBody is only set after the await).
    const flushP = engine.flush();
    releasePush(); // let push #1 complete
    await flushP;
    expect(calls).toBe(1);
  });

  it("does not throw when getHistoryId rejects (fail-open hardening)", async () => {
    const deps = makeDeps({
      getHistoryId: async () => {
        throw new Error("404");
      },
    });
    const engine = createPageSyncEngine(deps);
    await expect(engine.init()).resolves.toBeUndefined();
    expect(deps.resume).not.toHaveBeenCalled();
    expect(deps.pushes).toHaveLength(0);
  });
});

// #330 (Codex, HIGH): page-sync failures were silent AND permanent. A Galaxy
// that was briefly down at launch left init() with no history, which disabled
// sync for the entire session while the UI still showed Galaxy as connected --
// the notebook then only ever existed under /tmp, and the container's /tmp dies
// with the job.
describe("createPageSyncEngine recovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("re-arms on a later change when the history lookup failed at launch", async () => {
    let attempts = 0;
    const deps = makeDeps({
      getHistoryId: async () => {
        attempts++;
        if (attempts === 1) throw new Error("galaxy down");
        return "h1";
      },
      findPageId: vi.fn(async () => null), // no prior page: local notebook is authoritative
    });
    const engine = createPageSyncEngine(deps);
    await engine.init();
    expect(deps.pushes).toHaveLength(0);

    (deps as unknown as { setBody: (b: string) => void }).setBody("written while galaxy was down");
    deps.fire();
    await vi.advanceTimersByTimeAsync(150);

    expect(attempts).toBe(2);
    expect(deps.pushes).toHaveLength(1);
    expect(deps.pushes[0].historyId).toBe("h1");
  });

  it("recovers content written during the outage on flush, not just on change", async () => {
    let attempts = 0;
    const deps = makeDeps({
      getHistoryId: async () => {
        attempts++;
        if (attempts === 1) return null; // no history yet
        return "h1";
      },
      findPageId: vi.fn(async () => null),
    });
    const engine = createPageSyncEngine(deps);
    await engine.init();
    (deps as unknown as { setBody: (b: string) => void }).setBody("work worth keeping");

    await engine.flush();

    // Without arming inside the push path this flushed nothing and the work was
    // lost with the container.
    expect(deps.pushes).toHaveLength(1);
    expect(deps.pushes[0].historyId).toBe("h1");
  });

  it("gives up after maxInitAttempts so a dead Galaxy isn't retried forever", async () => {
    let attempts = 0;
    const deps = makeDeps({
      getHistoryId: async () => {
        attempts++;
        throw new Error("galaxy down");
      },
      maxInitAttempts: 3,
    });
    const engine = createPageSyncEngine(deps);
    await engine.init(); // attempt 1
    for (let i = 0; i < 6; i++) {
      (deps as unknown as { setBody: (b: string) => void }).setBody(`body-${i}`);
      deps.fire();
      await vi.advanceTimersByTimeAsync(150);
    }
    expect(attempts).toBe(3);
    expect(deps.pushes).toHaveLength(0);
  });

  it("times out a hanging history request instead of stalling session_start", async () => {
    const deps = makeDeps({
      getHistoryId: () => new Promise<string>(() => {}), // never settles
      initTimeoutMs: 5000,
    });
    const engine = createPageSyncEngine(deps);
    const done = engine.init();
    await vi.advanceTimersByTimeAsync(5001);
    await expect(done).resolves.toBeUndefined();
  });

  it("does not publish a page for an untouched notebook", async () => {
    const deps = makeDeps({ findPageId: vi.fn(async () => null) });
    (deps as unknown as { setBody: (b: string) => void }).setBody("");
    const engine = createPageSyncEngine(deps);
    await engine.init();
    deps.fire();
    await vi.advanceTimersByTimeAsync(150);
    await engine.flush();
    expect(deps.pushes).toHaveLength(0);
  });

  it("still skips a redundant push right after resuming an existing page", async () => {
    // resume() rewrites the notebook, which fires the watcher; that self-trigger
    // must not bounce straight back to Galaxy as a no-op push.
    const deps = makeDeps(); // findPageId -> "page-h1", body stays "first"
    const engine = createPageSyncEngine(deps);
    await engine.init();
    deps.fire();
    await vi.advanceTimersByTimeAsync(150);
    expect(deps.pushes).toHaveLength(0);
  });
});
