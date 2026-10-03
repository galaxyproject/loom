/**
 * `lessons/snapshot.json` is what every consumer actually reads -- the
 * matcher, galaxy-mcp, the hosted `lessons` collection -- and it is committed,
 * so these tests cover both the transform and the drift gate that keeps the
 * committed bytes honest.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectLessonFiles, parseLesson, validateLessonsDir } from "../lessons/validate.mjs";
import {
  SNAPSHOT_LICENCE,
  SNAPSHOT_REPO,
  SNAPSHOT_SCHEMA,
  buildSnapshot,
  checkSnapshot,
  isStale,
  serializeSnapshot,
} from "../lessons/build-snapshot.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CORPUS = join(REPO_ROOT, "lessons");
const SCRIPT = join(CORPUS, "build-snapshot.mjs");
const SNAPSHOT = join(CORPUS, "snapshot.json");
// The transform and the drift gate are tested against a corpus of their own.
// Against the live one, the first lesson anybody retires would turn CI red.
// It holds a deprecated lesson so the "left out" path is always exercised.
const FIXTURE = join(REPO_ROOT, "tests", "fixtures", "lessons");

// Fixed so a test never depends on the clock.
const BUILT_AT = "2026-09-30T00:00:00.000Z";
const COMMIT = "0".repeat(40);

const build = () => buildSnapshot({ dir: FIXTURE, builtAt: BUILT_AT, commit: COMMIT });

let temps: string[] = [];
afterEach(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  temps = [];
});

/** A throwaway corpus holding copies of one real lesson, each patched. */
function corpusOf(patches: Record<string, (text: string) => string>): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-snapshot-"));
  temps.push(dir);
  mkdirSync(join(dir, "stats"), { recursive: true });
  const base = readFileSync(join(FIXTURE, "stats", "na-coerced-to-zero-in-filters.md"), "utf8");
  for (const [slug, patch] of Object.entries(patches)) {
    writeFileSync(join(dir, "stats", `${slug}.md`), patch(base), "utf8");
  }
  return dir;
}

describe("the fixture corpus", () => {
  it("validates clean, so a failure below is about the snapshot and not the lessons", () => {
    expect(validateLessonsDir(FIXTURE)).toEqual([]);
  });
});

describe("the snapshot envelope", () => {
  it("carries the schema, licence and source the contract names", () => {
    const { snapshot } = build();
    expect(snapshot.schema).toBe(SNAPSHOT_SCHEMA);
    expect(snapshot.schema).toBe(1);
    expect(snapshot.licence).toBe(SNAPSHOT_LICENCE);
    expect(snapshot.licence).toBe("CC-BY-4.0");
    expect(snapshot.source).toEqual({ repo: SNAPSHOT_REPO, commit: COMMIT });
    expect(snapshot.source.repo).toBe("galaxyproject/loom");
    expect(snapshot.built_at).toBe(BUILT_AT);
  });

  it("holds one entry per lesson file it keeps, keyed by its path", () => {
    const { snapshot, skipped } = build();
    expect(snapshot.lessons.map((l: { id: string }) => l.id)).toEqual([
      "galaxy-api/hid-is-not-an-id",
      "stats/na-coerced-to-zero-in-filters",
    ]);
    expect(skipped).toEqual([
      { id: "data/downloaded-file-is-not-what-its-extension-says", why: "status: deprecated" },
    ]);
  });

  it("serializes as 2-space JSON with a trailing newline", () => {
    const text = serializeSnapshot(build().snapshot);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "schema": 1,');
  });

  it("is byte-stable across two builds of the same corpus", () => {
    expect(serializeSnapshot(build().snapshot)).toBe(serializeSnapshot(build().snapshot));
  });
});

