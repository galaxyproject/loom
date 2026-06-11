import { describe, it, expect } from "vitest";
import {
  renderSessionSummaryYaml,
  appendSessionSummaryBlock,
  upsertSessionSummaryBlock,
  findSessionSummaryBlocks,
  type SessionSummaryYaml,
} from "../extensions/loom/notebook-writer";

const sample: SessionSummaryYaml = {
  id: "sess_abc123",
  startedAt: "2026-05-08T19:30:00Z",
  endedAt: "2026-05-08T20:15:42Z",
  notebook: "notebook.md",
  orphanedActiveSteps: 0,
};

describe("renderSessionSummaryYaml", () => {
  it("emits a fenced loom-session block with all required fields", () => {
    const out = renderSessionSummaryYaml(sample);
    expect(out).toContain("```loom-session");
    expect(out).toContain("id: sess_abc123");
    expect(out).toContain("started_at: 2026-05-08T19:30:00Z");
    expect(out).toContain("ended_at: 2026-05-08T20:15:42Z");
    expect(out).toContain("notebook: notebook.md");
    expect(out).toContain("orphaned_active_steps: 0");
    expect(out.endsWith("```\n")).toBe(true);
  });
});

describe("appendSessionSummaryBlock", () => {
  it("appends to a non-empty notebook with a separating blank line", () => {
    const before = "# notebook\n\nsome content here\n";
    const out = appendSessionSummaryBlock(before, sample);
    expect(out.startsWith("# notebook\n\nsome content here\n\n```loom-session\n")).toBe(true);
    expect(out.endsWith("```\n")).toBe(true);
  });

  it("appends to an empty notebook without a leading blank line", () => {
    const out = appendSessionSummaryBlock("", sample);
    expect(out.startsWith("```loom-session\n")).toBe(true);
  });

  it("preserves prior session blocks (sessions are append-only)", () => {
    const earlier: SessionSummaryYaml = {
      ...sample,
      id: "sess_earlier",
      endedAt: "2026-05-08T18:00:00Z",
    };
    const intermediate = appendSessionSummaryBlock("# notebook\n", earlier);
    const final = appendSessionSummaryBlock(intermediate, sample);
    const blocks = findSessionSummaryBlocks(final);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].id).toBe("sess_earlier");
    expect(blocks[1].id).toBe("sess_abc123");
  });
});

