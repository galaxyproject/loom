import {
  allOperations as forkOperations,
  GALAXY_MCP_SURFACE,
  malformedObjectIds as forkMalformedObjectIds,
  updatePageOp as forkUpdatePageOp,
  type AnyOperation,
  type GalaxyContext,
} from "@galaxyproject/galaxy-ops/browser";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { galaxyTools, OPS_POLICY } from "./galaxy-tools";
import { IWC_LISTINGS } from "./hints";
import { opsTools, snake } from "./ops";
import { WATCHED_TOOLS } from "./watch";
// Root's galaxy-ops (the fork's upstream) and the tool source Orbit builds from it. The browser
// entry is the one a bundled shell would load.
import { allOperations as rootOperations } from "../../../../node_modules/@galaxyproject/galaxy-ops/dist/index.browser.js";
import {
  createGalaxyOpsToolSource,
  renderOperation,
} from "../../../../extensions/loom/galaxy-ops-tools";
import { updatePageBridge } from "../../../../extensions/loom/galaxy-page-ops";
import { applySectionEdit } from "../../../../shared/markdown-sections.js";
import { malformedObjectIds } from "../../../../shared/malformed-object-ids.js";

const params = (tool: { parameters: Record<string, unknown> }) =>
  Object.keys((tool.parameters as { properties?: object }).properties ?? {}).sort();

/** Tools Olit runs on the browser's in-memory filesystem, which galaxy-mcp runs on disk. */
const LOCAL = new Set(["download_dataset", "upload_file"]);

describe("the Galaxy tool surface against galaxy-mcp", () => {
  // Olit's own tools keep galaxy-mcp's names and parameters, so a model told about galaxy-mcp's
  // tools can call them: a parameter it documents and Olit drops is one the model cannot pass.
  it("takes galaxy-mcp's parameters for every tool Olit runs itself", () => {
    for (const tool of galaxyTools()) {
      if (tool.name in GALAXY_MCP_SURFACE && !LOCAL.has(tool.name)) {
        expect(params(tool), tool.name).toEqual(
          Object.keys(GALAXY_MCP_SURFACE[tool.name]!.parameters).sort(),
        );
      }
    }
  });

  it("describes each galaxy-ops operation as galaxy-mcp advertises it, parameters included", () => {
    for (const tool of opsTools()) {
      const advertised = GALAXY_MCP_SURFACE[tool.name]!;
      expect(tool.description, tool.name).toBe(advertised.description);
      const properties = (
        tool.parameters as { properties: Record<string, { description?: string }> }
      ).properties;
      for (const [name, said] of Object.entries(advertised.parameters)) {
        if (said) expect(properties[name]?.description, `${tool.name}.${name}`).toBe(said);
      }
    }
  });

  it("offers each name once: a galaxy-ops operation and an Olit tool never share one", () => {
    const names = [...opsTools(), ...galaxyTools()].map((t) => t.name);
    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
  });

  it("offers every galaxy-mcp tool except the connection, which Olit's session already has", () => {
    const offered = new Set([...opsTools(), ...galaxyTools()].map((t) => t.name));
    const missing = Object.keys(GALAXY_MCP_SURFACE).filter((name) => !offered.has(name));
    expect(missing).toEqual(["connect"]);
  });

  it("keys every rule Olit adds to an operation on a name the tool surface still offers", () => {
    const offered = new Set([...opsTools(), ...galaxyTools()].map((t) => t.name));
    const keyed = [
      ...Object.keys(OPS_POLICY),
      ...WATCHED_TOOLS,
      ...IWC_LISTINGS,
      "get_invocations",
    ];
    expect(keyed.filter((name) => !offered.has(name))).toEqual([]);
  });
});

type JsonSchema = {
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  [key: string]: unknown;
};

/** The fork's own rendering of an operation, before Olit puts galaxy-mcp's words on it. */
function forkParameters(op: AnyOperation): JsonSchema {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(z.strictObject(op.input), {
    io: "input",
  }) as unknown as JsonSchema;
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([k, v]) => [snake(k), v]),
    ),
    ...(schema.required ? { required: schema.required.map(snake) } : {}),
  };
}

/** A schema with every description taken out, at any depth: names, types and bounds remain. */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shapeOf);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => k !== "description")
      .map(([k, v]) => [k, shapeOf(v)]),
  );
}

/** A Galaxy holding one page, which records the body of the PUT it is sent. */
function pageContext(page: Record<string, unknown>) {
  const sent: Record<string, unknown>[] = [];
  const response = new Response(null, { status: 200 });
  const ctx = {
    client: {
      GET: async () => ({ data: page, response }),
      PUT: async (_path: string, init: { body: Record<string, unknown> }) => {
        sent.push(init.body);
        return {
          data: { ...page, content_editor: init.body.content ?? page.content_editor },
          response,
        };
      },
    },
  } as unknown as GalaxyContext;
  return { ctx, sent };
}

const markdownPage = (body: string) => ({
  id: "5a1cde2f3b4c5d6e",
  title: "Notebook",
  content_format: "markdown",
  content_editor: body,
  content: null,
});