describe("the frontmatter round-trip", () => {
  // The acceptance bar for this chunk: every C3 field reaches the snapshot
  // under the same name with the same shape, checked against the file rather
  // than against a hand-written expectation that can drift from it.
  it("carries every frontmatter field and every section through unchanged", () => {
    const { snapshot } = build();
    for (const rel of collectLessonFiles(FIXTURE)) {
      const { frontmatter, sections } = parseLesson(readFileSync(join(FIXTURE, rel), "utf8"));
      if (frontmatter.status === "deprecated") continue;
      const id = rel.replace(/\.md$/, "");
      const entry = snapshot.lessons.find((l: { id: string }) => l.id === id);
      expect(entry, `${id} is missing from the snapshot`).toBeDefined();
      for (const [key, value] of Object.entries(frontmatter)) {
        if (key === "tags") {
          // The build adds stage and formats to the authored tags.
          expect(entry.tags, `${id}.tags`).toEqual(expect.arrayContaining(value as string[]));
          continue;
        }
        expect(entry[key], `${id}.${key}`).toEqual(value);
      }
      expect(entry.sections, `${id}.sections`).toEqual(sections);
    }
  });

  it("mirrors stage and formats into tags", () => {
    const { snapshot } = build();
    const lesson = snapshot.lessons.find(
      (l: { id: string }) => l.id === "stats/na-coerced-to-zero-in-filters",
    );
    expect(lesson.tags).toContain("result-interpretation");
    expect(lesson.tags).toContain("tabular");
    expect(new Set(lesson.tags).size).toBe(lesson.tags.length);
  });

  it("drops nothing and adds nothing to the trigger lists", () => {
    const { snapshot } = build();
    const lesson = snapshot.lessons.find(
      (l: { id: string }) => l.id === "galaxy-api/hid-is-not-an-id",
    );
    expect(lesson.trigger.signatures).toEqual([
      "Invalid id length, must be multiple of 16",
      "Required parameter(s) kwd not provided",
    ]);
    expect(lesson.trigger.mcp_tools).toEqual(["galaxy_get_dataset_details", "galaxy_run_tool"]);
  });
});

describe("what is left out", () => {
  it("leaves out a deprecated lesson", () => {
    const dir = corpusOf({
      keeper: (t) => t,
      gone: (t) => t.replace("status: draft", "status: deprecated"),
    });
    const { snapshot, skipped } = buildSnapshot({ dir, builtAt: BUILT_AT, commit: COMMIT });
    expect(snapshot.lessons.map((l: { id: string }) => l.id)).toEqual(["stats/keeper"]);
    expect(skipped).toEqual([{ id: "stats/gone", why: "status: deprecated" }]);
  });

  it("leaves out a lesson past its stale_after", () => {
    const dir = corpusOf({
      keeper: (t) => t,
      old: (t) => t.replace('stale_after: "2027-03-31"', 'stale_after: "2020-01-01"'),
    });
    const { snapshot, skipped } = buildSnapshot({ dir, builtAt: BUILT_AT, commit: COMMIT });
    expect(snapshot.lessons.map((l: { id: string }) => l.id)).toEqual(["stats/keeper"]);
    expect(skipped).toEqual([{ id: "stats/old", why: "past stale_after 2020-01-01" }]);
  });

  // Staleness is judged as of `built_at`, not the wall clock, or the drift gate
  // would start failing on a date rather than on a change.
  it("judges staleness as of built_at", () => {
    const dir = corpusOf({ keeper: (t) => t.replace('"2027-03-31"', '"2026-06-01"') });
    const early = buildSnapshot({ dir, builtAt: "2026-01-01T00:00:00.000Z", commit: COMMIT });
    const late = buildSnapshot({ dir, builtAt: "2026-12-01T00:00:00.000Z", commit: COMMIT });
    expect(early.snapshot.lessons).toHaveLength(1);
    expect(late.snapshot.lessons).toHaveLength(0);
  });

  it("treats the stale_after day itself as still fresh", () => {
    expect(isStale("2026-06-01", Date.parse("2026-06-01T12:00:00Z"))).toBe(false);
    expect(isStale("2026-06-01", Date.parse("2026-06-02T00:00:00Z"))).toBe(true);
  });
});

describe("the committed snapshot", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: "utf8" });

  it("is exactly what the corpus builds", () => {
    const committedText = readFileSync(SNAPSHOT, "utf8").replace(/\r\n/g, "\n");
    const committed = JSON.parse(committedText);
    const { snapshot } = buildSnapshot({
      builtAt: committed.built_at,
      commit: committed.source.commit,
    });
    expect(serializeSnapshot(snapshot)).toBe(committedText);
  });

  it("passes the drift gate", () => {
    const result = run("--check");
    // Not an empty-stderr assertion: a lesson past stale_after warns there, and
    // that must not turn into a test failure on a date.
    expect(result.stderr).not.toContain("FAILED");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("check:lessons OK");
  });

  it("exits 2 on bad arguments", () => {
    expect(run("--nope").status).toBe(2);
  });
});

