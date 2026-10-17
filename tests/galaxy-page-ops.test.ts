import { afterEach, describe, expect, it } from "vitest";
import {
  describeOperation,
  getPageOp,
  runWithEnvelope,
  spellParamNames,
  updatePageOp,
} from "@galaxyproject/galaxy-ops";
import { galaxyOpsContext, setGalaxyTransport } from "../extensions/loom/galaxy-api";
import {
  createGalaxyOpsToolSource,
  renderOperation,
  snake,
} from "../extensions/loom/galaxy-ops-tools";
import type { GalaxyTool } from "../extensions/loom/galaxy-tool-source";
import { applySectionEdit } from "../shared/markdown-sections.js";
import { pageContentHash } from "../shared/page-content-hash.js";

const CREDENTIALS = () => ({ url: "https://galaxy.test", apiKey: "k" });
const PAGE_ID = "5a1cde2f3b4c5d6e";
const DATASET = "f2db41e1fa331b3e";

const BODY = [
  "# Notebook",
  "",
  "## Plan",
  "old plan",
  "",
  "## Results",
  "old results",
  "",
  "## Results",
  "older results",
  "",
].join("\n");

const tool = (name: string): GalaxyTool =>
  createGalaxyOpsToolSource()
    .tools()
    .find((t) => t.name === name)!;
const run = (name: string, params: object) =>
  tool(name).execute("call-1", params, undefined, undefined, {} as never);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Seen {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

/**
 * A Galaxy holding one page. PUT stores what it is sent and answers with the stored page, the
 * rendered `content` regenerated, as Galaxy does. /api/version answers nothing, so the version is
 * unknown and refuses nothing.
 */
function galaxyWithPage(page: Record<string, unknown>) {
  const seen: Seen[] = [];
  let stored = { ...page };
  setGalaxyTransport({
    credentials: CREDENTIALS,
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/api/version") return json({});
      const method = init.method ?? "GET";
      const raw = init.body ? new TextDecoder().decode(init.body as ArrayBuffer) : undefined;
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      seen.push({ method, path, ...(body ? { body } : {}) });
      if (path !== `/api/pages/${PAGE_ID}`) return json({ err_msg: "no such page" }, 404);
      if (method === "PUT") {
        const content = typeof body?.content === "string" ? body.content : stored.content_editor;
        stored = {
          ...stored,
          ...(typeof body?.title === "string" ? { title: body.title } : {}),
          content_editor: content,
          content: `<rendered>${String(content)}</rendered>`,
          latest_revision_id: "r2",
        };
      }
      return json(stored);
    },
  });
  return seen;
}

const markdownPage = (overrides: Record<string, unknown> = {}) => ({
  id: PAGE_ID,
  title: "Notebook",
  slug: null,
  content_format: "markdown",
  content_editor: BODY,
  content: "<rendered/>",
  latest_revision_id: "r1",
  ...overrides,
});

afterEach(() => {
  setGalaxyTransport(null);
});

