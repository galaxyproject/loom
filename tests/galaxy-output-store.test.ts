import { afterEach, describe, expect, it } from "vitest";
import {
  createMemoryOutputStore,
  galaxyOutputStore,
  setGalaxyOutputStore,
  type GalaxyOutputStore,
} from "../extensions/loom/galaxy-output-store";
import { isUlid } from "../extensions/loom/ulid";

afterEach(() => setGalaxyOutputStore(null));

describe("in-memory Galaxy output ring", () => {
  it("round-trips text under a ulid", () => {
    const store = createMemoryOutputStore();
    const id = store.put('{"data":[1,2,3]}', "get_history_contents");
    expect(isUlid(id)).toBe(true);
    expect(store.get(id)).toBe('{"data":[1,2,3]}');
    expect(store.list()).toEqual([
      { id, tool: "get_history_contents", bytes: 16, at: expect.any(Number) },
    ]);
  });

  it("answers undefined for an id it never issued, including a path-shaped one", () => {
    const store = createMemoryOutputStore();
    store.put("x", "get_user");
    expect(store.get("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBeUndefined();
    expect(store.get("/tmp/pi-mcp-0123456789abcdef.txt")).toBeUndefined();
  });

  it("evicts the oldest entry on the 33rd put by default", () => {
    const store = createMemoryOutputStore();
    const ids = Array.from({ length: 33 }, (_, i) => store.put(`output ${i}`, "get_jobs"));
    expect(store.get(ids[0])).toBeUndefined();
    expect(store.get(ids[1])).toBe("output 1");
    expect(store.get(ids[32])).toBe("output 32");
    expect(store.list()).toHaveLength(32);
  });

  it("evicts oldest-first until the new entry fits the byte cap", () => {
    const store = createMemoryOutputStore({ entries: 10, bytes: 10 });
    const a = store.put("aaaa", "t");
    const b = store.put("bbbb", "t");
    const c = store.put("cccccc", "t");
    // 4 + 4 + 6 > 10: only a has to go, b and c fit together.
    expect(store.get(a)).toBeUndefined();
    expect(store.list().map((e) => e.id)).toEqual([b, c]);
  });

  it("counts bytes, not characters", () => {
    const store = createMemoryOutputStore({ entries: 10, bytes: 8 });
    const a = store.put("🧬", "t");
    const b = store.put("🧬", "t");
    const c = store.put("é", "t");
    expect(store.list().map((e) => e.bytes)).toEqual([4, 2]);
    expect(store.get(a)).toBeUndefined();
    expect(store.get(b)).toBe("🧬");
    expect(store.get(c)).toBe("é");
  });

  it("keeps an entry larger than the byte cap alone rather than dropping it", () => {
    const store = createMemoryOutputStore({ entries: 10, bytes: 10 });
    const small = store.put("small", "t");
    const big = store.put("x".repeat(50), "get_tool_panel");
    expect(store.get(small)).toBeUndefined();
    expect(store.get(big)).toBe("x".repeat(50));
    expect(store.list()).toEqual([
      { id: big, tool: "get_tool_panel", bytes: 50, at: expect.any(Number) },
    ]);
    const next = store.put("tiny", "t");
    expect(store.list().map((e) => e.id)).toEqual([next]);
  });

  it("lists entries oldest first", () => {
    const store = createMemoryOutputStore();
    const ids = ["one", "two", "three"].map((t) => store.put(t, `tool_${t}`));
    expect(store.list().map((e) => [e.id, e.tool])).toEqual([
      [ids[0], "tool_one"],
      [ids[1], "tool_two"],
      [ids[2], "tool_three"],
    ]);
  });
});

describe("galaxyOutputStore seam", () => {
  it("creates the default ring once and reuses it", () => {
    const store = galaxyOutputStore();
    const id = store.put("kept", "t");
    expect(galaxyOutputStore()).toBe(store);
    expect(galaxyOutputStore().get(id)).toBe("kept");
  });

  it("swaps in an installed store and resets to a fresh ring on null", () => {
    const before = galaxyOutputStore();
    const id = before.put("old", "t");
    const puts: string[] = [];
    const custom: GalaxyOutputStore = {
      put: (text) => (puts.push(text), "custom-id"),
      get: (key) => (key === "custom-id" ? puts.at(-1) : undefined),
      list: () => [],
    };
    setGalaxyOutputStore(custom);
    expect(galaxyOutputStore()).toBe(custom);
    expect(galaxyOutputStore().put("new", "t")).toBe("custom-id");
    expect(galaxyOutputStore().get(id)).toBeUndefined();

    setGalaxyOutputStore(null);
    const fresh = galaxyOutputStore();
    expect(fresh).not.toBe(custom);
    expect(fresh).not.toBe(before);
    expect(fresh.get(id)).toBeUndefined();
    expect(fresh.list()).toEqual([]);
  });
});
