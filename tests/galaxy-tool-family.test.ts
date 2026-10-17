import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  MCP_FAMILY,
  bareFamily,
  galaxyMcpTool,
  galaxyMcpToolName,
} from "../shared/galaxy-mcp-tools.js";
import {
  MCP_RECOVERY_GUIDANCE,
  galaxyCall,
  galaxyRecoveryGuidance,
  galaxyRecoveryHint,
  registerMcpRecovery,
} from "../extensions/loom/mcp-recovery";
import {
  GALAXY_POLL_GUIDANCE,
  galaxyPollGuidance,
  registerGalaxyPollGuard,
} from "../extensions/loom/galaxy-poll-guard";
import { registerGalaxyRepeatGuard } from "../extensions/loom/galaxy-repeat-guard";
import { registerGalaxyHistoryGuard } from "../extensions/loom/galaxy-history-guard";
import { IWC_PLAN_NUDGE, isIwcLookup, iwcPlanNudge } from "../extensions/loom/iwc-plan-check";
import { observationToolName } from "../extensions/loom/observations";
import { registerProgressUpdates } from "../extensions/loom/progress-updates";
import { registerCaptureFollowThrough } from "../extensions/loom/galaxy-reconcile";
import { setGalaxyFetchOverride } from "../extensions/loom/galaxy-api";
import { fixtureFetch } from "../extensions/loom/galaxy-fixture";
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

// What a shell's in-process Galaxy tools look like: galaxy-ops has no connect
// operation, so nothing here can re-bind a session.
const NO_CONNECT = bareFamily([
  "get_dataset_details",
  "get_history_details",
  "get_iwc_workflow_details",
  "get_job_details",
  "get_tool_panel",
  "recommend_iwc_workflows",
  "run_tool",
  "run_user_tool",
  "search_iwc_workflows",
  "search_tools_by_keywords",
]);

// The poll guidance from before it took a family, pinned so "same bytes" means something.
const PINNED_POLL_GUIDANCE = `### Waiting for Galaxy and reporting progress

Give a short progress update before starting a long sequence of tools, at each
meaningful milestone, and about once a minute while actively working. Explain
what you verified, what is running, and what comes next. Do not claim scientific
success from a successful tool response alone.

Loom records every Galaxy submission itself, so a queued/running run is already
being watched: the background monitor checks every 15 seconds without model
calls and queues completion verification. Bind the run to its plan step with
galaxy_job_record or galaxy_invocation_record and a real notebook anchor; don't
record a job that belongs to a workflow invocation that is already recorded. If no other authorized work is ready, report the wait
and end the turn so the researcher can talk to you. Do not repeatedly call
mcp__galaxy__get_dataset_details, launch a shell polling loop, or use sleep to wait.
A successful metadata request does not mean the dataset has finished.
Repeated status reads of an unfinished resource have a two-minute cooldown.
`;

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