describe("update_page", () => {
  it("sends whole content without content_format, and without reading first", async () => {
    const seen = galaxyWithPage(markdownPage());
    const result = await run("update_page", { page_id: PAGE_ID, content: "# New\n" });
    expect(seen).toEqual([
      {
        method: "PUT",
        path: `/api/pages/${PAGE_ID}`,
        body: { edit_source: "agent", content: "# New\n" },
      },
    ]);
    expect(result.isError).toBe(false);
    expect(result.structuredContent.message).toBe(`Updated page '${PAGE_ID}'`);
  });

  it("answers with the written page's content_hash and no rendered body", async () => {
    galaxyWithPage(markdownPage());
    const result = await run("update_page", { page_id: PAGE_ID, content: "# New\n", title: "T" });
    const data = result.structuredContent.data as Record<string, unknown>;
    expect(data.content_hash).toBe(pageContentHash("# New\n"));
    expect(data.content_editor).toBe("# New\n");
    expect(data.title).toBe("T");
    expect(data).not.toHaveProperty("content");
  });

  it("rewrites every section under the heading and leaves the rest byte for byte", async () => {
    const seen = galaxyWithPage(markdownPage());
    const result = await run("update_page", {
      page_id: PAGE_ID,
      section_heading: "## Results",
      section_content: "## Results\nnew results\n",
    });
    expect(result.isError).toBe(false);
    expect(seen.map((s) => s.method)).toEqual(["GET", "PUT"]);
    expect(seen[1].body).toEqual({
      edit_source: "agent",
      content: [
        "# Notebook",
        "",
        "## Plan",
        "old plan",
        "",
        "## Results\nnew results\n",
        "## Results\nnew results\n",
      ].join("\n"),
    });
    expect(seen[1].body?.content).toBe(
      applySectionEdit(BODY, "## Results", "## Results\nnew results\n"),
    );
  });

  it("appends a section whose heading the page lacks", async () => {
    const seen = galaxyWithPage(markdownPage());
    await run("update_page", {
      page_id: PAGE_ID,
      section_heading: "## Methods",
      section_content: "## Methods\nwc_gnu on the input",
    });
    expect(seen[1].body?.content).toBe(`${BODY}\n## Methods\nwc_gnu on the input`);
  });

  it("writes when expect_hash matches the page as it is", async () => {
    const seen = galaxyWithPage(markdownPage());
    const result = await run("update_page", {
      page_id: PAGE_ID,
      content: "# Replaced\n",
      expect_hash: pageContentHash(BODY),
    });
    expect(result.isError).toBe(false);
    expect(seen.map((s) => s.method)).toEqual(["GET", "PUT"]);
    expect(seen[1].body).toEqual({ edit_source: "agent", content: "# Replaced\n" });
  });

  it("checks expect_hash before a title-only change and sends only the title", async () => {
    const seen = galaxyWithPage(markdownPage());
    await run("update_page", {
      page_id: PAGE_ID,
      title: "Renamed",
      expect_hash: pageContentHash(BODY),
    });
    expect(seen[1].body).toEqual({ edit_source: "agent", title: "Renamed" });
  });

  it("refuses a stale expect_hash and writes nothing", async () => {
    const seen = galaxyWithPage(markdownPage());
    const result = await run("update_page", {
      page_id: PAGE_ID,
      section_heading: "## Plan",
      section_content: "## Plan\nnew plan",
      expect_hash: "0badc0de",
    });
    expect(seen.map((s) => s.method)).toEqual(["GET"]);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ success: false, errorKind: "validation" });
    expect(result.structuredContent.message).toBe(
      `Page '${PAGE_ID}' changed since it was read: its content_hash is now ${pageContentHash(BODY)}, not 0badc0de. Read it again with get_page and make the edit against what is there now.`,
    );
  });

  it.each([
    ["a heading without content", { section_heading: "## Plan" }],
    ["content without a heading", { section_content: "## Plan\nx" }],
    [
      "a section and whole content",
      { section_heading: "## Plan", section_content: "## Plan\nx", content: "y" },
    ],
  ])("refuses %s before asking Galaxy", async (_name, args) => {
    const seen = galaxyWithPage(markdownPage());
    const result = await run("update_page", { page_id: PAGE_ID, ...args });
    expect(seen).toEqual([]);
    expect(result.structuredContent).toMatchObject({ success: false, errorKind: "validation" });
    expect(result.structuredContent.message).not.toMatch(/MCP/);
  });

  it.each([
    [
      "whole content",
      { content: "```galaxy\nhistory_dataset_display(history_dataset_id=3)\n```\n" },
    ],
    [
      "a section",
      {
        section_heading: "## Results",
        section_content: "## Results\n${galaxy history_dataset_as_image(history_dataset_id=hid:7)}",
      },
    ],
  ])("refuses a directive id that is not an encoded id in %s", async (_name, args) => {
    const seen = galaxyWithPage(markdownPage());
    const result = await run("update_page", { page_id: PAGE_ID, ...args });
    expect(seen).toEqual([]);
    expect(result.structuredContent.errorKind).toBe("validation");
    expect(result.structuredContent.message).toMatch(/history_dataset_id=(3|hid:7)/);
    expect(result.structuredContent.message).toContain("encoded id");
  });

  it("lets an encoded directive id through", async () => {
    const seen = galaxyWithPage(markdownPage());
    const content = `\`\`\`galaxy\nhistory_dataset_display(history_dataset_id=${DATASET})\n\`\`\`\n`;
    const result = await run("update_page", { page_id: PAGE_ID, content });
    expect(result.isError).toBe(false);
    expect(seen[0].body?.content).toBe(content);
  });

  it("refuses a section edit on a page authored as HTML", async () => {
    const seen = galaxyWithPage(
      markdownPage({ content_format: "html", content_editor: "<h2>Plan</h2>" }),
    );
    const result = await run("update_page", {
      page_id: PAGE_ID,
      section_heading: "## Plan",
      section_content: "## Plan\nx",
    });
    expect(seen.map((s) => s.method)).toEqual(["GET"]);
    expect(result.structuredContent.errorKind).toBe("validation");
    expect(result.structuredContent.message).toContain("html");
  });

  it("keeps galaxy-ops' parameters and adds the three section and hash fields", () => {
    const t = tool("update_page");
    const base = renderOperation(updatePageOp).parameters;
    const params = t.parameters as typeof base;
    expect(Object.keys(params.properties)).toEqual([
      ...Object.keys(base.properties),
      "section_heading",
      "section_content",
      "expect_hash",
    ]);
    for (const key of Object.keys(base.properties)) {
      expect(params.properties[key]).toEqual(base.properties[key]);
    }
    expect(params.required).toEqual(base.required);
    // The section heading is a non-empty line; the others are plain optional strings.
    const { description: _h, ...heading } = params.properties.section_heading;
    const { description: _t, ...title } = base.properties.title;
    expect(heading).toEqual(title);
    for (const key of ["section_content", "expect_hash", "section_heading"]) {
      expect(String(params.properties[key].description).trim()).not.toBe("");
    }
    const said = spellParamNames(describeOperation(updatePageOp), updatePageOp.input, snake);
    expect(t.description.startsWith(`${said} `)).toBe(true);
    expect(t.description).not.toMatch(/MCP/);
  });
});

