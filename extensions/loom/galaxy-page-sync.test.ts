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

  it("resumes on init using the per-history slug", async () => {
    const deps = makeDeps();
    const engine = createPageSyncEngine(deps);
    await engine.init();
    expect(deps.resume).toHaveBeenCalledWith("orbit-h1");
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
