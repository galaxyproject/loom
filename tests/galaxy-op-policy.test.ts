import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setGalaxyTransport } from "../extensions/orbit/galaxy-api";
import {
  GALAXY_OP_POLICY,
  registerGalaxyOpPolicy,
  resetShownPages,
  unreadInputs,
} from "../extensions/orbit/galaxy-op-policy";
import { GALAXY_DEADLINE_MS } from "../extensions/orbit/galaxy-tool-wrap";
import { malformedIdsRefusal } from "../extensions/orbit/galaxy-page-ops";
import { setRecordStore, withRecordLock } from "../extensions/orbit/record-store";
import { createPageRecordStore } from "../extensions/orbit/record-store-page";
import { applySectionEdit } from "../shared/markdown-sections.js";
import { pageContentHash } from "../shared/page-content-hash.js";
import { ELISION_MARKER } from "../shared/record-excerpt.js";
import { CREDENTIALS, json, recordGalaxy, runOp } from "./galaxy-test-helpers";

const PAGE_ID = "5a1cde2f3b4c5d6e";
const OTHER_PAGE = "0123456789abcdef";
const signal = () => new AbortController().signal;

const BODY = ["# Notebook", "", "## Plan", "old plan", "", "## Results", "old results", ""].join(
  "\n",
);

/**
 * A Galaxy with pages and tools. `edit` changes a stored page behind the model's back, the way
 * the poller writes the record.
 */
function galaxy(opts: { tools?: Record<string, unknown>; toolStatus?: number } = {}) {
  const pages = new Map<string, Record<string, unknown>>(
    [PAGE_ID, OTHER_PAGE].map((id) => [
      id,
      { id, title: "Notebook", content_format: "markdown", content_editor: BODY, content: "<r/>" },
    ]),
  );
  const seen = recordGalaxy(({ method, path, body }) => {
    const tool = path.match(/^\/api\/tools\/([^/]+)$/);
    if (tool && method === "GET") {
      if (opts.toolStatus) return json({ err_msg: "nope" }, opts.toolStatus);
      const schema = opts.tools?.[decodeURIComponent(tool[1])];
      return schema ? json(schema) : json({ err_msg: "no such tool" }, 404);
    }
    if (path === "/api/tools" && method === "POST") return json({ jobs: [], outputs: [] });
    const page = path.match(/^\/api\/pages\/([^/]+)$/);
    const stored = page && pages.get(page[1]);
    if (!stored) return json({ err_msg: "no such page" }, 404);
    if (method === "PUT" && typeof body?.content === "string") {
      stored.content_editor = body.content;
      stored.content = `<r>${body.content}</r>`;
    }
    return json(stored);
  });
  const edit = (id: string, change: (body: string) => string) => {
    const page = pages.get(id)!;
    page.content_editor = change(String(page.content_editor));
  };
  const body = (id: string) => String(pages.get(id)!.content_editor);
  return { seen, edit, body };
}

afterEach(() => {
  setGalaxyTransport(null);
  setRecordStore(null);
  resetShownPages();
});

const CAT = {
  id: "cat1",
  version: "1.0",
  inputs: [
    { name: "input1", type: "data" },
    { name: "queries", type: "repeat", inputs: [{ name: "input2", type: "data" }] },
    {
      name: "cond",
      type: "conditional",
      test_param: { name: "pick", type: "select" },
      cases: [{ inputs: [{ name: "lines", type: "integer" }] }, { inputs: [] }],
    },
    { name: "adv", type: "section", inputs: [{ name: "header", type: "boolean" }] },
  ],
};