describe("guards under a bare family with no connect tool", () => {
  afterEach(() => {
    setGalaxyFetchOverride(null);
    vi.unstubAllEnvs();
  });

  it("the repeat guard counts bare failures and refuses the fourth identical call", () => {
    const fire = handlers((pi) => registerGalaxyRepeatGuard(pi, NO_CONNECT));
    const ctx = { signal: new AbortController().signal };
    for (let i = 0; i < 3; i++) {
      expect(
        fire("tool_call")({ toolName: "run_tool", toolCallId: `c${i}`, input: { a: 1 } }),
      ).toBeUndefined();
      fire("tool_result")({ toolCallId: `c${i}`, isError: true }, ctx);
    }
    expect(
      fire("tool_call")({ toolName: "run_tool", toolCallId: "c3", input: { a: 1 } })?.block,
    ).toBe(true);
    for (let i = 0; i < 4; i++) {
      expect(
        fire("tool_call")({ toolName: "bash", toolCallId: `b${i}`, input: {} }),
      ).toBeUndefined();
      fire("tool_result")({ toolCallId: `b${i}`, isError: true }, ctx);
    }
  });

  it("the history guard keys on a bare run_tool and nothing else", async () => {
    vi.stubEnv("GALAXY_URL", "https://galaxy.example.org");
    vi.stubEnv("GALAXY_API_KEY", "fixture-key");
    setGalaxyFetchOverride(
      fixtureFetch([
        {
          path: "/api/datasets/d1",
          responses: [{ status: 200, body: { id: "d1", name: "d1.txt", history_id: "elsewhere" } }],
        },
      ]),
    );
    const fire = handlers((pi) => registerGalaxyHistoryGuard(pi, NO_CONNECT));
    const input = { history_id: "here", inputs: { a: { src: "hda", id: "d1" } } };
    const refused = await fire("tool_call")({ toolName: "run_tool", toolCallId: "c1", input }, {});
    expect(refused?.block).toBe(true);
    expect(refused?.reason).toContain("Refused: these inputs are in another history");
    expect(
      await fire("tool_call")({ toolName: "get_dataset_details", toolCallId: "c2", input }, {}),
    ).toBeUndefined();
    expect(
      await fire("tool_call")({ toolName: "mcp__galaxy__run_tool", toolCallId: "c3", input }, {}),
    ).toBeUndefined();
  });

  it("the IWC plan check sees a bare lookup and names the bare tool in its nudge", () => {
    expect(isIwcLookup("recommend_iwc_workflows", NO_CONNECT)).toBe(true);
    expect(isIwcLookup("recommend_iwc_workflows")).toBe(false);
    expect(iwcPlanNudge(NO_CONNECT)).toContain("`recommend_iwc_workflows`");
    expect(iwcPlanNudge(NO_CONNECT)).not.toContain("mcp__galaxy__");
    expect(IWC_PLAN_NUDGE).toContain("`mcp__galaxy__recommend_iwc_workflows`");
  });

  it("observations spell a bare Galaxy call in wire spelling", () => {
    expect(observationToolName("run_tool", NO_CONNECT)).toBe("galaxy_run_tool");
    expect(observationToolName("bash", NO_CONNECT)).toBeUndefined();
    expect(observationToolName("mcp__galaxy__run_tool")).toBe("galaxy_run_tool");
    expect(observationToolName("run_tool")).toBeUndefined();
  });

  it("progress updates describe a bare submission as Galaxy work", () => {
    const notify = vi.fn();
    const fire = handlers((pi) => registerProgressUpdates(pi, NO_CONNECT));
    vi.useFakeTimers();
    try {
      fire("agent_start")({}, { hasUI: true, ui: { notify } });
      fire("tool_execution_start")({ toolName: "run_user_tool", toolCallId: "c1", args: {} });
    } finally {
      fire("agent_end")();
      vi.useRealTimers();
    }
    expect(notify).toHaveBeenCalledWith("Progress: submitting work to Galaxy.", "info");
  });

  it("the poll guidance names the bare status tool and the MCP constant is unchanged", () => {
    expect(galaxyPollGuidance(NO_CONNECT)).toContain(
      "Do not repeatedly call\nget_dataset_details,",
    );
    expect(galaxyPollGuidance(NO_CONNECT)).not.toContain("mcp__galaxy__");
    expect(GALAXY_POLL_GUIDANCE).toBe(PINNED_POLL_GUIDANCE);
  });

  it("recovery hints without a connect tool drop the re-bind and the saved-output reader", () => {
    const hint = galaxyRecoveryHint("get_tool_panel", "dropped", NO_CONNECT);
    expect(hint).not.toContain("connect()");
    expect(hint).not.toContain("mcp_read_output");
    expect(hint).not.toContain("mcp__galaxy__");
    expect(hint).toContain("fetch get_tool_panel once.");
    expect(hint).toContain("After one narrowed retry fails");
    // A bare family that does list connect (a test's pick) keeps the re-bind wording.
    expect(galaxyRecoveryHint("get_tool_panel", "dropped", BARE_FAMILY)).toContain(
      "Call connect() yourself",
    );
    const fire = handlers((pi) => registerMcpRecovery(pi, NO_CONNECT));
    const reason = fire("tool_call")({ toolName: "search_tools_by_keywords", input: {} })?.reason;
    expect(reason).toContain("one request per tool");
    expect(reason).not.toContain("MCP budget");
    expect(reason).not.toContain("mcp_read_output");
  });

  it("recovery guidance is the MCP text under MCP and an in-process text otherwise", () => {
    expect(galaxyRecoveryGuidance(MCP_FAMILY)).toBe(MCP_RECOVERY_GUIDANCE);
    const bare = galaxyRecoveryGuidance(NO_CONNECT);
    expect(bare).toContain("### Slow Galaxy requests");
    expect(bare).not.toContain("mcp_read_output");
    expect(bare).not.toContain("connect()");
    expect(bare).not.toContain("/mcp reconnect");
    expect(bare).toContain("prefer search_tools_by_name");
  });

  it("the capture follow-through's connect trigger is inert without a connect tool", async () => {
    const registerCommand = vi.fn();
    const on = vi.fn();
    registerCaptureFollowThrough({ on, registerCommand } as unknown as ExtensionAPI, NO_CONNECT);
    const end = on.mock.calls.find(([n]) => n === "tool_execution_end")![1];
    // Returns before queueing anything: no followThrough promise is created.
    await expect(end({ toolName: "connect", isError: false })).resolves.toBeUndefined();
  });
});
