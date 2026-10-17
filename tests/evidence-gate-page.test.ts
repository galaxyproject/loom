/**
 * The evidence gate under a page record: the model completes a step by calling update_page on
 * the record page, so that call is adjudicated the way a file edit to notebook.md is.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as state from "../extensions/loom/state";
import {
  computeAfterContent,
  registerEvidenceGate,
  resetEvidenceOverrides,
} from "../extensions/loom/evidence-gate";
import { renderInvocationYaml } from "../extensions/loom/notebook-writer";
import { setRecordStore, type RecordStore } from "../extensions/loom/record-store";
import { bareFamily, MCP_FAMILY } from "../shared/galaxy-mcp-tools.js";
import { sectionsHeaded } from "../shared/markdown-sections.js";

vi.mock("../extensions/loom/state", async (actual) => ({
  ...(await actual<typeof import("../extensions/loom/state")>()),
  getNotebookPath: vi.fn(),
}));

const PAGE_ID = "5a1cde2f3b4c5d6e";
const STEP2 = "2. **Align reads** {#plan-a-step-2} -- bwa mem";
const PLAN = `# Notebook

## Plan A: chrM Variant Calling [hybrid]

### Steps

- [ ] 1. **QC FASTQ** {#plan-a-step-1} -- fastp adapter trim
- [ ] ${STEP2}
`;
// The run bound to step 2 is still going, so marking it done contradicts the record.
const BODY =
  PLAN +
  "\n" +
  renderInvocationYaml({
    invocationId: "abc0000000000001",
    galaxyServerUrl: "https://test.galaxyproject.org",
    notebookAnchor: "plan-a-step-2",
    label: "Align reads",
    submittedAt: "2026-08-01T00:00:00Z",
    status: "in_progress",
  });
const PLAN_SECTION = "### Steps";
const FLIPPED_SECTION = sectionsHeaded(BODY, PLAN_SECTION)[0].replace(
  `- [ ] ${STEP2}`,
  `- [x] ${STEP2}`,
);

let dir: string;
let nbPath: string;

function pageStore(pageId = PAGE_ID): RecordStore {
  return {
    kind: "page",
    key: nbPath,
    label: `Galaxy page ${pageId}`,
    pageId,
    stat: async () => "v1",
    read: async () => ({ content: BODY, version: "v1" }),
    write: async () => {},
    ensure: async () => false,
    onChange: () => () => {},
  };
}

function gate(family = bareFamily(["update_page", "run_tool"])) {
  const handlers: Array<(event: unknown, ctx: unknown) => Promise<unknown>> = [];
  registerEvidenceGate(
    {
      on: (name: string, h: (typeof handlers)[number]) => name === "tool_call" && handlers.push(h),
    } as unknown as ExtensionAPI,
    family,
  );
  return async (toolName: string, input: Record<string, unknown>) =>
    (await handlers[0]({ toolName, input }, { cwd: dir })) as
      { block?: boolean; reason?: string } | undefined;
}

const decisions = () => {
  const file = path.join(dir, "activity.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { kind: string; payload: Record<string, unknown> })
    .filter((e) => e.kind === "evidence.decision")
    .map((e) => e.payload);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-evidence-page-"));
  nbPath = path.join(dir, "notebook.md");
  vi.mocked(state.getNotebookPath).mockReturnValue(nbPath);
  process.env.LOOM_EVIDENCE_GATE = "deny";
  resetEvidenceOverrides();
});

afterEach(() => {
  delete process.env.LOOM_EVIDENCE_GATE;
  setRecordStore(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("update_page under a page record", () => {
  it("adjudicates a whole-content write that completes a step without evidence", async () => {
    setRecordStore(pageStore());
    const call = gate();
    const verdict = await call("update_page", {
      page_id: PAGE_ID,
      content: BODY.replace(`- [ ] ${STEP2}`, `- [x] ${STEP2}`),
    });
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toMatch(/Align reads/);
    expect(decisions()).toEqual([
      expect.objectContaining({ toolName: "update_page", outcome: "blocked" }),
    ]);
  });

  it("adjudicates a section edit against the section it rewrites", async () => {
    setRecordStore(pageStore());
    const verdict = await gate()("update_page", {
      page_id: PAGE_ID,
      section_heading: PLAN_SECTION,
      section_content: FLIPPED_SECTION,
    });
    expect(verdict?.block).toBe(true);
  });

  it("records the name the model called, MCP spelling included", async () => {
    setRecordStore(pageStore());
    const verdict = await gate(MCP_FAMILY)("mcp__galaxy__update_page", {
      page_id: PAGE_ID,
      content: BODY.replace(`- [ ] ${STEP2}`, `- [x] ${STEP2}`),
    });
    expect(verdict?.block).toBe(true);
    expect(decisions()[0].toolName).toBe("mcp__galaxy__update_page");
  });

  it("ignores a write to some other page", async () => {
    setRecordStore(pageStore());
    const verdict = await gate()("update_page", {
      page_id: "0123456789abcdef",
      content: BODY.replace(`- [ ] ${STEP2}`, `- [x] ${STEP2}`),
    });
    expect(verdict).toBeUndefined();
    expect(decisions()).toEqual([]);
  });

  it("is inert under a file notebook", async () => {
    fs.writeFileSync(nbPath, BODY);
    const verdict = await gate()("update_page", {
      page_id: PAGE_ID,
      content: BODY.replace(`- [ ] ${STEP2}`, `- [x] ${STEP2}`),
    });
    expect(verdict).toBeUndefined();
    expect(decisions()).toEqual([]);
  });
});

describe("computeAfterContent for update_page", () => {
  it("reads whole content, applies a section edit, and has no opinion otherwise", () => {
    expect(computeAfterContent(BODY, "update_page", { content: "# New\n" })).toBe("# New\n");
    expect(
      computeAfterContent(BODY, "update_page", {
        section_heading: PLAN_SECTION,
        section_content: FLIPPED_SECTION,
      }),
    ).toContain(`- [x] ${STEP2}`);
    expect(computeAfterContent(BODY, "update_page", { title: "Renamed" })).toBeNull();
    // Combinations the bridge refuses write nothing.
    expect(
      computeAfterContent(BODY, "update_page", { content: "# New\n", section_heading: "## X" }),
    ).toBeNull();
    expect(computeAfterContent(BODY, "update_page", { section_heading: "## X" })).toBeNull();
  });
});