describe("run_tool: unreadInputs", () => {
  it("refuses a key the tool does not read, naming it and the keys it does read", async () => {
    galaxy({ tools: { cat1: CAT } });
    const refusal = await unreadInputs(
      { tool_id: "cat1", history_id: "h", inputs: { input1: { src: "hda", id: "d" }, inptu1: 1 } },
      { signal: signal() },
    );
    expect(refusal).toMatch(/^Refused: cat1 has no input at "inptu1"/);
    expect(refusal).toContain(
      '"input1", "queries_0|input2", "cond|pick", "cond|lines", "adv|header"',
    );
  });

  it("passes repeat instances, conditional members, section members and Galaxy's own keys", async () => {
    galaxy({ tools: { cat1: CAT } });
    const inputs = {
      input1: { src: "hda", id: "d" },
      "queries_0|input2": { src: "hda", id: "e" },
      "queries_1|input2": { src: "hda", id: "f" },
      "cond|pick": "a",
      "cond|lines": 5,
      pick: "a",
      "adv|header": true,
      __job_resource: {},
      "input1|__identifier__": "x",
    };
    expect(await unreadInputs({ tool_id: "cat1", inputs }, { signal: signal() })).toBeUndefined();
  });

  it("sends the pinned version and fails open when Galaxy answers for another one", async () => {
    const { seen } = galaxy({ tools: { cat1: CAT } });
    const args = { tool_id: "cat1", tool_version: "2.0", inputs: { nope: 1 } };
    expect(await unreadInputs(args, { signal: signal() })).toBeUndefined();
    expect(seen[0]).toMatchObject({
      path: "/api/tools/cat1",
      search: "?io_details=true&tool_version=2.0",
    });
  });

  it("fails open on a failed lookup, another tool's schema, or no declared inputs", async () => {
    const args = { tool_id: "cat1", inputs: { nope: 1 } };
    galaxy({ toolStatus: 500 });
    expect(await unreadInputs(args, { signal: signal() })).toBeUndefined();
    galaxy({ tools: { cat1: { ...CAT, id: "cat2" } } });
    expect(await unreadInputs(args, { signal: signal() })).toBeUndefined();
    galaxy({ tools: { cat1: { ...CAT, inputs: [] } } });
    expect(await unreadInputs(args, { signal: signal() })).toBeUndefined();
    // A toolshed id resolves through Galaxy's expansion of the short id.
    galaxy({ tools: { cat1: { ...CAT, id: "cat1/1.0" } } });
    expect(await unreadInputs(args, { signal: signal() })).toMatch(/"nope"/);
  });

  it("does not fail open when the deadline aborted the lookup", async () => {
    galaxy({ tools: { cat1: CAT } });
    const abort = new AbortController();
    abort.abort(new Error("deadline"));
    await expect(
      unreadInputs({ tool_id: "cat1", inputs: { nope: 1 } }, { signal: abort.signal }),
    ).rejects.toThrow("deadline");
  });

  it("is run_tool's check: the refusal is a validation envelope and nothing is submitted", async () => {
    const { seen } = galaxy({ tools: { cat1: CAT } });
    const result = await runOp("run_tool", {
      tool_id: "cat1",
      history_id: "f2db41e1fa331b3e",
      inputs: { inptu1: { src: "hda", id: "d" } },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ success: false, errorKind: "validation" });
    expect(result.structuredContent.message).toMatch(/no input at "inptu1"/);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /api/tools/cat1"]);
  });
});