describe("upsertSessionSummaryBlock", () => {
  it("appends a new id like append does (first finalize of a session)", () => {
    const out = upsertSessionSummaryBlock("# notebook\n", sample);
    const blocks = findSessionSummaryBlocks(out);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual(sample);
  });

  it("keeps distinct sessions as separate blocks (chronological log)", () => {
    const earlier: SessionSummaryYaml = {
      ...sample,
      id: "sess_earlier",
      endedAt: "2026-05-08T18:00:00Z",
    };
    let content = upsertSessionSummaryBlock("# nb\n", earlier);
    content = upsertSessionSummaryBlock(content, sample);
    const blocks = findSessionSummaryBlocks(content);
    expect(blocks.map((b) => b.id)).toEqual(["sess_earlier", "sess_abc123"]);
  });

  // Regression for #260: a resumed session reuses Pi's session id, so a
  // second shutdown must continue the existing block, not append a duplicate.
  it("collapses a resumed session (same id, later finalize) into one block", () => {
    const first: SessionSummaryYaml = {
      id: "019eb2a6-2ecf-7122-af63-062e8b20b1c7",
      startedAt: "2026-06-10T17:48:17.761Z",
      endedAt: "2026-06-10T18:37:04.364Z",
      notebook: "notebook.md",
      orphanedActiveSteps: 0,
    };
    const resumed: SessionSummaryYaml = {
      ...first,
      startedAt: "2026-06-10T18:37:06.035Z",
      endedAt: "2026-06-10T18:37:14.913Z",
    };
    let content = upsertSessionSummaryBlock("# nb\n", first);
    content = upsertSessionSummaryBlock(content, resumed);
    const blocks = findSessionSummaryBlocks(content);
    expect(blocks).toHaveLength(1);
    // The single block spans the session id's full lifetime: earliest start,
    // latest end.
    expect(blocks[0].id).toBe("019eb2a6-2ecf-7122-af63-062e8b20b1c7");
    expect(blocks[0].startedAt).toBe("2026-06-10T17:48:17.761Z");
    expect(blocks[0].endedAt).toBe("2026-06-10T18:37:14.913Z");
  });

  it("never widens the window the wrong way when finalizes arrive out of order", () => {
    const later: SessionSummaryYaml = {
      ...sample,
      startedAt: "2026-05-08T19:30:00Z",
      endedAt: "2026-05-08T20:15:42Z",
    };
    const earlierFinalize: SessionSummaryYaml = {
      ...sample,
      startedAt: "2026-05-08T19:30:00Z",
      endedAt: "2026-05-08T19:45:00Z",
    };
    let content = upsertSessionSummaryBlock("# nb\n", later);
    content = upsertSessionSummaryBlock(content, earlierFinalize);
    const blocks = findSessionSummaryBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].endedAt).toBe("2026-05-08T20:15:42Z");
  });

  it("self-heals a notebook already corrupted with same-id duplicates", () => {
    const id = "019eb2a6-2ecf-7122-af63-062e8b20b1c7";
    const a = { ...sample, id, startedAt: "2026-05-08T10:00:00Z", endedAt: "2026-05-08T10:30:00Z" };
    const b = { ...sample, id, startedAt: "2026-05-08T10:30:02Z", endedAt: "2026-05-08T10:30:11Z" };
    // Simulate a notebook written by the pre-#260 append-only writer: two
    // blocks, same id.
    let content = appendSessionSummaryBlock("# nb\n", a);
    content = appendSessionSummaryBlock(content, b);
    expect(findSessionSummaryBlocks(content)).toHaveLength(2);

    const c = { ...sample, id, startedAt: "2026-05-08T10:30:13Z", endedAt: "2026-05-08T10:30:20Z" };
    const out = upsertSessionSummaryBlock(content, c);
    const blocks = findSessionSummaryBlocks(out);
    expect(blocks).toHaveLength(1);
    // Earliest start and latest end across all three blocks.
    expect(blocks[0].startedAt).toBe("2026-05-08T10:00:00Z");
    expect(blocks[0].endedAt).toBe("2026-05-08T10:30:20Z");
  });

  it("preserves surrounding notebook content when replacing a block", () => {
    const before = "# nb\n\nsome prose\n";
    let content = upsertSessionSummaryBlock(before, sample);
    content += "\ntrailing user note\n";
    const resumed = { ...sample, endedAt: "2026-05-08T21:00:00Z" };
    const out = upsertSessionSummaryBlock(content, resumed);
    expect(out).toContain("some prose");
    expect(out).toContain("trailing user note");
    expect(findSessionSummaryBlocks(out)).toHaveLength(1);
  });
});

describe("findSessionSummaryBlocks", () => {
  it("round-trips through render -> append -> parse", () => {
    const content = appendSessionSummaryBlock("# notebook\n", sample);
    const parsed = findSessionSummaryBlocks(content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(sample);
  });

  it("returns the most recent block last (chronological order)", () => {
    const a = { ...sample, id: "sess_a", endedAt: "2026-05-08T18:00:00Z" };
    const b = { ...sample, id: "sess_b", endedAt: "2026-05-08T19:00:00Z" };
    const c = { ...sample, id: "sess_c", endedAt: "2026-05-08T20:00:00Z" };
    let content = "# nb\n";
    for (const s of [a, b, c]) content = appendSessionSummaryBlock(content, s);
    const blocks = findSessionSummaryBlocks(content);
    expect(blocks.map((b) => b.id)).toEqual(["sess_a", "sess_b", "sess_c"]);
  });

  it("skips malformed blocks without throwing", () => {
    const content = `# nb

\`\`\`loom-session
id: only_id
\`\`\`

\`\`\`loom-session
id: complete
started_at: 2026-05-08T19:30:00Z
ended_at: 2026-05-08T20:00:00Z
notebook: notebook.md
orphaned_active_steps: 0
\`\`\`
`;
    const blocks = findSessionSummaryBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toBe("complete");
  });

  it("returns empty array when no blocks present", () => {
    expect(findSessionSummaryBlocks("# just notebook content\n\nNo blocks.")).toEqual([]);
  });

  it("defaults orphanedActiveSteps to 0 when the field is non-numeric", () => {
    const content = `\`\`\`loom-session
id: weird
started_at: 2026-05-08T19:30:00Z
ended_at: 2026-05-08T20:00:00Z
notebook: notebook.md
orphaned_active_steps: not-a-number
\`\`\`
`;
    const blocks = findSessionSummaryBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].orphanedActiveSteps).toBe(0);
  });
});
