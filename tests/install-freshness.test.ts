import { describe, it, expect } from "vitest";
import { findStaleInstalls, formatStaleReport } from "../scripts/install-freshness.mjs";

// Shape of the two inputs: what the lockfile says a tree should resolve, and
// what is actually on disk. Both are read for real by the script; the pure
// function takes them as arguments so this needs no fixture tree.
const LOCKED = { "@earendil-works/pi-ai": "0.84.1", "@earendil-works/pi-tui": "0.84.1" };

describe("findStaleInstalls", () => {
  it("is quiet when the install matches the lockfile", () => {
    const stale = findStaleInstalls([{ tree: "root", locked: LOCKED, installed: { ...LOCKED } }]);
    expect(stale).toEqual([]);
  });

  it("flags a package installed at the wrong version", () => {
    const stale = findStaleInstalls([
      {
        tree: "root",
        locked: LOCKED,
        installed: { "@earendil-works/pi-ai": "0.78.1", "@earendil-works/pi-tui": "0.78.1" },
      },
    ]);
    expect(stale).toHaveLength(2);
    expect(stale[0]).toMatchObject({
      tree: "root",
      name: "@earendil-works/pi-ai",
      locked: "0.84.1",
      installed: "0.78.1",
    });
  });

  it("flags a package the lockfile expects but nothing installed", () => {
    const stale = findStaleInstalls([
      { tree: "root", locked: LOCKED, installed: { "@earendil-works/pi-ai": "0.84.1" } },
    ]);
    expect(stale).toEqual([
      { tree: "root", name: "@earendil-works/pi-tui", locked: "0.84.1", installed: null },
    ]);
  });

  // A worktree with no app/node_modules at all is not stale -- it is uninstalled,
  // which npm itself reports far more clearly than we could.
  it("skips a tree that has no node_modules", () => {
    expect(findStaleInstalls([{ tree: "app", locked: LOCKED, installed: null }])).toEqual([]);
  });

  it("reports every stale tree, not just the first", () => {
    const stale = findStaleInstalls([
      { tree: "root", locked: LOCKED, installed: { ...LOCKED, "@earendil-works/pi-ai": "0.78.1" } },
      { tree: "app", locked: LOCKED, installed: { ...LOCKED, "@earendil-works/pi-tui": "0.83.0" } },
    ]);
    expect(stale.map((s) => s.tree)).toEqual(["root", "app"]);
  });
});

describe("formatStaleReport", () => {
  const stale = [
    { tree: "root", name: "@earendil-works/pi-ai", locked: "0.84.1", installed: "0.78.1" },
    { tree: "app", name: "@earendil-works/pi-ai", locked: "0.84.1", installed: null },
  ];

  it("names both versions so the skew is obvious", () => {
    const out = formatStaleReport(stale);
    expect(out).toContain("@earendil-works/pi-ai");
    expect(out).toContain("0.78.1");
    expect(out).toContain("0.84.1");
    expect(out).toContain("not installed");
  });

  // The whole point: yesterday cost time because the symptom was 12 unrelated
  // test failures. The message has to hand over the fix.
  it("hands over the exact command to run", () => {
    const out = formatStaleReport(stale);
    expect(out).toContain("npm ci");
    expect(out).toMatch(/app/);
  });

  it("explains the worktree symlink, which is how this usually happens", () => {
    expect(formatStaleReport(stale).toLowerCase()).toContain("worktree");
  });
});
