import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openIndexDb } from "../../extensions/loom/session-index/db";
import { scanSessions } from "../../extensions/loom/session-index/indexer";
import { encodeCwd } from "../../extensions/loom/session-index/cwd";
import {
  searchChat,
  getSessionContext,
  findToolCalls,
} from "../../extensions/loom/session-index/query";

function seed(sessionsDir: string, cwd: string, fileName: string, body: string) {
  const d = path.join(sessionsDir, encodeCwd(cwd));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, fileName), body);
}

describe("session-index query API", () => {
  let dir: string;
  let db: ReturnType<typeof openIndexDb>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-index-query-"));
    seed(
      dir,
      "/tmp/malaria",
      "sess-1.jsonl",
      `\
{"type":"session","version":3,"id":"sess-1","timestamp":"2026-04-01T10:00:00Z","cwd":"/tmp/malaria"}
{"type":"message","id":"m1","parentId":null,"timestamp":"2026-04-01T10:00:05Z","message":{"role":"user","content":[{"type":"text","text":"Tune variant_ism_width for malaria chr6"}]}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-04-01T10:00:10Z","message":{"role":"assistant","content":[{"type":"text","text":"Set variant_ism_width=600 to widen the scan."},{"type":"tool_use","id":"tu1","name":"workflow_set_overrides","input":{"stepId":"ism","overrides":{"variant_ism_width":600}}}]}}
{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-04-01T10:00:15Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":[{"type":"text","text":"overrides recorded"}]}]}}
`,
    );
    seed(
      dir,
      "/tmp/hiv",
      "sess-2.jsonl",
      `\
{"type":"session","version":3,"id":"sess-2","timestamp":"2026-04-02T09:00:00Z","cwd":"/tmp/hiv"}
{"type":"message","id":"h1","parentId":null,"timestamp":"2026-04-02T09:00:05Z","message":{"role":"user","content":[{"type":"text","text":"Run HIV locus analysis"}]}}
`,
    );
    db = openIndexDb(path.join(dir, "idx.db"));
    scanSessions(db, dir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("searches across all sessions by default", () => {
    const hits = searchChat(db, { query: "variant_ism_width" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].cwd).toBe("/tmp/malaria");
    expect(hits[0].snippet.toLowerCase()).toContain("variant_ism_width");
  });

  it("scope='cwd' filters to the given directory", () => {
    const hits = searchChat(db, { query: "analysis", scope: "cwd", cwd: "/tmp/hiv" });
    expect(hits.every((h) => h.cwd === "/tmp/hiv")).toBe(true);
    expect(hits.some((h) => h.cwd === "/tmp/malaria")).toBe(false);
  });

  it("returns a window of entries around an anchor", () => {
    const ctx = getSessionContext(db, { entry_id: "m2", before: 1, after: 1 });
    expect(ctx.map((e) => e.entry_id)).toEqual(["m1", "m2", "m3"]);
  });

  it("finds tool calls by name with args_contains filter", () => {
    const calls = findToolCalls(db, { tool_name: "workflow_set_overrides" });
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments).toEqual({ stepId: "ism", overrides: { variant_ism_width: 600 } });

    const empty = findToolCalls(db, {
      tool_name: "workflow_set_overrides",
      args_contains: "neuroblastoma",
    });
    expect(empty).toHaveLength(0);

    const match = findToolCalls(db, {
      tool_name: "workflow_set_overrides",
      args_contains: "variant_ism_width",
    });
    expect(match).toHaveLength(1);
  });

  it("respects the limit parameter", () => {
    const hits = searchChat(db, { query: "malaria OR HIV OR analysis OR variant", limit: 1 });
    expect(hits).toHaveLength(1);
  });

  it("includes timestamp-tied entries in the context window", () => {
    // Create a fresh scenario with three entries sharing a timestamp.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "session-index-tie-"));
    seed(
      tmp,
      "/tmp/tie",
      "sess-tie.jsonl",
      `\
{"type":"session","version":3,"id":"sess-tie","timestamp":"2026-04-05T10:00:00Z","cwd":"/tmp/tie"}
{"type":"message","id":"a","parentId":null,"timestamp":"2026-04-05T10:00:05Z","message":{"role":"user","content":[{"type":"text","text":"a"}]}}
{"type":"message","id":"b","parentId":"a","timestamp":"2026-04-05T10:00:10Z","message":{"role":"assistant","content":[{"type":"text","text":"b"}]}}
{"type":"message","id":"c","parentId":"b","timestamp":"2026-04-05T10:00:10Z","message":{"role":"user","content":[{"type":"text","text":"c"}]}}
{"type":"message","id":"d","parentId":"c","timestamp":"2026-04-05T10:00:10Z","message":{"role":"assistant","content":[{"type":"text","text":"d"}]}}
{"type":"message","id":"e","parentId":"d","timestamp":"2026-04-05T10:00:15Z","message":{"role":"user","content":[{"type":"text","text":"e"}]}}
`,
    );
    const db2 = openIndexDb(path.join(tmp, "idx.db"));
    scanSessions(db2, tmp);
    const ctx = getSessionContext(db2, { entry_id: "c", before: 5, after: 5 });
    expect(ctx.map((e) => e.entry_id)).toEqual(["a", "b", "c", "d", "e"]);
    db2.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("treats LIKE wildcards in args_contains as literals", () => {
    // variant_ism_width should match literally -- NOT match variantxismxwidth.
    // Seed a second tool call whose args contain 'variantxismxwidth' (underscores replaced).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "session-index-like-"));
    seed(
      tmp,
      "/tmp/like",
      "sess-like.jsonl",
      `\
{"type":"session","version":3,"id":"sess-like","timestamp":"2026-04-05T10:00:00Z","cwd":"/tmp/like"}
{"type":"message","id":"x1","parentId":null,"timestamp":"2026-04-05T10:00:05Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tux","name":"workflow_set_overrides","input":{"key":"variantxismxwidth","value":600}}]}}
`,
    );
    const db2 = openIndexDb(path.join(tmp, "idx.db"));
    scanSessions(db2, tmp);
    const match = findToolCalls(db2, {
      tool_name: "workflow_set_overrides",
      args_contains: "variant_ism_width",
    });
    expect(match).toHaveLength(0); // underscore is literal, not a wildcard
    const literalMatch = findToolCalls(db2, {
      tool_name: "workflow_set_overrides",
      args_contains: "variantxismxwidth",
    });
    expect(literalMatch).toHaveLength(1);
    db2.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
