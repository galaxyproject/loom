import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  MCP_FAMILY,
  bareFamily,
  galaxyMcpTool,
  galaxyMcpToolName,
} from "../shared/galaxy-mcp-tools.js";
import {
  galaxyCall,
  galaxyRecoveryHint,
  registerMcpRecovery,
} from "../extensions/loom/mcp-recovery";
import { registerGalaxyPollGuard } from "../extensions/loom/galaxy-poll-guard";
import { registerSraImportGate } from "../extensions/loom/sra-import-gate";
import { submissionToolName } from "../extensions/loom/galaxy-submission-capture";
import {
  IWC_CANDIDATES_HINT,
  applySkillTriggers,
  iwcCandidatesHint,
  registerSkillTriggers,
  skillTriggers,
} from "../extensions/loom/skill-triggers";

vi.mock("../extensions/loom/state", async (orig) => ({
  ...(await orig<typeof import("../extensions/loom/state")>()),
  getNotebookPath: () => null,
}));

const BARE_FAMILY = bareFamily([
  "connect",
  "get_dataset_details",
  "get_history_details",
  "get_iwc_workflow_details",
  "get_job_details",
  "get_tool_panel",
  "recommend_iwc_workflows",
  "run_tool",
  "search_iwc_workflows",
  "search_tools_by_keywords",
]);

// The MCP wording from before families existed, pinned so "same bytes" means something.
const PINNED = {
  panel:
    "[loom Galaxy MCP recovery]\nThe connection reconnects on the next call. Call mcp__galaxy__connect() yourself once and check its result before continuing; do not ask the user to reconnect or restart Orbit.\nThis was a read-only lookup. Continue the authorized task using a smaller query or saved response.\nUse mcp__galaxy__search_tools_by_name with a specific name, ID, or description term (one term per call), then inspect schemas only for matching candidates. If a full catalog is needed, fetch mcp__galaxy__get_tool_panel once and search its saved response with mcp_read_output. Name searches do not establish absence of tools matching only an input datatype; inspect candidate input schemas when that distinction matters.\nDo the recovery now without another permission question. After one narrowed retry and one re-bind fail, report a concrete blocker rather than looping. Respect Stop/pause.",
  run: "[loom Galaxy MCP recovery]\nNarrow or paginate the request before one read-only retry; do not repeat the same expensive call. If even a small request times out, call mcp__galaxy__connect() once and check the result.\nThis operation may already have been accepted by Galaxy. Its result is UNKNOWN. Inspect the destination history, jobs/invocations or affected resource before considering any retry. Reuse accepted work, and if you find the accepted job or invocation, record it with galaxy_job_record or galaxy_invocation_record -- Loom cannot capture a submission whose call failed. Do not blindly repeat a submission, upload, create, update or delete; do not invent IDs or claim success.\n\nDo the recovery now without another permission question. After one narrowed retry and one re-bind fail, report a concrete blocker rather than looping. Respect Stop/pause.",
  connect:
    "[loom Galaxy MCP recovery]\nNarrow or paginate the request before one read-only retry; do not repeat the same expensive call. If even a small request times out, call mcp__galaxy__connect() once and check the result.\nmcp__galaxy__connect only binds this session and changes nothing in Galaxy; it is safe to call again once.\n\nDo the recovery now without another permission question. After one narrowed retry and one re-bind fail, report a concrete blocker rather than looping. Respect Stop/pause.",
  keywords:
    "This Galaxy search expands into input-schema requests for the entire installed tool catalog and can exceed the five-minute MCP budget. Use mcp__galaxy__search_tools_by_name with a specific name, ID, or description term (one term per call), then inspect schemas only for matching candidates. If a full catalog is needed, fetch mcp__galaxy__get_tool_panel once and search its saved response with mcp_read_output. Name searches do not establish absence of tools matching only an input datatype; inspect candidate input schemas when that distinction matters. Continue discovery now; no user approval is needed.",
  iwc: "[loom] These are ranked by word overlap, not relevance. Before offering one, call `mcp__galaxy__get_iwc_workflow_details` on the plausible candidates and check their inputs against the data the user actually has (reads vs count tables, paired vs single-end). A workflow that needs another's outputs first is half of a chain, not a match. If none fit, say so. If nothing came back, retry once with just the assay; if the query had no searchable terms, ask the user what they want to find out.",
};