describe("the drift gate on a corpus of its own", () => {
  /** A corpus plus a snapshot built from it, ready to be tampered with. */
  function builtCorpus(): { dir: string; snapshotPath: string } {
    const dir = corpusOf({ keeper: (t) => t });
    const snapshotPath = join(dir, "snapshot.json");
    const { snapshot } = buildSnapshot({ dir, builtAt: BUILT_AT, commit: COMMIT });
    writeFileSync(snapshotPath, serializeSnapshot(snapshot), "utf8");
    return { dir, snapshotPath };
  }
  const NOW = Date.parse("2026-10-01T00:00:00Z");

  it("passes when the snapshot matches", () => {
    const { dir, snapshotPath } = builtCorpus();
    expect(checkSnapshot({ dir, snapshotPath, nowMs: NOW })).toMatchObject({ ok: true, count: 1 });
  });

  it("fails when a lesson changed without a rebuild, and says where", () => {
    const { dir, snapshotPath } = builtCorpus();
    const lesson = join(dir, "stats", "keeper.md");
    writeFileSync(
      lesson,
      readFileSync(lesson, "utf8").replace("Nothing errors.", "Nothing errors at all."),
    );
    const result = checkSnapshot({ dir, snapshotPath, nowMs: NOW });
    expect(result.ok).toBe(false);
    expect(result.failure.join("\n")).toMatch(/does not match[\s\S]*Nothing errors at all\./);
  });

  it("fails when a lesson was added without a rebuild", () => {
    const { dir, snapshotPath } = builtCorpus();
    const base = readFileSync(join(dir, "stats", "keeper.md"), "utf8");
    writeFileSync(join(dir, "stats", "another.md"), base);
    expect(checkSnapshot({ dir, snapshotPath, nowMs: NOW }).ok).toBe(false);
  });

  it("fails on a schema violation before it looks at the snapshot", () => {
    const { dir, snapshotPath } = builtCorpus();
    const lesson = join(dir, "stats", "keeper.md");
    writeFileSync(lesson, readFileSync(lesson, "utf8").replace("type: Lesson", "type: Note"));
    const result = checkSnapshot({ dir, snapshotPath, nowMs: NOW });
    expect(result.failure.join("\n")).toMatch(/schema violation[\s\S]*type must be exactly/);
  });

  it("fails on a hand-edited snapshot", () => {
    const { dir, snapshotPath } = builtCorpus();
    writeFileSync(snapshotPath, readFileSync(snapshotPath, "utf8").replace('"draft"', '"stable"'));
    expect(checkSnapshot({ dir, snapshotPath, nowMs: NOW }).ok).toBe(false);
  });

  // A NaN date would silently turn the staleness comparison off.
  it.each([["not-a-date"], ["2026-09-30"], ["2026-02-30T00:00:00.000Z"], [null]])(
    "fails on a hand-edited built_at of %j",
    (value) => {
      const { dir, snapshotPath } = builtCorpus();
      const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
      snapshot.built_at = value;
      writeFileSync(snapshotPath, serializeSnapshot(snapshot));
      const result = checkSnapshot({ dir, snapshotPath, nowMs: NOW });
      expect(result.ok).toBe(false);
      expect(result.failure.join("\n")).toMatch(/built_at is not an ISO timestamp/);
    },
  );

  it("refuses to build with a built_at that is not an ISO timestamp", () => {
    const { dir } = builtCorpus();
    expect(() => buildSnapshot({ dir, builtAt: "not-a-date", commit: COMMIT })).toThrow(
      /built_at must be an ISO timestamp/,
    );
  });

  it("only warns about a lesson that went stale after the build", () => {
    const { dir, snapshotPath } = builtCorpus();
    const later = Date.parse("2028-01-01T00:00:00Z");
    const result = checkSnapshot({ dir, snapshotPath, nowMs: later });
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/stats\/keeper is past stale_after/);
  });
});

describe("the optional fields", () => {
  // No committed lesson uses these yet, so without this nothing exercises how
  // the build copies them.
  it("carries verified, sources.resource and sources.title through", () => {
    const dir = corpusOf({
      full: (t) =>
        t
          .replace(
            "stale_after:",
            'verified:\n  - { by: "human:reviewer-one", at: "2026-09-30" }\nstale_after:',
          )
          .replace(
            /sources:\n {2}- \{ id: "([^"]+)" \}/,
            'sources:\n  - { id: "$1", resource: "https://github.com/galaxyproject/loom/issues/355", title: "the original report" }',
          ),
    });
    expect(validateLessonsDir(dir)).toEqual([]);
    const { snapshot } = buildSnapshot({ dir, builtAt: BUILT_AT, commit: COMMIT });
    const [lesson] = snapshot.lessons;
    expect(lesson.verified).toEqual([{ by: "human:reviewer-one", at: "2026-09-30" }]);
    expect(lesson.sources[0]).toEqual({
      id: expect.any(String),
      resource: "https://github.com/galaxyproject/loom/issues/355",
      title: "the original report",
    });
  });
});