describe("get_page", () => {
  it("adds content_hash to galaxy-ops' own answer, keys and all", async () => {
    galaxyWithPage(markdownPage());
    const base = await runWithEnvelope(
      getPageOp,
      { pageId: PAGE_ID, includeRendered: false },
      galaxyOpsContext()!,
    );
    const seen = galaxyWithPage(markdownPage());
    const result = await run("get_page", { page_id: PAGE_ID });
    expect(seen).toEqual([{ method: "GET", path: `/api/pages/${PAGE_ID}` }]);
    const data = result.structuredContent.data as Record<string, unknown>;
    expect(Object.keys(data)).toEqual([...Object.keys(base.data as object), "content_hash"]);
    expect(data.content_hash).toBe(pageContentHash(BODY));
    expect(data).not.toHaveProperty("content");
    expect(result.structuredContent.message).toBe(base.message);
  });

  it("hashes the rendered body when the editable one is empty, and returns it when asked", async () => {
    galaxyWithPage(markdownPage({ content_editor: "", content: "<p>only rendered</p>" }));
    const result = await run("get_page", { page_id: PAGE_ID, include_rendered: true });
    const data = result.structuredContent.data as Record<string, unknown>;
    expect(data.content_hash).toBe(pageContentHash("<p>only rendered</p>"));
    expect(data.content).toBe("<p>only rendered</p>");
  });

  it("hashes an empty page as the empty string", async () => {
    galaxyWithPage(markdownPage({ content_editor: null, content: null }));
    const result = await run("get_page", { page_id: PAGE_ID });
    expect((result.structuredContent.data as { content_hash: string }).content_hash).toBe(
      pageContentHash(""),
    );
  });

  it("matches the hash update_page answers with after a write", async () => {
    galaxyWithPage(markdownPage());
    const written = await run("update_page", {
      page_id: PAGE_ID,
      section_heading: "## Plan",
      section_content: "## Plan\nnew plan",
    });
    const read = await run("get_page", { page_id: PAGE_ID });
    expect((read.structuredContent.data as { content_hash: string }).content_hash).toBe(
      (written.structuredContent.data as { content_hash: string }).content_hash,
    );
  });

  it("keeps galaxy-ops' parameters and says what content_hash is for", () => {
    const t = tool("get_page");
    expect(t.parameters).toEqual(renderOperation(getPageOp).parameters);
    const said = spellParamNames(describeOperation(getPageOp), getPageOp.input, snake);
    expect(t.description.startsWith(`${said} `)).toBe(true);
    expect(t.description).toContain("expect_hash");
  });
});
