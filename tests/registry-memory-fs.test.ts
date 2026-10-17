import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { RegistryStore } from "../extensions/loom/registry";
import { memoryRegistryFs } from "../extensions/loom/registry-memory-fs";
import { closeSessionRegistry, openSessionRegistry } from "../extensions/loom/registry-runtime";
import { profileFromEnv, setCapabilityProfile } from "../shared/capability-profile.js";
import { eligibleAttempt, SERVER, T0, tmpAnalysisDir } from "./registry-fixtures";

const clock = () => T0;
// registry.ts builds its paths with path.join, so on Windows the Map keys carry backslashes.
const STATE = (name: string) => path.join("/analysis", ".loom", "state", name);

function store(fsLike: ReturnType<typeof memoryRegistryFs>, sessionId = "s-a", pid = 100) {
  return new RegistryStore({
    analysisDir: "/analysis",
    serverUrl: SERVER,
    sessionId,
    fs: fsLike,
    clock,
    pid,
  });
}

describe("memoryRegistryFs", () => {
  it("opens as the writer, persists an update, and hands it to the next store on the same Map", () => {
    const mem = memoryRegistryFs();
    const first = store(mem);
    expect(first.open()).toEqual({ kind: "empty" });
    expect(first.mode).toBe("writer");
    const attempt = eligibleAttempt();
    first.update((r) => {
      r.attempts[attempt.attempt_id] = attempt;
    });
    expect(mem.files.has(STATE("registry.json"))).toBe(true);
    expect(mem.files.has(STATE("lock"))).toBe(true);
    // No temp file survives the atomic write.
    expect([...mem.files.keys()].filter((k) => k.endsWith(".tmp"))).toEqual([]);
    first.close();
    expect(mem.files.has(STATE("lock"))).toBe(false);

    const second = store(mem, "s-b", 101);
    expect(second.open().kind).toBe("imported");
    expect(second.mode).toBe("writer");
    expect(Object.keys(second.snapshot().attempts)).toEqual([attempt.attempt_id]);
    second.close();
  });

  it("opens read-only while another store holds the lock on the same Map", () => {
    const mem = memoryRegistryFs();
    const first = store(mem);
    first.open();
    const second = store(mem, "s-b", 101);
    second.open();
    expect(second.mode).toBe("read-only");
    expect(second.notices.join(" ")).toContain("s-a");
    second.close();
    // A read-only store's close leaves the writer's lock alone.
    expect(mem.files.has(STATE("lock"))).toBe(true);
    first.close();
  });

  it("answers the fs errors the store reads the code of", () => {
    const mem = memoryRegistryFs();
    expect(() => mem.readFileSync("/none", "utf-8")).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
    mem.writeFileSync("/a", "x", { flag: "wx" });
    expect(() => mem.writeFileSync("/a", "y", { flag: "wx" })).toThrow(
      expect.objectContaining({ code: "EEXIST" }),
    );
    mem.writeFileSync("/a", "z");
    expect(mem.readFileSync("/a", "utf-8")).toBe("z");
    expect(() => mem.unlinkSync("/none")).toThrow(expect.objectContaining({ code: "ENOENT" }));
    mem.mkdirSync("/dir", { recursive: true });
    expect(mem.existsSync("/dir")).toBe(true);
  });
});

describe("session registry under a page notebook", () => {
  let dir: string;
  afterEach(() => {
    closeSessionRegistry();
    setCapabilityProfile(null);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("opens as the writer in memory and creates nothing under the analysis dir", () => {
    dir = tmpAnalysisDir();
    setCapabilityProfile({ ...profileFromEnv({}), notebook: "page" });
    const { session, outcome, notice } = openSessionRegistry({
      analysisDir: dir,
      sessionId: "s-page",
      serverUrl: SERVER,
      heartbeatMs: null,
    });
    expect(session.store.mode).toBe("writer");
    expect(outcome).toEqual({ kind: "empty" });
    expect(notice).toBeNull();
    expect(fs.existsSync(path.join(dir, ".loom"))).toBe(false);
  });

  it("keeps two records' registries apart on the one Map", () => {
    dir = tmpAnalysisDir();
    setCapabilityProfile({ ...profileFromEnv({}), notebook: "page" });
    const attempt = eligibleAttempt();
    openSessionRegistry({
      analysisDir: path.join(dir, "p1"),
      sessionId: "s-1",
      serverUrl: SERVER,
      heartbeatMs: null,
    }).session.store.update((r) => {
      r.attempts[attempt.attempt_id] = attempt;
    });
    const other = openSessionRegistry({
      analysisDir: path.join(dir, "p2"),
      sessionId: "s-2",
      serverUrl: SERVER,
      heartbeatMs: null,
    });
    expect(other.session.store.mode).toBe("writer");
    expect(other.outcome).toEqual({ kind: "empty" });
    expect(Object.keys(other.session.store.snapshot().attempts)).toEqual([]);
    const back = openSessionRegistry({
      analysisDir: path.join(dir, "p1"),
      sessionId: "s-3",
      serverUrl: SERVER,
      heartbeatMs: null,
    });
    expect(Object.keys(back.session.store.snapshot().attempts)).toEqual([attempt.attempt_id]);
  });

  it("reopens what the first session wrote, since the Map outlives the store", () => {
    dir = tmpAnalysisDir();
    setCapabilityProfile({ ...profileFromEnv({}), notebook: "page" });
    const attempt = eligibleAttempt();
    openSessionRegistry({
      analysisDir: dir,
      sessionId: "s-1",
      serverUrl: SERVER,
      heartbeatMs: null,
    }).session.store.update((r) => {
      r.attempts[attempt.attempt_id] = attempt;
    });
    const again = openSessionRegistry({
      analysisDir: dir,
      sessionId: "s-2",
      serverUrl: SERVER,
      heartbeatMs: null,
    });
    expect(again.session.store.mode).toBe("writer");
    expect(Object.keys(again.session.store.snapshot().attempts)).toEqual([attempt.attempt_id]);
    expect(fs.existsSync(path.join(dir, ".loom"))).toBe(false);
  });
});
