import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerPlanTools } from "../extensions/loom/tools";
import { resetState, setNotebookPath } from "../extensions/loom/state";
import { MCP_FAMILY, bareFamily } from "../shared/galaxy-mcp-tools.js";

/**
 * The record tools name the submission tool they follow. Those names reach the
 * model, so they go through the family: the desktop must keep today's MCP
 * spelling byte for byte, and a bare shell must not tell the model to look for
 * an mcp__galaxy__ tool it does not have.
 *
 * The MCP strings below were copied from tools.ts at c5e3fae9, before the
 * family was threaded through, so they pin the desktop's exact bytes.
 */
const HEAD_INVOCATION_DESCRIPTION = `Name the plan step a Galaxy workflow invocation belongs to. The harness
records the run; you name the step it belongs to. Loom already wrote a \`loom-invocation\`
block the moment mcp__galaxy__invoke_workflow returned, so this normally just sets \`label\` and
\`notebook_anchor\` on the block already carrying that id -- the run is pollable either way.
If no block carries the id (a submission Loom could not see, such as one made from inside
code mode), this creates one. Both arguments are checked before anything is written: the
anchor must resolve in notebook.md, and the invocation id must exist on the Galaxy server.`;
const HEAD_INVOCATION_ID = "Galaxy invocation ID returned from mcp__galaxy__invoke_workflow";
const HEAD_INVOCATION_ABSENT =
  `Galaxy has no invocation "nothex!!" ("nothex!!" is not a Galaxy id (they are hex)). ` +
  `Nothing was recorded -- re-read the id from the mcp__galaxy__invoke_workflow result.`;

const HEAD_JOB_DESCRIPTION = `Name the plan step a Galaxy TOOL run belongs to, the same way
galaxy_invocation_record does for a workflow. The harness records the run; you name the step
it belongs to. Loom already wrote a \`loom-job\` block the moment mcp__galaxy__run_tool returned, so
this normally just sets \`label\` and \`notebook_anchor\` on the block already carrying that
job id -- the poller is watching it either way. If no block carries the id, this creates one.
Both arguments are checked before anything is written: the anchor must resolve in notebook.md,
and the job id must exist on the Galaxy server. \`toolId\` is used only when creating.`;
const HEAD_JOB_ID = "Galaxy job ID returned from mcp__galaxy__run_tool";
const HEAD_JOB_ABSENT =
  `Galaxy has no job "nothex!!" ("nothex!!" is not a Galaxy id (they are hex)). Nothing was recorded -- ` +
  `re-read the id from the mcp__galaxy__run_tool result. A tool run returns a job id, ` +
  `not a dataset id.`;

interface Registered {
  name: string;
  description: string;
  parameters: { properties: Record<string, { description?: string }> };
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ content: { text: string }[] }>;
}

function planTools(...args: unknown[]): Map<string, Registered> {
  const tools = new Map<string, Registered>();
  const pi = { registerTool: (t: Registered) => tools.set(t.name, t) };
  (registerPlanTools as (...a: unknown[]) => void)(pi, ...args);
  return tools;
}

async function absentMessage(tool: Registered, idKey: string): Promise<string> {
  const result = await tool.execute("call", {
    [idKey]: "nothex!!",
    notebookAnchor: "plan-a-step-1",
    label: "x",
  });
  return JSON.parse(result.content[0].text).error;
}

beforeEach(() => {
  resetState();
  // The id check runs before the notebook is touched, so the path need not exist.
  setNotebookPath("/nonexistent/loom-plan-tools/notebook.md");
});

afterEach(() => resetState());

describe("plan tools: model-facing names go through the family", () => {
  for (const [label, args] of [
    ["no family (the desktop default)", []],
    ["MCP_FAMILY", [MCP_FAMILY]],
  ] as const) {
    it(`keeps the desktop's exact strings with ${label}`, async () => {
      const tools = planTools(...args);
      const inv = tools.get("galaxy_invocation_record")!;
      const job = tools.get("galaxy_job_record")!;
      expect(inv.description).toBe(HEAD_INVOCATION_DESCRIPTION);
      expect(inv.parameters.properties.invocationId.description).toBe(HEAD_INVOCATION_ID);
      expect(await absentMessage(inv, "invocationId")).toBe(HEAD_INVOCATION_ABSENT);
      expect(job.description).toBe(HEAD_JOB_DESCRIPTION);
      expect(job.parameters.properties.jobId.description).toBe(HEAD_JOB_ID);
      expect(await absentMessage(job, "jobId")).toBe(HEAD_JOB_ABSENT);
    });
  }

  it("names the bare tools under a bare family", async () => {
    const tools = planTools(bareFamily(["run_tool", "invoke_workflow"]));
    const inv = tools.get("galaxy_invocation_record")!;
    const job = tools.get("galaxy_job_record")!;
    const bare = (s: string) => s.replaceAll("mcp__galaxy__", "");
    expect(inv.description).toBe(bare(HEAD_INVOCATION_DESCRIPTION));
    expect(inv.parameters.properties.invocationId.description).toBe(bare(HEAD_INVOCATION_ID));
    expect(await absentMessage(inv, "invocationId")).toBe(bare(HEAD_INVOCATION_ABSENT));
    expect(job.description).toBe(bare(HEAD_JOB_DESCRIPTION));
    expect(job.parameters.properties.jobId.description).toBe(bare(HEAD_JOB_ID));
    expect(await absentMessage(job, "jobId")).toBe(bare(HEAD_JOB_ABSENT));

    // Nothing else the plan tools register still says MCP to a bare shell.
    for (const t of tools.values()) {
      expect(JSON.stringify({ d: t.description, p: t.parameters })).not.toContain("mcp__galaxy__");
    }
  });
});
