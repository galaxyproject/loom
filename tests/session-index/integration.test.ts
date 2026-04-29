import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openIndexDb } from "../../extensions/loom/session-index/db";
import { scanSessions } from "../../extensions/loom/session-index/indexer";
import { encodeCwd } from "../../extensions/loom/session-index/cwd";
import {
  searchChat,
  findToolCalls,
  getSessionContext,
} from "../../extensions/loom/session-index/query";

const MALARIA = `\
{"type":"session","version":3,"id":"sess-mal","timestamp":"2026-04-01T10:00:00Z","cwd":"/tmp/malaria-chr6"}
{"type":"message","id":"m1","parentId":null,"timestamp":"2026-04-01T10:00:05Z","message":{"role":"user","content":[{"type":"text","text":"Widen the ISM scan — too many secondary peaks"}]}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-04-01T10:00:10Z","message":{"role":"assistant","content":[{"type":"text","text":"Setting variant_ism_width=600 closes the secondary-cluster gap at chr6:92618200."},{"type":"tool_use","id":"tu1","name":"workflow_set_overrides","input":{"stepId":"ism","overrides":{"variant_ism_width":600}}}]}}
{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-04-01T10:00:15Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":[{"type":"text","text":"overrides recorded"}]}]}}
{"type":"custom","id":"mc","parentId":"m3","timestamp":"2026-04-01T10:00:20Z","customType":"galaxy_analyst_plan","data":{"notebookPath":"/tmp/malaria-chr6/notebook.md"}}
`;

describe("session-index end-to-end", () => {
  let root: string;
  let db: ReturnType<typeof openIndexDb>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "si-e2e-"));
    const cwdDir = path.join(root, encodeCwd("/tmp/malaria-chr6"));
    fs.mkdirSync(cwdDir, { recursive: true });
    fs.writeFileSync(path.join(cwdDir, "sess-mal.jsonl"), MALARIA);
    db = openIndexDb(path.join(root, "idx.db"));
    scanSessions(db, root);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('answers "why did we set variant_ism_width?"', () => {
    // 1. Agent asks via chat_search
    const hits = searchChat(db, { query: "variant_ism_width" });
    expect(hits.length).toBeGreaterThan(0);
    const best = hits[0];

    // 2. Agent pulls context around the top hit
    const ctx = getSessionContext(db, { entry_id: best.entry_id, before: 1, after: 1 });
    const rationale = ctx.find((r) => r.text.includes("secondary-cluster gap"));
    expect(rationale).toBeDefined();

    // 3. Agent also finds the structured tool call
    const calls = findToolCalls(db, { tool_name: "workflow_set_overrides" });
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments).toEqual({ stepId: "ism", overrides: { variant_ism_width: 600 } });
    expect(calls[0].notebook_path).toBe("/tmp/malaria-chr6/notebook.md");
  });
});
