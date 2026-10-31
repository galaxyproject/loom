// @vitest-environment node
/**
 * The browser shell's tool_call layers over Orbit's brain (slice 3, commit 14): misroutes sent
 * back to the shell's tool with the words the browser has always used, {{artifact}} placement, and
 * invented embeds.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGalaxyOpsToolSource } from "../../../../../extensions/orbit/galaxy-ops-tools";
import {
  registerGalaxyTools,
  setGalaxyToolSource,
} from "../../../../../extensions/orbit/galaxy-tool-source";
import { fenced, registerArtifactKinds } from "../../artifacts/kinds";
import type { Artifact } from "../tool";
import { registerBrowserLayers, registerFlavorLayers } from "./layers";

type Handler = (event: { toolName: string; input: Record<string, unknown> }) => Promise<unknown>;

// The four misroutes Olit's tools can draw, in the browser's words; written out here, since the
// core can't read a flavor's files.
const MISROUTES = [
  "'lineage_report' is an Olit tool, not a Galaxy tool. Call lineage_report directly.",
  "'vega_dataset' is an Olit tool, not a Galaxy tool. Call vega_dataset directly.",
  "'vega_dataset' is an Olit tool rather than a Galaxy tool, so the tool catalog does not hold it. It is already in your tool list if you need it.",
  "'lineage_report' is an Olit tool rather than a Galaxy tool, so the tool catalog does not hold it. It is already in your tool list if you need it.",
];

// A kind a page can show, as a flavor registers one (Olit's vega, for instance).
const toPage = (a: { spec: unknown }) => fenced("vega", JSON.stringify(a.spec));
registerArtifactKinds([{ kind: "test-chart", toPage } as never]);

const chart = {
  kind: "test-chart",
  title: "Read counts",
  spec: { mark: "bar" },
} as unknown as Artifact;

function layer(artifacts: Artifact[] = []) {
  let handler!: Handler;
  registerBrowserLayers({ on: (_event: string, h: Handler) => void (handler = h) } as never, {
    brandName: "Olit",
    shellTools: () => new Set(["lineage_report", "vega_dataset", "run_python"]),
    artifacts: async () => artifacts,
  });
  return (toolName: string, input: Record<string, unknown>) =>
    handler({ toolName, input }) as Promise<{ block?: boolean; reason?: string } | undefined>;
}

beforeEach(() => {
  setGalaxyToolSource(createGalaxyOpsToolSource());
  registerGalaxyTools({ registerTool: () => {} } as never);
});

afterEach(() => setGalaxyToolSource(null));

describe("the browser layers", () => {
  it("send a Galaxy call aimed at a shell tool back to it, in the browser brain's words", async () => {
    const call = layer();
    const reasons = [
      await call("run_tool", { history_id: "h1", tool_id: "lineage_report", inputs: {} }),
      await call("run_tool", { history_id: "h1", tool_id: "vega_dataset", inputs: {} }),
      await call("search_tools_by_name", { query: "vega_dataset" }),
      await call("search_tools_by_name", { query: "lineage_report" }),
    ].map((r) => r?.reason);
    expect(reasons).toEqual(MISROUTES);
    // A real Galaxy tool passes.
    expect(
      await call("run_tool", { history_id: "h1", tool_id: "cat1", inputs: {} }),
    ).toBeUndefined();
  });

  it("place an artifact named by a token, and refuse one inside a fence", async () => {
    const call = layer([chart]);
    const input = { page_id: "p1", content: "# Results\n\n{{artifact: Read counts}}\n" };
    expect(await call("update_page", input)).toBeUndefined();
    expect(input.content).not.toContain("{{artifact");
    expect(input.content).toContain("```");
    const fenced = await call("update_page", {
      page_id: "p1",
      content: "```markdown\n{{artifact}}\n```\n",
    });
    expect(fenced).toMatchObject({
      block: true,
      reason: expect.stringMatching(/^Refused: A token/),
    });
  });

  it("refuse a page write that holds an embed the model made up", async () => {
    const call = layer();
    const refused = await call("create_page", {
      title: "t",
      content: "# R\n\n{{visualization id=chart}}\n",
    });
    expect(refused).toMatchObject({ block: true, reason: expect.stringMatching(/^Refused: /) });
  });

  it("leave Orbit's own tools alone", async () => {
    const call = layer();
    expect(await call("galaxy_job_record", { tool_id: "lineage_report" })).toBeUndefined();
  });
});

describe("the flavor layers", () => {
  function flavored(annotate = async () => "[olit] that's a visualization" as string | undefined) {
    const handlers = new Map<string, (event: any, ctx?: any) => Promise<unknown>>();
    registerFlavorLayers(
      {
        on: (event: string, h: (event: any, ctx?: any) => Promise<unknown>) =>
          void handlers.set(event, h),
      } as never,
      {
        brandName: "Olit",
        annotators: [annotate],
        promptSections: ({ datasetId }) => ({
          afterIdentity: [`Opened on dataset ${datasetId}.`],
          terminology: ["- **visualization**: a Galaxy plugin that renders a dataset."],
        }),
        datasetId: async () => "d1",
        context: async () => ({}) as never,
      },
    );
    return handlers;
  }

  it("lead with the shell's identity and the flavor's opening lines, then Orbit's prompt and the flavor's terms", async () => {
    const before = flavored().get("before_agent_start")!;
    const result = (await before(
      { systemPrompt: "ORBIT" },
      { model: { id: "m", provider: "p" } },
    )) as {
      systemPrompt: string;
    };
    expect(result.systemPrompt).toBe(
      "You are Olit.\n\nOpened on dataset d1.\n\nORBIT\n\n## Olit terms\n\n- **visualization**: a Galaxy plugin that renders a dataset.",
    );
  });

  it("append a note to a Galaxy result an annotator has something to say about, and nothing else", async () => {
    const result = flavored().get("tool_result")!;
    const content = [{ type: "text", text: JSON.stringify({ data: [], success: true }) }];
    expect(
      await result({
        toolName: "search_tools_by_name",
        input: { query: "ngl" },
        content,
        isError: false,
      }),
    ).toEqual({
      content: [...content, { type: "text", text: "\n\n[olit] that's a visualization" }],
    });
    // Not a Galaxy tool, an error, or text that isn't the envelope: left alone.
    expect(
      await result({ toolName: "run_python", input: {}, content, isError: false }),
    ).toBeUndefined();
    expect(
      await result({ toolName: "search_tools_by_name", input: {}, content, isError: true }),
    ).toBeUndefined();
    expect(
      await result({
        toolName: "search_tools_by_name",
        input: {},
        content: [{ type: "text", text: "not json" }],
        isError: false,
      }),
    ).toBeUndefined();
  });
});
