// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  buildDataMessage,
  clampHeight,
  MessageBudget,
  readFrameMessage,
} from "../app/src/renderer/dashboard/sandbox/protocol.js";
import {
  SANDBOX_MAX_DATA_BYTES,
  SANDBOX_MAX_HEIGHT,
  SANDBOX_MESSAGE_TAG,
  SANDBOX_MIN_HEIGHT,
} from "../app/src/renderer/dashboard/sandbox/policy.js";
import {
  byteLength,
  collectSandboxData,
  resolveAllowedSources,
  SANDBOX_DATA_SOURCES,
} from "../app/src/renderer/dashboard/sandbox/data-snapshot.js";
import { DashboardSources } from "../app/src/renderer/dashboard/data-sources.js";

const tag = SANDBOX_MESSAGE_TAG;

/** A fixed DataSource, for driving the payload budget without the real plumbing. */
function source<T>(value: T) {
  return { get: () => value, subscribe: () => () => {} };
}

describe("readFrameMessage", () => {
  it("accepts the two messages the frame is allowed to send", () => {
    expect(readFrameMessage({ tag, type: "ready" })).toEqual({ type: "ready" });
    expect(readFrameMessage({ tag, type: "height", height: 240 })).toEqual({
      type: "height",
      height: 240,
    });
  });

  it("ignores anything without our tag, so unrelated page traffic cannot drive it", () => {
    expect(readFrameMessage({ type: "height", height: 240 })).toBeNull();
    expect(readFrameMessage({ tag: "other", type: "height", height: 240 })).toBeNull();
    expect(readFrameMessage({ tag, type: "eval", code: "steal()" })).toBeNull();
  });

  it("ignores values that are not messages at all", () => {
    for (const junk of [null, undefined, 0, "", "height", [], true, Symbol("x")]) {
      expect(readFrameMessage(junk)).toBeNull();
    }
  });

  it("refuses a height that is not a number rather than coercing it", () => {
    // Math.round("400") is 400. A hostile frame sends exactly that sort of thing.
    for (const bad of ["400", null, undefined, {}, [], NaN, Infinity, -Infinity]) {
      expect(readFrameMessage({ tag, type: "height", height: bad })).toBeNull();
    }
  });

  it("clamps a height into something a panel can hold", () => {
    expect(readFrameMessage({ tag, type: "height", height: 1e9 })).toEqual({
      type: "height",
      height: SANDBOX_MAX_HEIGHT,
    });
    expect(readFrameMessage({ tag, type: "height", height: -5000 })).toEqual({
      type: "height",
      height: SANDBOX_MIN_HEIGHT,
    });
    expect(clampHeight(0)).toBe(SANDBOX_MIN_HEIGHT);
    expect(clampHeight(240.6)).toBe(241);
  });

  it("does not trust a plain object's inherited fields", () => {
    const hostile = Object.create({ tag, type: "height", height: 400 }) as object;
    expect(readFrameMessage(hostile)).toBeNull();
  });
});

describe("MessageBudget", () => {
  it("lets an ordinary amount of traffic through", () => {
    const now = 0;
    const budget = new MessageBudget(5, () => now);
    for (let i = 0; i < 5; i++) expect(budget.allow()).toBe(true);
  });

  it("drops a flood and says so", () => {
    const now = 0;
    const budget = new MessageBudget(3, () => now);
    budget.allow();
    budget.allow();
    budget.allow();
    expect(budget.allow()).toBe(false);
    expect(budget.allow()).toBe(false);
  });

  it("forgives once the second is over", () => {
    let now = 0;
    const budget = new MessageBudget(2, () => now);
    budget.allow();
    budget.allow();
    expect(budget.allow()).toBe(false);
    now = 1001;
    expect(budget.allow()).toBe(true);
    expect(budget.allow()).toBe(true);
  });
});