describe("create_page and update_page checks", () => {
  const check = (op: string, args: Record<string, unknown>) =>
    GALAXY_OP_POLICY[op].check!(args, { signal: signal() });

  it("create_page refuses malformed directive ids with the bridge's own words", async () => {
    const content = "```galaxy\nhistory_dataset_display(history_dataset_id=3)\n```\n";
    expect(await check("create_page", { title: "t", content })).toBe(
      malformedIdsRefusal(["history_dataset_id=3"]),
    );
    expect(await check("create_page", { title: "t", content: "# Fine\n" })).toBeUndefined();
  });

  it("update_page refuses whole content that still carries the excerpt's elision marker", async () => {
    const refusal = await check("update_page", {
      page_id: PAGE_ID,
      content: `# Notebook\n\n${ELISION_MARKER}\n\n## Tail\n`,
    });
    expect(refusal).toMatch(/elision marker/);
    expect(refusal).toMatch(/section_heading and section_content/);
    expect(await check("update_page", { page_id: PAGE_ID, content: "# Whole\n" })).toBeUndefined();
  });

  it.each([
    [
      "a bare title for a heading",
      "Results",
      "## Results\nnew",
      /heading line itself.*"## Results"/,
    ],
    [
      "content without its heading line",
      "## Results",
      "new results only",
      /starts with "## Results"/,
    ],
    ["content led by blank lines", "## Results", "\n## Results\nnew", undefined],
    // An indented heading line is not a heading to markdown: the section would merge into the
    // one above it, and the next edit by heading would append a duplicate.
    ["an indented heading line", "## Results", "  ## Results\nnew", /starts with "## Results"/],
    // No heading line on a page holds a newline, so this could only ever append.
    [
      "a heading holding a newline",
      "## Results\nnew",
      "## Results\nnew",
      /^Refused: section_heading is one line/,
    ],
    // A new heading line renames the section.
    ["a new heading line", "## Results", "### Findings\nx", undefined],
  ])("update_page's heading-loss check on %s", async (_name, heading, content, refusal) => {
    const result = await check("update_page", {
      page_id: PAGE_ID,
      section_heading: heading,
      section_content: content,
    });
    expect(result).toEqual(refusal ? expect.stringMatching(refusal) : undefined);
  });

  it("update_page refuses a section edit whose section_content carries the elision marker", async () => {
    const refusal = await check("update_page", {
      page_id: PAGE_ID,
      section_heading: "## Results",
      section_content: `## Results\nhead\n\n${ELISION_MARKER}\n\ntail`,
    });
    expect(refusal).toMatch(/elision marker/);
    expect(refusal).toMatch(/get_page/);
  });

  it.each([
    ["create_page", { title: "t", content: "# A\n```loom-job\njob_id: x\n```\n" }, "content"],
    ["update_page", { page_id: PAGE_ID, content: "# A\n```python\nprint(1)\n```\n" }, "content"],
    [
      "update_page",
      {
        page_id: PAGE_ID,
        section_heading: "## Results",
        section_content: "## Results\n```loom-proposal\nid: p\n```\n",
      },
      "section_content",
    ],
  ])(
    "%s refuses a fence Galaxy has no cell for, before anything is sent",
    async (op, args, field) => {
      const refusal = await check(op, args);
      expect(refusal).toMatch(new RegExp(`^Refused: ${field} holds a block Galaxy won't accept`));
      expect(refusal).toMatch(/use ~~~ fences/);
    },
  );

  it("sends a typed block on the record page to the record tools, not to ~~~ fences", async () => {
    setRecordStore(createPageRecordStore({ key: "/session/notebook.md", pageId: PAGE_ID }));
    const typed = "## Runs\n```loom-job\njob_id: x\n```\n";
    const onRecord = await check("update_page", {
      page_id: PAGE_ID,
      section_heading: "## Runs",
      section_content: typed,
    });
    expect(onRecord).toMatch(/record's typed blocks/);
    expect(onRecord).toMatch(/galaxy_job_record/);
    expect(onRecord).not.toMatch(/~~~/);
    // Another page gets Galaxy's own advice.
    const elsewhere = await check("update_page", { page_id: OTHER_PAGE, content: typed });
    expect(elsewhere).toMatch(/use ~~~ fences/);
  });

  it("lets Galaxy's own cells and the record's carriers through", async () => {
    const content = [
      "# A",
      "```galaxy",
      "history_link(history_id=0a248a1f62a0cc04)",
      "```",
      '[loom-job:v1]: #loom "YWJj"',
      "~~~python",
      "print(1)",
      "~~~",
      "",
    ].join("\n");
    expect(await check("create_page", { title: "t", content })).toBeUndefined();
    expect(await check("update_page", { page_id: PAGE_ID, content })).toBeUndefined();
  });

  it("has no refused hook, no settled trait and nothing for other ops", () => {
    expect(Object.keys(GALAXY_OP_POLICY).sort()).toEqual([
      "create_page",
      "get_page",
      "revert_page_revision",
      "run_tool",
      "update_page",
    ]);
    for (const policy of Object.values(GALAXY_OP_POLICY)) expect(policy.refused).toBeUndefined();
  });
});

describe("update_page against the page as it is now", () => {
  const sectionEdit = (hash: string) => ({
    page_id: PAGE_ID,
    section_heading: "## Results",
    section_content: "## Results\nnew results\n",
    expect_hash: hash,
  });
  const read = async () => {
    const result = await runOp("get_page", { page_id: PAGE_ID });
    expect(result.isError).toBe(false);
    return String(result.structuredContent.data.content_hash);
  };

  it("repairs a stale hash when the section being rewritten is unchanged since the read", async () => {
    const g = galaxy();
    const shownHash = await read();
    g.edit(PAGE_ID, (b) => b.replace("old plan", "plan the poller advanced"));
    const current = g.body(PAGE_ID);
    g.seen.length = 0;
    const result = await runOp("update_page", sectionEdit(shownHash));
    expect(result.isError).toBe(false);
    expect(g.seen.map((s) => s.method)).toEqual(["GET", "GET", "PUT"]);
    expect(g.seen[2].body?.content).toBe(
      applySectionEdit(current, "## Results", "## Results\nnew results\n"),
    );
    expect(g.body(PAGE_ID)).toContain("plan the poller advanced");
  });

  it("sends a stale hash as given when the section changed, and the bridge refuses it", async () => {
    const g = galaxy();
    const shownHash = await read();
    g.edit(PAGE_ID, (b) => b.replace("old results", "results someone else wrote"));
    g.seen.length = 0;
    const result = await runOp("update_page", sectionEdit(shownHash));
    expect(result.isError).toBe(true);
    expect(result.structuredContent.errorKind).toBe("validation");
    expect(result.structuredContent.message).toContain(`not ${shownHash}`);
    expect(g.seen.some((s) => s.method === "PUT")).toBe(false);
  });

  it("counts a subsection as part of the section, so a change there is not repaired", async () => {
    const g = galaxy();
    g.edit(PAGE_ID, (b) => `${b}### Table\nold rows\n`);
    const shownHash = await read();
    g.edit(PAGE_ID, (b) => b.replace("old rows", "rows the poller wrote"));
    g.seen.length = 0;
    const result = await runOp("update_page", sectionEdit(shownHash));
    expect(result.isError).toBe(true);
    expect(result.structuredContent.message).toContain(`not ${shownHash}`);
    expect(g.seen.some((s) => s.method === "PUT")).toBe(false);
  });

  it("never supplies an expect_hash the model did not send", async () => {
    const g = galaxy();
    await read();
    g.edit(PAGE_ID, (b) => b.replace("old plan", "moved"));
    g.seen.length = 0;
    const { expect_hash: _hash, ...args } = sectionEdit("unused");
    const result = await runOp("update_page", args);
    expect(result.isError).toBe(false);
    // Only the bridge's own read: the policy had nothing to repair.
    expect(g.seen.map((s) => s.method)).toEqual(["GET", "PUT"]);
  });

  it("leaves a hash it never showed alone", async () => {
    const g = galaxy();
    g.edit(PAGE_ID, (b) => b.replace("old plan", "moved"));
    const result = await runOp("update_page", sectionEdit(pageContentHash(BODY)));
    expect(result.isError).toBe(true);
    expect(g.seen.filter((s) => s.method === "GET")).toHaveLength(1);
  });

  it("remembers the body it wrote under the hash it returned", async () => {
    const g = galaxy();
    const first = await runOp("update_page", sectionEdit(await read()));
    const written = String(first.structuredContent.data.content_hash);
    expect(written).toBe(pageContentHash(g.body(PAGE_ID)));
    g.edit(PAGE_ID, (b) => b.replace("old plan", "moved again"));
    const second = await runOp("update_page", {
      ...sectionEdit(written),
      section_content: "## Results\nnewer results\n",
    });
    expect(second.isError).toBe(false);
    expect(g.body(PAGE_ID)).toContain("newer results");
  });

  it("forgets every page body on reset and at session_start", async () => {
    const g = galaxy();
    const shownHash = await read();
    resetShownPages();
    g.edit(PAGE_ID, (b) => b.replace("old plan", "moved"));
    expect((await runOp("update_page", sectionEdit(shownHash))).isError).toBe(true);

    const on = vi.fn();
    registerGalaxyOpPolicy({ on } as unknown as ExtensionAPI);
    expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
    const again = await read();
    on.mock.calls[0][1]();
    g.edit(PAGE_ID, (b) => b.replace("moved", "moved twice"));
    expect((await runOp("update_page", sectionEdit(again))).isError).toBe(true);
  });
});

describe("update_page on the record page waits behind the record's writers", () => {
  const KEY = "/session/notebook.md";

  it("holds a revert of the record page behind the record lock, and no other page's", async () => {
    setRecordStore(createPageRecordStore({ key: KEY, pageId: PAGE_ID }));
    const around = GALAXY_OP_POLICY.revert_page_revision.around!;
    let release!: () => void;
    const poller = withRecordLock(KEY, () => new Promise<void>((r) => (release = r)));
    const sent: string[] = [];
    const revert = (page: string) =>
      around(
        async () => void sent.push(page),
        { page_id: page, revision_id: "r1" },
        { signal: signal() },
      );
    const record = revert(PAGE_ID);
    await revert(OTHER_PAGE);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([OTHER_PAGE]);
    release();
    await Promise.all([poller, record]);
    expect(sent).toEqual([OTHER_PAGE, PAGE_ID]);
  });

  it("runs a record-page update under the record lock", async () => {
    const g = galaxy();
    setRecordStore(createPageRecordStore({ key: KEY, pageId: PAGE_ID }));
    const order: string[] = [];
    let release!: () => void;
    const poller = withRecordLock(KEY, async () => {
      await new Promise<void>((r) => (release = r));
      order.push("poller");
    });
    const update = runOp("update_page", { page_id: PAGE_ID, content: "# Mine\n" }).then((r) => {
      order.push("update");
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(g.seen.some((s) => s.method === "PUT")).toBe(false);
    release();
    await poller;
    expect((await update).isError).toBe(false);
    expect(order).toEqual(["poller", "update"]);
  });

  it("lets the record's writers go when the deadline cuts a write the transport never answers", async () => {
    vi.useFakeTimers();
    try {
      // A shell's transport may ignore its signal; the deadline still has to free the record.
      setGalaxyTransport({
        credentials: CREDENTIALS,
        fetch: (url, init) =>
          new URL(url).pathname === "/api/version" || (init.method ?? "GET") === "GET"
            ? Promise.resolve(json({}))
            : new Promise<Response>(() => {}),
      });
      setRecordStore(createPageRecordStore({ key: KEY, pageId: PAGE_ID }));
      const update = runOp("update_page", { page_id: PAGE_ID, content: "# Mine\n" });
      await vi.advanceTimersByTimeAsync(GALAXY_DEADLINE_MS);
      expect((await update).details.galaxy).toMatchObject({ kind: "timeout" });
      let poller = false;
      const write = withRecordLock(KEY, async () => {
        poller = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(poller).toBe(true);
      await write;
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends nothing when the record lock is only granted after the deadline", async () => {
    vi.useFakeTimers();
    try {
      // Unlike galaxy()'s fetch, this one ignores its signal, as a shell's transport may.
      const methods: string[] = [];
      setGalaxyTransport({
        credentials: CREDENTIALS,
        fetch: async (url, init) => {
          if (new URL(url).pathname !== "/api/version") methods.push(init.method ?? "GET");
          return json({ id: PAGE_ID, content_format: "markdown", content_editor: BODY });
        },
      });
      setRecordStore(createPageRecordStore({ key: KEY, pageId: PAGE_ID }));
      let release: () => void = () => {};
      const poller = withRecordLock(KEY, () => new Promise<void>((r) => (release = r)));
      const update = runOp("update_page", { page_id: PAGE_ID, content: "# Mine\n" });
      await vi.advanceTimersByTimeAsync(GALAXY_DEADLINE_MS);
      expect((await update).details.galaxy).toMatchObject({ kind: "timeout" });
      release();
      await poller;
      await vi.advanceTimersByTimeAsync(0);
      expect(methods).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends no write when the page read lands after the deadline", async () => {
    vi.useFakeTimers();
    try {
      // The bridge's own read outlives the deadline on a transport that ignores its signal; by
      // the time it lands the record lock is gone and the model was told the result is unknown.
      let answer!: (r: Response) => void;
      const methods: string[] = [];
      setGalaxyTransport({
        credentials: CREDENTIALS,
        fetch: (url, init) => {
          const path = new URL(url).pathname;
          if (path === "/api/version") return Promise.resolve(json({}));
          const method = init.method ?? "GET";
          methods.push(method);
          if (method === "GET" && path === `/api/pages/${PAGE_ID}`) {
            return new Promise<Response>((r) => (answer = r));
          }
          return Promise.resolve(
            json({ id: PAGE_ID, content_format: "markdown", content_editor: "# Mine\n" }),
          );
        },
      });
      setRecordStore(createPageRecordStore({ key: KEY, pageId: PAGE_ID }));
      const update = runOp("update_page", {
        page_id: PAGE_ID,
        content: "# Mine\n",
        expect_hash: pageContentHash(BODY),
      });
      await vi.advanceTimersByTimeAsync(GALAXY_DEADLINE_MS);
      expect((await update).details.galaxy).toMatchObject({ kind: "timeout" });
      answer(json({ id: PAGE_ID, content_format: "markdown", content_editor: BODY }));
      await vi.advanceTimersByTimeAsync(0);
      expect(methods).toEqual(["GET"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hold another page's write behind the record lock", async () => {
    galaxy();
    setRecordStore(createPageRecordStore({ key: KEY, pageId: PAGE_ID }));
    let release!: () => void;
    const held = withRecordLock(KEY, () => new Promise<void>((r) => (release = r)));
    const result = await runOp("update_page", { page_id: OTHER_PAGE, content: "# Theirs\n" });
    expect(result.isError).toBe(false);
    release();
    await held;
  });
});