function handlers(register: (pi: ExtensionAPI) => void) {
  const on = vi.fn();
  register({ on } as unknown as ExtensionAPI);
  return (name: string) => on.mock.calls.find(([n]) => n === name)![1];
}

describe("Galaxy tool-name families", () => {
  it("MCP_FAMILY is galaxyMcpTool and galaxyMcpToolName", () => {
    for (const name of [
      "mcp__galaxy__run_tool",
      "mcp__galaxy___x",
      "galaxy_job_record",
      "",
      undefined,
    ]) {
      expect(MCP_FAMILY.toolName(name)).toBe(galaxyMcpToolName(name));
    }
    expect(MCP_FAMILY.tool("run_tool")).toBe(galaxyMcpTool("run_tool"));
  });

  it("a bare family names its Galaxy tools by themselves and claims nothing else", () => {
    expect(BARE_FAMILY.tool("run_tool")).toBe("run_tool");
    expect(BARE_FAMILY.toolName("run_tool")).toBe("run_tool");
    expect(BARE_FAMILY.toolName("bash")).toBeUndefined();
    expect(BARE_FAMILY.toolName("get_weather")).toBeUndefined();
    expect(BARE_FAMILY.toolName("")).toBeUndefined();
    expect(BARE_FAMILY.toolName(undefined)).toBeUndefined();
  });

  it("MCP guard text is unchanged", () => {
    expect(galaxyRecoveryHint("mcp__galaxy__get_tool_panel", "dropped")).toBe(PINNED.panel);
    expect(galaxyRecoveryHint("mcp__galaxy__run_tool", "timeout")).toBe(PINNED.run);
    expect(galaxyRecoveryHint("mcp__galaxy__connect", "timeout")).toBe(PINNED.connect);
    const fire = handlers((pi) => registerMcpRecovery(pi));
    expect(
      fire("tool_call")({ toolName: "mcp__galaxy__search_tools_by_keywords", input: {} })?.reason,
    ).toBe(PINNED.keywords);
    expect(IWC_CANDIDATES_HINT).toBe(PINNED.iwc);
  });
});