describe("resolveAllowedSources", () => {
  it("defaults to nothing at all", () => {
    expect(resolveAllowedSources(undefined)).toEqual([]);
    expect(resolveAllowedSources([])).toEqual([]);
    expect(resolveAllowedSources("notebook")).toEqual([]);
    expect(resolveAllowedSources({ notebook: true })).toEqual([]);
  });

  it("keeps only names it knows, and de-duplicates them", () => {
    expect(resolveAllowedSources(["plan", "nope", "plan", 7, null])).toEqual(["plan"]);
    expect(resolveAllowedSources(["session", "notebook"])).toEqual(["notebook", "session"]);
  });

  it("cannot be talked into a source that is not a data source", () => {
    expect(resolveAllowedSources(["constructor", "__proto__", "toString"])).toEqual([]);
  });
});

describe("collectSandboxData", () => {
  it("sends nothing when nothing was allowed", () => {
    const sources = new DashboardSources();
    sources.setNotebook("# secret notes");
    expect(collectSandboxData(sources.sources, [])).toEqual({ sources: {}, dropped: [] });
  });

  it("sends only the named source", () => {
    const sources = new DashboardSources();
    sources.setNotebook("# heading\n\ntext");
    const payload = collectSandboxData(sources.sources, ["notebook"]);
    expect(Object.keys(payload.sources)).toEqual(["notebook"]);
    expect(JSON.stringify(payload.sources)).toContain("heading");
  });

  it("leaves the session's working directory behind", () => {
    const sources = new DashboardSources();
    sources.setSession({ cwd: "/Users/someone/analysis", model: "m", status: "running" });
    const payload = collectSandboxData(sources.sources, ["session"]);
    expect(JSON.stringify(payload.sources)).not.toContain("/Users/someone");
    expect((payload.sources.session as { model: string }).model).toBe("m");
  });

  it("keeps the tail of a notebook rather than the whole thing", () => {
    const sources = new DashboardSources();
    sources.setNotebook("A".repeat(200_000) + "THE-END");
    const payload = collectSandboxData(sources.sources, ["notebook"]);
    const markdown = (payload.sources.notebook as { markdown: string }).markdown;
    expect(markdown.length).toBeLessThanOrEqual(32 * 1024);
    expect(markdown.endsWith("THE-END")).toBe(true);
  });

  it("does not need to drop anything for an ordinary big notebook", () => {
    const sources = new DashboardSources();
    sources.setNotebook("B".repeat(200_000));
    const payload = collectSandboxData(sources.sources, [...SANDBOX_DATA_SOURCES]);
    // The per-source caps do the work; the drop list is the backstop, not the
    // normal path, and a view should not lose its plan over a long notebook.
    expect(payload.dropped).toEqual([]);
    expect(JSON.stringify(payload.sources).length).toBeLessThanOrEqual(SANDBOX_MAX_DATA_BYTES);
  });

  it("drops whole sources until the message fits, least useful first", () => {
    // Sources big enough to blow the cap even after the per-source caps: a
    // deep file tree and a long plan are the two that can really get there.
    const many = (n: number, make: (i: number) => unknown): unknown[] =>
      Array.from({ length: n }, (_, i) => make(i));
    const fake = {
      notebook: source({ markdown: "N".repeat(30_000), path: null, updatedAt: 1 }),
      invocations: source({ invocations: [], jobs: [], updatedAt: 1 }),
      plan: source({
        plans: many(10, (p) => ({
          id: `plan-${p}`,
          title: "T".repeat(100),
          routing: null,
          steps: many(100, (n) => ({
            anchor: null,
            number: n,
            title: "S".repeat(60),
            status: "pending",
            routing: "R".repeat(40),
            verification: "V".repeat(60),
            detail: "D".repeat(120),
          })),
        })),
        updatedAt: 1,
      }),
      activity: source({
        events: many(200, (i) => ({
          timestamp: "2026-09-18T00:00:00Z",
          kind: `kind-${i}`,
          source: "S".repeat(60),
          payload: {},
        })),
        available: true,
        updatedAt: 1,
      }),
      files: source({ root: null, available: false, updatedAt: 1 }),
      session: source({
        status: "running",
        streaming: false,
        cwd: "",
        model: "m",
        costUsd: 1,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        updatedAt: 1,
      }),
    } as unknown as DashboardSources["sources"];

    const payload = collectSandboxData(fake, [...SANDBOX_DATA_SOURCES]);
    expect(JSON.stringify(payload.sources).length).toBeLessThanOrEqual(SANDBOX_MAX_DATA_BYTES);
    expect(payload.dropped.length).toBeGreaterThan(0);
    // Whatever had to go, the small definitive ones are still there.
    expect(payload.sources.session).toBeDefined();
    expect(payload.dropped).not.toContain("session");
  });

  it("does not let one unreadable source take the others down", () => {
    const sources = new DashboardSources();
    const broken = {
      ...sources.sources,
      plan: {
        get() {
          throw new Error("nope");
        },
        subscribe() {
          return () => {};
        },
      },
    } as typeof sources.sources;
    const payload = collectSandboxData(broken, ["plan", "session"]);
    expect(payload.sources.plan).toBeNull();
    expect(payload.sources.session).toBeDefined();
  });
});

