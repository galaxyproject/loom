#!/usr/bin/env node
/**
 * Build `lessons/snapshot.json`: the validated, committed JSON every consumer
 * reads -- the package (the matcher), galaxy-mcp, and the hosted docs-search
 * `lessons` collection.
 *
 *   npm run build:lessons     # validate, build, write snapshot.json
 *   npm run check:lessons     # validate + fail if snapshot.json is out of date
 *
 * Same shape of gate as `sync:skills` / `check:skills`: the generated artifact
 * is committed so consumers get it with no build step, and CI refuses a diff
 * that changed `lessons/` without rebuilding.
 *
 * `built_at` and `source.commit` are provenance, not content, so `--check`
 * reuses the committed values and the only thing it can fail on is a lesson
 * that changed without a rebuild. Staleness is evaluated as of `built_at` for
 * the same reason -- otherwise this gate would start failing on a date, on
 * somebody else's unrelated pull request. Real-time staleness is a warning.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SECTIONS, collectLessonFiles, parseLesson, validateLessonsDir } from "./validate.mjs";

export const LESSONS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(LESSONS_DIR, "..");
export const SNAPSHOT_PATH = path.join(LESSONS_DIR, "snapshot.json");

export const SNAPSHOT_SCHEMA = 1;
export const SNAPSHOT_REPO = "galaxyproject/loom";
export const SNAPSHOT_LICENCE = "CC-BY-4.0";

/** Past the end of its `stale_after` day, in UTC. */
export function isStale(staleAfter, nowMs) {
  const end = Date.parse(`${staleAfter}T23:59:59Z`);
  return Number.isFinite(end) && end < nowMs;
}

/**
 * The exact shape `Date.prototype.toISOString` writes. Anything looser and a
 * hand-edited `built_at` parses to NaN, which silently turns the staleness
 * comparison off.
 */
export function isIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function dedupe(values) {
  return [...new Set(values)];
}

/**
 * One snapshot entry. Every field is copied by name rather than spread, so the
 * key order is deterministic (the drift gate compares bytes) and a frontmatter
 * key the validator would have rejected cannot ride along into the published
 * artifact.
 */
export function toSnapshotLesson(rel, frontmatter, sections) {
  const fm = frontmatter;
  const lesson = {
    id: rel.replace(/\.md$/, ""),
    type: fm.type,
    title: fm.title,
    description: fm.description,
    // The build mirrors stage and formats into tags, so a consumer that only
    // indexes tags (the docs-search collection does) still sees both axes.
    tags: dedupe([...fm.tags, ...fm.stage, ...fm.trigger.formats]),
    status: fm.status,
    generated: { by: fm.generated.by, at: fm.generated.at },
  };
  if (fm.verified !== undefined) {
    lesson.verified = fm.verified.map((v) => ({ by: v.by, at: v.at }));
  }
  lesson.stale_after = fm.stale_after;
  lesson.sources = fm.sources.map((s) => {
    const out = { id: s.id };
    if (s.resource !== undefined) out.resource = s.resource;
    if (s.title !== undefined) out.title = s.title;
    return out;
  });
  lesson.kind = fm.kind;
  lesson.stage = [...fm.stage];
  lesson.trigger = {
    signatures: [...fm.trigger.signatures],
    tools: [...fm.trigger.tools],
    mcp_tools: [...fm.trigger.mcp_tools],
    formats: [...fm.trigger.formats],
    hosts: [...fm.trigger.hosts],
    extensions: [...fm.trigger.extensions],
    step_keywords: [...fm.trigger.step_keywords],
  };
  lesson.cues = fm.cues;
  lesson.applies_to = { versions: fm.applies_to.versions, tested: fm.applies_to.tested };
  lesson.evidence = {
    symptom: fm.evidence.symptom,
    cause: fm.evidence.cause,
    outcome: fm.evidence.outcome,
    method: fm.evidence.method,
  };
  lesson.graduated_to = [...fm.graduated_to];
  lesson.upstream = [...fm.upstream];
  lesson.supersedes = [...fm.supersedes];
  lesson.sections = {};
  for (const spec of SECTIONS) {
    if (sections[spec.key] !== undefined) lesson.sections[spec.key] = sections[spec.key];
  }
  return lesson;
}

/**
 * Build the snapshot object. `nowMs` defaults to `builtAt` so a build and a
 * later `--check` of the same bytes agree.
 */
export function buildSnapshot({ dir = LESSONS_DIR, builtAt, commit, nowMs } = {}) {
  if (!isIsoTimestamp(builtAt)) {
    throw new Error(`built_at must be an ISO timestamp (got ${JSON.stringify(builtAt)})`);
  }
  const asOf = nowMs ?? Date.parse(builtAt);
  const lessons = [];
  const skipped = [];
  for (const rel of collectLessonFiles(dir)) {
    const { frontmatter, sections } = parseLesson(fs.readFileSync(path.join(dir, rel), "utf8"));
    const id = rel.replace(/\.md$/, "");
    if (frontmatter.status === "deprecated") {
      skipped.push({ id, why: "status: deprecated" });
      continue;
    }
    if (isStale(frontmatter.stale_after, asOf)) {
      skipped.push({ id, why: `past stale_after ${frontmatter.stale_after}` });
      continue;
    }
    lessons.push(toSnapshotLesson(rel, frontmatter, sections));
  }
  const snapshot = {
    schema: SNAPSHOT_SCHEMA,
    built_at: builtAt,
    source: { repo: SNAPSHOT_REPO, commit },
    licence: SNAPSHOT_LICENCE,
    lessons,
  };
  return { snapshot, skipped };
}

