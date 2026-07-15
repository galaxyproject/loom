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

  // Cooldown is rate-limiting, not a budget: pass now() so tests control it.
  function makeClock() {
    let t = 0;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it("re-arms on a later change when the history lookup failed at launch", async () => {
    const clock = makeClock();
    let attempts = 0;
    const deps = makeDeps({
      getHistoryId: async () => {
        attempts++;
        if (attempts === 1) throw new Error("galaxy down");
        return "h1";
      },
      findPageId: vi.fn(async () => null), // no prior page: local notebook is authoritative
      now: clock.now,
      retryCooldownMs: 1000,
    });
    const engine = createPageSyncEngine(deps);
    await engine.init();
    expect(deps.pushes).toHaveLength(0);

    clock.advance(2000); // past the cooldown
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
      now: makeClock().now, // clock never advances: flush must force past the cooldown
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

  // Codex #9: a hard attempt cap burned its whole budget on a few debounced edits
  // during one short outage, then never synced again -- the exact silent data loss
  // the retry was added to prevent. Rate-limit instead of counting.
  it("keeps retrying after many failures, once the cooldown passes", async () => {
    const clock = makeClock();
    let attempts = 0;
    const deps = makeDeps({
      getHistoryId: async () => {
        attempts++;
        if (attempts <= 8) throw new Error("galaxy down");
        return "h1";
      },
      findPageId: vi.fn(async () => null),
      now: clock.now,
      retryCooldownMs: 1000,
    });
    const engine = createPageSyncEngine(deps);
    await engine.init();
    for (let i = 0; i < 8; i++) {
      clock.advance(1500);
      (deps as unknown as { setBody: (b: string) => void }).setBody(`body-${i}`);
      deps.fire();
      await vi.advanceTimersByTimeAsync(150);
    }
    expect(deps.pushes).toHaveLength(1); // recovered on the 9th attempt
  });

  it("rate-limits retries so a dead Galaxy isn't hit on every keystroke", async () => {
    const clock = makeClock();
    let attempts = 0;
    const deps = makeDeps({
      getHistoryId: async () => {
        attempts++;
        throw new Error("galaxy down");
      },
      now: clock.now,
      retryCooldownMs: 30000,
    });
    const engine = createPageSyncEngine(deps);
    await engine.init(); // attempt 1
    for (let i = 0; i < 6; i++) {
      clock.advance(100); // well inside the cooldown
      (deps as unknown as { setBody: (b: string) => void }).setBody(`body-${i}`);
      deps.fire();
      await vi.advanceTimersByTimeAsync(150);
    }
    expect(attempts).toBe(1);
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

  // Codex #4: history and listing were timed out but resume wasn't, so a page GET
  // that accepted the connection and never answered still hung session_start.
  it("times out a hanging page resume", async () => {
    const deps = makeDeps({
      resume: vi.fn(() => new Promise<void>(() => {})), // never settles
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

  // Codex #5: skipping every empty body meant a user who deliberately cleared the
  // notebook could never sync that -- Galaxy kept the stale content and restored
  // it on the next launch.
  it("pushes a deliberate clear of a resumed page", async () => {
    const deps = makeDeps(); // resumes page-h1, baseline "first"
    const engine = createPageSyncEngine(deps);
    await engine.init();
    (deps as unknown as { setBody: (b: string) => void }).setBody("");
    deps.fire();
    await vi.advanceTimersByTimeAsync(150);
    expect(deps.pushes).toHaveLength(1);
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

  // Codex #6: historyId was committed before page discovery, so one failed
  // listing left the engine armed but blind to an existing page -- the next push
  // took the create path and duplicated it, and discovery never re-ran.
  it("stays unarmed when page discovery fails, then adopts the page on retry", async () => {
    const clock = makeClock();
    let lists = 0;
    const deps = makeDeps({
      findPageId: vi.fn(async () => {
        lists++;
        if (lists === 1) throw new Error("503");
        return "page-h1";
      }),
      now: clock.now,
      retryCooldownMs: 1000,
    });
    const engine = createPageSyncEngine(deps);
    await engine.init();
    expect(deps.resume).not.toHaveBeenCalled();

    (deps as unknown as { setBody: (b: string) => void }).setBody("edited");
    deps.fire();
    await vi.advanceTimersByTimeAsync(150);
    // Cooldown still running: must not create a rival page for the same history.
    expect(deps.pushes).toHaveLength(0);

    clock.advance(2000);
    deps.fire();
    await vi.advanceTimersByTimeAsync(150);
    expect(deps.resume).toHaveBeenCalledWith("page-h1"); // adopted, not duplicated
  });

  it("stays unarmed when resume of an existing page fails", async () => {
    const deps = makeDeps({
      resume: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const engine = createPageSyncEngine(deps);
    await engine.init();
    (deps as unknown as { setBody: (b: string) => void }).setBody("edited");
    deps.fire();
    await vi.advanceTimersByTimeAsync(150);
    // Pushing here would overwrite a page we failed to read.
    expect(deps.pushes).toHaveLength(0);
  });

  // Codex #3: an arm() in flight when the engine is disposed used to land anyway,
  // and resume() resolves the notebook path globally -- so a stale engine could
  // overwrite the NEXT session's notebook with its own page.
  it("does not resume after dispose", async () => {
    let release: (v: string) => void = () => {};
    const deps = makeDeps({
      getHistoryId: () => new Promise<string>((r) => (release = r)),
    });
    const engine = createPageSyncEngine(deps);
    const done = engine.init();
    engine.dispose();
    release("h1");
    await done;
    await vi.advanceTimersByTimeAsync(50);
    expect(deps.resume).not.toHaveBeenCalled();
    expect(deps.pushes).toHaveLength(0);
  });
});