describe("guards under the bare family", () => {
  it("mcp-recovery recognizes bare calls and names bare tools in its hints", () => {
    expect(galaxyCall("connect", {}, BARE_FAMILY)).toEqual({ name: "connect", args: {} });
    const hint = galaxyRecoveryHint("get_tool_panel", "dropped", BARE_FAMILY);
    expect(hint).toContain("Call connect() yourself");
    expect(hint).toContain("fetch get_tool_panel once");
    expect(hint).not.toContain("mcp__galaxy__");
    expect(galaxyCall("bash", {}, BARE_FAMILY)).toBeUndefined();
    const fire = handlers((pi) => registerMcpRecovery(pi, BARE_FAMILY));
    expect(fire("tool_call")({ toolName: "search_tools_by_keywords", input: {} })?.block).toBe(
      true,
    );
  });

  it("mcp-recovery classifies a bare transport failure and blocks the identical retry", () => {
    const fire = handlers((pi) => registerMcpRecovery(pi, BARE_FAMILY));
    const timedOut = (toolName: string) => ({
      toolName,
      input: { history_id: "h1" },
      isError: true,
      content: [{ type: "text", text: "MCP error -32001: Request timed out" }],
    });
    const result = fire("tool_result")(timedOut("get_history_details"));
    expect(result?.content.at(-1).text).toContain("[loom Galaxy MCP recovery]");
    expect(
      fire("tool_call")({ toolName: "get_history_details", input: { history_id: "h1" } })?.block,
    ).toBe(true);
    expect(fire("tool_result")(timedOut("bash"))).toBeUndefined();
    expect(fire("tool_call")({ toolName: "bash", input: { history_id: "h1" } })).toBeUndefined();
  });

  it("the poll guard holds a repeated bare status read", async () => {
    vi.useFakeTimers();
    try {
      const fire = handlers((pi) => registerGalaxyPollGuard(pi, BARE_FAMILY));
      const ctx = { hasUI: false, signal: new AbortController().signal } as ExtensionContext;
      const result = fire("tool_result")(
        {
          toolName: "get_dataset_details",
          input: { dataset_id: "d1" },
          isError: false,
          content: [{ type: "text", text: JSON.stringify({ state: "running" }) }],
        },
        ctx,
      );
      expect(result?.content).toHaveLength(2);
      let released = false;
      const held = fire("tool_call")(
        { toolName: "get_dataset_details", input: { dataset_id: "d1" } },
        ctx,
      ).then(() => (released = true));
      await vi.advanceTimersByTimeAsync(1000);
      expect(released).toBe(false);
      await vi.runAllTimersAsync();
      await held;
    } finally {
      vi.useRealTimers();
    }
  });

  it("the SRA gate sees a bare run_tool", () => {
    const fire = handlers((pi) => registerSraImportGate(pi, BARE_FAMILY));
    const calls = ["SRR1", "SRR2"].map((acc, i) => ({
      type: "toolCall" as const,
      id: `c${i}`,
      name: "run_tool",
      arguments: {
        history_id: "h",
        tool_id: "toolshed.g2.bx.psu.edu/repos/iuc/sra_tools/fasterq_dump/3.1.1+galaxy1",
        inputs: { "input|input_select": "accession_number", "input|accession": acc },
      },
    }));
    fire("message_end")({ message: { role: "assistant", content: calls } });
    const decision = fire("tool_call")({
      toolName: "run_tool",
      toolCallId: "c0",
      input: calls[0].arguments,
    });
    expect(decision?.block).toBe(true);
  });

  it("submission capture maps bare names onto the submission table", () => {
    expect(submissionToolName("run_tool", BARE_FAMILY)).toBe("mcp__galaxy__run_tool");
    expect(submissionToolName("galaxy_upload_local_file", BARE_FAMILY)).toBe(
      "galaxy_upload_local_file",
    );
    expect(submissionToolName("get_history", BARE_FAMILY)).toBeUndefined();
    expect(submissionToolName("run_tool")).toBeUndefined();
    expect(submissionToolName("mcp__galaxy__run_tool")).toBe("mcp__galaxy__run_tool");
  });

  it("the IWC hint fires on bare names and names the bare details tool", () => {
    expect(iwcCandidatesHint(BARE_FAMILY)).not.toContain("mcp__galaxy__");
    const out = applySkillTriggers(
      {
        toolName: "search_iwc_workflows",
        isError: false,
        content: [{ type: "text", text: "[]" }],
      },
      () => [],
      skillTriggers(BARE_FAMILY),
    );
    expect(out?.content[0].text).toContain("`get_iwc_workflow_details`");
  });

  it("registerSkillTriggers hands its family to the IWC hint", () => {
    const on = vi.fn();
    registerSkillTriggers({ on, getActiveTools: () => [] } as unknown as ExtensionAPI, BARE_FAMILY);
    const messageEnd = on.mock.calls.find(([n]) => n === "message_end")![1];
    const out = messageEnd({
      message: {
        role: "toolResult",
        toolName: "search_iwc_workflows",
        toolCallId: "c1",
        isError: false,
        content: [{ type: "text", text: "[]" }],
      },
    });
    expect(out?.message.content[0].text).toContain("`get_iwc_workflow_details`");
  });
});