describe("the file tree budgets", () => {
  /** A tree `depth` deep with `fan` children at every level. */
  function tree(depth: number, fan: number, prefix = "n"): unknown {
    const node: Record<string, unknown> = {
      name: prefix,
      relPath: prefix,
      type: depth > 0 ? "directory" : "file",
      size: 10,
    };
    if (depth > 0) {
      node.children = Array.from({ length: fan }, (_, i) => tree(depth - 1, fan, `${prefix}-${i}`));
    }
    return node;
  }

  /** A single deep chain, built iteratively -- 5000 frames of recursion would
   *  overflow the test helper long before it reached the code under test. */
  function chain(depth: number): unknown {
    let node: Record<string, unknown> = { name: "leaf", relPath: "leaf", type: "file" };
    for (let i = 0; i < depth; i++) {
      node = { name: `d${i}`, relPath: `d${i}`, type: "directory", children: [node] };
    }
    return node;
  }

  function filesPayload(root: unknown): Record<string, unknown> {
    const fake = {
      files: source({ root, available: true, updatedAt: 1 }),
    } as unknown as DashboardSources["sources"];
    return collectSandboxData(fake, ["files"]).sources.files as Record<string, unknown>;
  }

  it("cuts the tree off at a fixed depth", () => {
    const out = filesPayload(tree(12, 1));
    let node = out.root as { children?: Array<Record<string, unknown>> } | null;
    let depth = 0;
    while (node?.children && node.children.length > 0) {
      depth += 1;
      node = node.children[0] as { children?: Array<Record<string, unknown>> };
    }
    // MAX_FILE_DEPTH is 6, so six levels of children below the root.
    expect(depth).toBe(6);
  });

  it("stops at a fixed number of nodes however wide the tree is", () => {
    const out = filesPayload(tree(3, 40));
    const count = (node: unknown): number => {
      if (!node || typeof node !== "object") return 0;
      const n = node as { children?: unknown[] };
      return 1 + (n.children ?? []).reduce<number>((sum, c) => sum + count(c), 0);
    };
    expect(count(out.root)).toBeLessThanOrEqual(500);
  });

  it("does not blow the stack on a deep tree, which is the point of the cap", () => {
    expect(() => filesPayload(chain(50_000))).not.toThrow();
  });

  it("keeps only the fields a view could draw with", () => {
    const out = filesPayload({
      name: "n",
      relPath: "n",
      type: "file",
      size: 3,
      secret: "should not travel",
    });
    expect(JSON.stringify(out)).not.toContain("should not travel");
  });
});

describe("buildDataMessage", () => {
  it("carries the tag the frame filters on", () => {
    const msg = buildDataMessage({ sources: { plan: null }, dropped: ["files"] });
    expect(msg.tag).toBe(SANDBOX_MESSAGE_TAG);
    expect(msg.type).toBe("data");
    expect(msg.dropped).toEqual(["files"]);
  });

  it("measures the cap in bytes, not in UTF-16 code units", () => {
    // A notebook of three-byte characters is three times its `.length`, and
    // the cap is a byte cap.
    expect(byteLength("\u4e2d".repeat(1000))).toBe(3000);
    expect(byteLength("abc")).toBe(3);
  });

  it("is structured-cloneable, which is what postMessage will do to it", () => {
    const sources = new DashboardSources();
    sources.setNotebook("# x");
    const msg = buildDataMessage(collectSandboxData(sources.sources, ["notebook", "session"]));
    expect(() => structuredClone(msg)).not.toThrow();
  });
});