export function serializeSnapshot(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/** First differing line of two serialized snapshots, as printable lines. */
export function firstDiff(committed, rebuilt) {
  const a = committed.split("\n");
  const b = rebuilt.split("\n");
  const trunc = (s) =>
    s === undefined ? "<end of file>" : s.length > 120 ? `${s.slice(0, 117)}...` : s;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    return [
      `first difference at line ${i + 1}:`,
      `committed: ${trunc(a[i])}`,
      `rebuilt:   ${trunc(b[i])}`,
    ];
  }
  return ["the two serializations differ in length only"];
}

/**
 * The commit the corpus was read at. This is HEAD at build time, so it names
 * the commit before the one that lands the snapshot -- which is the honest
 * answer to "what was on disk when this was built".
 */
function headCommit(repoRoot) {
  const run = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  const sha = run.status === 0 ? run.stdout.trim() : "";
  return /^[0-9a-f]{40}$/.test(sha) ? sha : "unknown";
}

function reportViolations(label, violations) {
  console.error(`${label} FAILED -- ${violations.length} schema violation(s)`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

function build() {
  const violations = validateLessonsDir(LESSONS_DIR);
  if (violations.length > 0) reportViolations("build:lessons", violations);

  const builtAt = process.env.LESSONS_BUILT_AT ?? new Date().toISOString();
  const commit = process.env.LESSONS_COMMIT ?? headCommit(REPO_ROOT);
  const { snapshot, skipped } = buildSnapshot({ builtAt, commit });
  if (snapshot.lessons.length === 0) {
    console.error("build:lessons FAILED -- every lesson was skipped, the snapshot would be empty");
    for (const s of skipped) console.error(`  ${s.id}: ${s.why}`);
    process.exit(1);
  }
  fs.writeFileSync(SNAPSHOT_PATH, serializeSnapshot(snapshot));
  console.log(`build:lessons OK -- ${snapshot.lessons.length} lesson(s) in lessons/snapshot.json`);
  for (const s of skipped) console.log(`  left out ${s.id} (${s.why})`);
}

/**
 * The drift gate as a function, so it can be exercised against any corpus.
 * `failure` is the lines to print when it fails; `warnings` never fail it.
 */
export function checkSnapshot({
  dir = LESSONS_DIR,
  snapshotPath = SNAPSHOT_PATH,
  nowMs = Date.now(),
} = {}) {
  const violations = validateLessonsDir(dir);
  if (violations.length > 0) {
    return {
      ok: false,
      failure: [
        `check:lessons FAILED -- ${violations.length} schema violation(s)`,
        ...violations.map((v) => `  ${v}`),
      ],
    };
  }
  if (!fs.existsSync(snapshotPath)) {
    return {
      ok: false,
      failure: [
        "check:lessons FAILED -- lessons/snapshot.json is missing",
        "\nRun `npm run build:lessons` and commit the result.",
      ],
    };
  }
  const committedText = fs.readFileSync(snapshotPath, "utf8").replace(/\r\n/g, "\n");
  let committed;
  try {
    committed = JSON.parse(committedText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      failure: [`check:lessons FAILED -- lessons/snapshot.json is not valid JSON: ${message}`],
    };
  }
  const builtAt = committed?.built_at;
  if (!isIsoTimestamp(builtAt)) {
    return {
      ok: false,
      failure: [
        `check:lessons FAILED -- lessons/snapshot.json built_at is not an ISO timestamp (got ${JSON.stringify(builtAt)})`,
        "\nRun `npm run build:lessons` and commit lessons/snapshot.json.",
      ],
    };
  }
  const commit = typeof committed?.source?.commit === "string" ? committed.source.commit : "";
  const { snapshot } = buildSnapshot({ dir, builtAt, commit });
  const rebuilt = serializeSnapshot(snapshot);
  if (rebuilt !== committedText) {
    return {
      ok: false,
      failure: [
        "check:lessons FAILED -- lessons/snapshot.json does not match lessons/",
        ...firstDiff(committedText, rebuilt).map((line) => `  ${line}`),
        "\nRun `npm run build:lessons` and commit lessons/snapshot.json.",
      ],
    };
  }

  // Not fatal: a lesson that has aged out should be re-verified or dropped
  // deliberately, and a date is a bad reason to turn somebody else's CI red.
  const warnings = snapshot.lessons
    .filter((l) => isStale(l.stale_after, nowMs))
    .map(
      (l) =>
        `  warning: ${l.id} is past stale_after ${l.stale_after} -- re-verify it, or rebuild to drop it`,
    );
  return { ok: true, count: snapshot.lessons.length, warnings };
}

function check() {
  const result = checkSnapshot();
  if (!result.ok) {
    for (const line of result.failure) console.error(line);
    process.exit(1);
  }
  for (const w of result.warnings) console.warn(w);
  console.log(`check:lessons OK -- ${result.count} lesson(s) match lessons/snapshot.json`);
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    console.error(`usage: build-snapshot.mjs [--check] (got ${args.join(" ")})`);
    process.exit(2);
  }
  try {
    if (args[0] === "--check") check();
    else build();
  } catch (err) {
    console.error(`lessons/build-snapshot: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
