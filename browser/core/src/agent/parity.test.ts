import {
  allOperations as forkOperations,
  describeOperation,
  malformedObjectIds as forkMalformedObjectIds,
  spellParamNames,
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

describe("the Galaxy tool surface against galaxy-ops", () => {
  it("describes each galaxy-ops operation in galaxy-ops' words, as Orbit does, parameters included", () => {
    const forks = new Map(
      ([...forkOperations] as unknown as AnyOperation[]).map((op) => [op.name, op]),
    );
    for (const tool of opsTools()) {
      const op = forks.get(tool.name)!;
      expect(tool.description, tool.name).toBe(
        spellParamNames(describeOperation(op), op.input, snake),
      );
      expect(tool.parameters, tool.name).toMatchObject({
        properties: forkParameters(op).properties,
      });
    }
  });

  it("offers each name once: a galaxy-ops operation and an Olit tool never share one", () => {
    const names = [...opsTools(), ...galaxyTools()].map((t) => t.name);
    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
  });

  it("offers every galaxy-ops operation", () => {
    const offered = new Set([...opsTools(), ...galaxyTools()].map((t) => t.name));
    expect([...forkOperations].map((op) => op.name).filter((name) => !offered.has(name))).toEqual(
      [],
    );
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
  // galaxy-ops 0.5.0-ops.0 runs ahead of root's: operations root does not have yet, and ones whose
  // parameters the fork has extended. Each test below fails once root catches up.
  const FORK_ONLY = ["get_job_logs", "list_jobs", "get_user_tool"];
  const FORK_EXTENDED = [
    "get_invocations",
    "get_job_details",
    "get_tool_details",
    "get_workflow_input_template",
  ];
  const AHEAD = new Set([...FORK_ONLY, ...FORK_EXTENDED]);

  it("covers the fork's 45 operations, which root has but for the fork's newest", () => {
    expect(forks).toHaveLength(45);
    expect(forks.filter((op) => !roots.has(op.name)).map((op) => op.name)).toEqual(FORK_ONLY);
  });

  it.each(FORK_EXTENDED)("%s: the fork renders parameters root does not have yet", (name) => {
    const fork = forks.find((op) => op.name === name)!;
    expect(renderOperation(roots.get(name)!).parameters).not.toEqual(forkParameters(fork));
  });

  it.each(
    forks
      .filter((op) => !COMPARED_ELSEWHERE.has(op.name) && !AHEAD.has(op.name))
      .map((op) => [op.name, op]),
  )("%s: Orbit renders the parameters the fork renders", (name, op) => {
    expect(renderOperation(roots.get(name as string)!).parameters).toEqual(
      forkParameters(op as AnyOperation),
    );
  });

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
    const { section_heading: bridgeHeading, ...bridgeRest } = bridge.properties;
    const { section_heading: forkHeading, ...forkRest } = fork.properties;
    expect(shapeOf(bridgeRest)).toEqual(shapeOf(forkRest));
    // The fork takes "" for the text above the first heading; Orbit's bridge does not yet. When
    // it does this fails, and section_heading joins the rest.
    expect(shapeOf(forkHeading)).toEqual({ type: ["string", "null"] });
    expect(shapeOf(bridgeHeading)).toEqual({
      anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
    });
  });

  const SECTION_CASES: [string, string, string, string][] = [
    [
      "a heading the page has",
      "# T\n\n## Plan\nold\n\n## Results\nr\n",
      "## Plan",
      "## Plan\nnew\n",
    ],
    ["a heading the page lacks", "# T\n\n## Plan\nold\n", "## Methods", "## Methods\nm"],
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

  // Where Orbit's cut and the fork's disagree, Orbit's is the one both shells keep: a section
  // holds its subsections, fenced code holds no headings, and a repeated heading is refused. The
  // fork's update_page is slated for deletion; until then the browser's update_page policy hands
  // it a whole-page write of Orbit's cut (record-edit.test.ts) and never a section edit it would
  // cut its own way.
  const DIVERGENT: [string, string, string, string, string][] = [
    [
      "a section with subsections",
      "## Plan A\nq\n### Steps\n- [ ] 1\n## Plan B\nb",
      "## Plan A",
      "## Plan A\nq\n### Steps\n- [x] 1",
      "## Plan A\nq\n### Steps\n- [x] 1\n## Plan B\nb",
    ],
    [
      "a heading inside fenced code",
      "## Plan\n```\n## Plan\n```\nold",
      "## Plan",
      "## Plan\nnew",
      "## Plan\nnew",
    ],
  ];

  it.each(DIVERGENT)(
    "a section edit writes Orbit's cut, not the fork's, for %s",
    async (_name, body, heading, section, expected) => {
      const args = { pageId: "5a1cde2f3b4c5d6e", sectionHeading: heading, sectionContent: section };
      const fork = pageContext(markdownPage(body));
      await forkUpdatePageOp.run(args, fork.ctx);
      const orbit = pageContext(markdownPage(body));
      await updatePageBridge.op.run(args, orbit.ctx);
      expect(orbit.sent[0]!.content).toBe(expected);
      expect(applySectionEdit(body, heading, section)).toBe(expected);
      // When this fails the fork has caught up, and the case joins SECTION_CASES.
      expect(fork.sent[0]!.content).not.toBe(expected);
    },
  );

  it("refuses a heading the page repeats, which the fork would rewrite at every match", async () => {
    const body = "## Plan A\n### Steps\n1\n## Plan B\n### Steps\n2";
    const args = {
      pageId: "5a1cde2f3b4c5d6e",
      sectionHeading: "### Steps",
      sectionContent: "### Steps\nx",
    };
    const orbit = pageContext(markdownPage(body));
    await expect(updatePageBridge.op.run(args, orbit.ctx)).rejects.toThrow(
      /2 sections headed "### Steps".*"## Plan A", "## Plan B"/,
    );
    expect(orbit.sent).toEqual([]);
    const fork = pageContext(markdownPage(body));
    await forkUpdatePageOp.run(args, fork.ctx);
    expect(fork.sent[0]!.content).toBe("## Plan A\n### Steps\nx\n## Plan B\n### Steps\nx");
  });

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