describe("Orbit's Galaxy tools against the browser's galaxy-ops fork", () => {
  const roots = new Map(
    ([...rootOperations] as unknown as AnyOperation[]).map((op) => [op.name, op]),
  );
  const forks = [...forkOperations] as unknown as AnyOperation[];
  // update_page is compared against Orbit's bridge below. get_history_contents' order is an enum
  // with its own wording in the fork and a plain string in root's galaxy-ops.
  const COMPARED_ELSEWHERE = new Set(["update_page", "get_history_contents"]);

  it("covers the fork's 42 operations, every one of which root has", () => {
    expect(forks).toHaveLength(42);
    expect(forks.filter((op) => !roots.has(op.name)).map((op) => op.name)).toEqual([]);
  });

  it.each(forks.filter((op) => !COMPARED_ELSEWHERE.has(op.name)).map((op) => [op.name, op]))(
    "%s: Orbit renders the parameters the fork renders",
    (name, op) => {
      expect(renderOperation(roots.get(name as string)!).parameters).toEqual(
        forkParameters(op as AnyOperation),
      );
    },
  );

  it("get_history_contents differs from the fork only in order's schema", () => {
    const root = renderOperation(roots.get("get_history_contents")!).parameters as JsonSchema;
    const fork = forkParameters(forks.find((op) => op.name === "get_history_contents")!);
    const { order: rootOrder, ...rootRest } = root.properties;
    const { order: forkOrder, ...forkRest } = fork.properties;
    expect(rootRest).toEqual(forkRest);
    expect(root.required).toEqual(fork.required);
    expect(Object.keys(root.properties)).toEqual(Object.keys(fork.properties));
    for (const order of [rootOrder, forkOrder]) {
      expect(order).toMatchObject({ type: "string", default: "hid-asc" });
    }
    // When root's galaxy-ops catches up this fails, and get_history_contents joins the rest.
    expect(rootOrder).not.toEqual(forkOrder);
  });

  it("update_page: the bridge takes the fork's parameters, in Orbit's words", () => {
    const bridge = createGalaxyOpsToolSource()
      .tools()
      .find((t) => t.name === "update_page")!.parameters as unknown as JsonSchema;
    const fork = forkParameters(forkUpdatePageOp as unknown as AnyOperation);
    expect(Object.keys(bridge.properties)).toEqual(Object.keys(fork.properties));
    expect(bridge.required).toEqual(fork.required);
    expect(shapeOf(bridge)).toEqual(shapeOf(fork));
  });

  const SECTION_CASES: [string, string, string, string][] = [
    [
      "a heading the page has",
      "# T\n\n## Plan\nold\n\n## Results\nr\n",
      "## Plan",
      "## Plan\nnew\n",
    ],
    ["a heading the page lacks", "# T\n\n## Plan\nold\n", "## Methods", "## Methods\nm"],
    ["a heading the page repeats", "## A\n1\n## B\n2\n## A\n3", "## A", "## A\nx"],
    ["a heading on the first line", "## Plan\nold\n## Next\nn", "## Plan", "## Plan\nnew"],
    ["text above the first heading", "intro\n\n## Plan\nold", "## Plan", "## Plan\nnew\n\n"],
    ["trailing blank lines", "## Plan\nold\n\n\n", "## Plan", "## Plan\nnew\n"],
    ["an empty page", "", "## Plan", "## Plan\nfirst"],
    [
      "lines that only look like headings",
      "#tag\n####### seven\n## Plan\nold",
      "## Plan",
      "## Plan\nnew",
    ],
    ["a heading inside fenced code", "## Plan\n```\n## Plan\n```\nold", "## Plan", "## Plan\nnew"],
    ["a near-miss heading line", "## Plan \nold\n## Plan\nkeep", "## Plan", "## Plan\nnew"],
  ];

  it.each(SECTION_CASES)(
    "a section edit writes what the fork writes, for %s",
    async (_name, body, heading, section) => {
      const args = { pageId: "5a1cde2f3b4c5d6e", sectionHeading: heading, sectionContent: section };
      const fork = pageContext(markdownPage(body));
      await forkUpdatePageOp.run(args, fork.ctx);
      const orbit = pageContext(markdownPage(body));
      await updatePageBridge.op.run(args, orbit.ctx);
      expect(orbit.sent).toEqual(fork.sent);
      expect(fork.sent[0]!.content).toBe(applySectionEdit(body, heading, section));
    },
  );

  const DIRECTIVE_CASES = [
    "plain prose naming history_dataset_id=3 outside any directive",
    "```galaxy\nhistory_dataset_display(history_dataset_id=3)\n```\n",
    "```galaxy\nhistory_dataset_display(history_dataset_id=f2db41e1fa331b3e)\n```\n",
    "```galaxy\nhistory_dataset_display(history_dataset_id=F2DB41E1FA331B3E)\n```\n",
    "```galaxy\njob_metrics(job_id=1cd8e2f6b131e8911cd8e2f6b131e891)\n```\n",
    "```galaxy\nworkflow_display(workflow_id=\"abc\", history_id='my-history')\n```\n",
    "```  galaxy title\ninvocation_time(invocation_id = 12)\n```\n",
    "```python\nhistory_id=3\n```\n",
    "See ${galaxy history_dataset_as_image(history_dataset_id=hid:7)} and ${galaxy job_parameters(job_id=1cd8e2f6b131e891)}.",
    "```galaxy\nhistory_dataset_collection_display(history_dataset_collection_id=1, implicit_collection_jobs_id=2)\n```\n```galaxy\nhistory_link(history_id=3)\n```",
    "",
  ];

  it.each(DIRECTIVE_CASES.map((c) => [c]))(
    "finds the malformed ids the fork finds in %j",
    (content) => {
      expect(malformedObjectIds(content)).toEqual(forkMalformedObjectIds(content));
    },
  );

  it("finds some malformed ids in the fixtures, so the comparison is not vacuous", () => {
    expect(DIRECTIVE_CASES.flatMap((c) => malformedObjectIds(c)).length).toBeGreaterThan(5);
  });
});
