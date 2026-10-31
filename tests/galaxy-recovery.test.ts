import { describe, expect, it } from "vitest";
import { GALAXY_DEADLINE_TEXT, type GalaxyCallKind } from "../extensions/orbit/galaxy-failure";
import {
  galaxyCall,
  galaxyRecoveryGuidance,
  galaxyRecoveryHint,
  registerGalaxyRecovery,
} from "../extensions/orbit/galaxy-recovery";
import { GALAXY } from "./galaxy-family-fixture";
import { guardHooks, SPELLED } from "./galaxy-test-helpers";

function harness() {
  const fire = guardHooks(registerGalaxyRecovery);
  return {
    check: (toolName: string, input = {}) => fire("tool_call", { toolName, input }),
    result: (
      toolName: string,
      input = {},
      text = "Failed to call tool: Request timed out",
      isError = true,
      details = {},
    ) =>
      fire("tool_result", { toolName, input, content: [{ type: "text", text }], isError, details }),
    reset: () => fire("input", {}),
    followUp: () => fire("input", { source: "extension" }),
  };
}

describe("Galaxy recovery guidance", () => {
  // The connected system-prompt snapshot pins the bytes; this pins the family's spelling.
  it("names the family's discovery tool", () => {
    const text = galaxyRecoveryGuidance(SPELLED);
    expect(text.startsWith("### Slow Galaxy requests\n")).toBe(true);
    expect(text).toContain("prefer gx_search_tools_by_name: it matches");
    expect(text).toContain("A timeout is an unknown result");
    expect(text).toContain("Never blindly replay a mutation");
    expect(text).toContain("one narrowed retry per incident");
  });
});

describe("Galaxy recovery", () => {
  it("blocks catalog-wide schema fan-out before dispatch", () => {
    const h = harness();
    const decision = h.check("search_tools_by_keywords", { keywords: ["tissue"] });
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("Use search_tools_by_name");
    expect(decision.reason).toContain("input datatype");
    expect(decision.reason).toContain("one request per tool");
    expect(decision.reason).not.toContain("MCP budget");
    expect(decision.reason).not.toContain("mcp_read_output");
    expect(h.check("search_tools_by_name", { query: "tissue" })).toBeUndefined();
    expect(h.check("mcp__other__search_tools_by_keywords", {})).toBeUndefined();
  });

  it("adds actionable recovery for timeout failures, not a UI-only notice", () => {
    const result = harness().result("get_histories", { limit: 100 });
    const text = JSON.stringify(result.content);
    expect(text).toContain("[loom Galaxy recovery]");
    expect(text).toContain("Narrow or paginate");
    expect(text).toContain("This was a read-only lookup.");
    expect(text).not.toContain("connect()");
    expect(result.isError).toBeUndefined(); // never clear the original failure
  });

  it("tells the model to record an accepted submission that capture never saw", () => {
    // A timed-out submission is an error result, so the harness wrote no block
    // and nothing is polling it; recording it is the only way it gets watched.
    const text = JSON.stringify(harness().result("run_tool", { tool_id: "fastp" }).content);
    expect(text).toContain("may already have been accepted");
    expect(text).toContain("galaxy_job_record");
    expect(text).toContain("cannot capture");
  });

  it("prevents identical timed-out reads and allows a narrower request", () => {
    const h = harness();
    h.result("get_histories", { limit: 100, offset: 0 });
    expect(h.check("get_histories", { offset: 0, limit: 100 }).block).toBe(true);
    expect(h.check("get_histories", { limit: 5 })).toBeUndefined();
    h.reset();
    expect(h.check("get_histories", { limit: 100, offset: 0 })).toBeUndefined();
  });

  it("another Galaxy call succeeding earns a timed-out read one identical retry", () => {
    const h = harness();
    const args = { job_id: "j1" };
    h.result("get_job_details", args, "timed out", true, {
      galaxy: { tool: "get_job_details", kind: "timeout" },
    });
    expect(h.check("get_job_details", args)?.block).toBe(true);
    // The same call succeeding is not news; a different one is Galaxy answering again.
    h.result("get_history_details", { history_id: "h1" }, "{}", false);
    expect(h.check("get_job_details", args)).toBeUndefined();
    // One retry per incident: timing out again blocks it until the user's next message.
    h.result("get_job_details", args, "timed out", true, {
      galaxy: { tool: "get_job_details", kind: "timeout" },
    });
    h.result("get_history_details", { history_id: "h1" }, "{}", false);
    expect(h.check("get_job_details", args)?.block).toBe(true);
    h.reset();
    expect(h.check("get_job_details", args)).toBeUndefined();
  });

  it("allows later polling and a new recovery incident after a successful retry", () => {
    const h = harness();
    h.result("get_histories");
    expect(h.check("get_histories").block).toBe(true);
    h.result("get_history_details", { history_id: "h1" }, "{}", false);
    expect(h.check("get_histories")).toBeUndefined();
    h.result("get_histories", {}, '{"success":true}', false);
    expect(h.check("get_histories")).toBeUndefined();
    h.result("get_histories");
    expect(h.check("get_histories").block).toBe(true);
  });

  it("requires outcome inspection for timed-out mutations and never replays them itself", () => {
    const h = harness();
    for (const name of [
      "run_tool",
      "invoke_workflow",
      "upload_file_from_url",
      "create_history",
      "delete_user_tool",
    ]) {
      const text = JSON.stringify(h.result(name).content);
      expect(text).toContain("result is UNKNOWN");
      expect(text).toContain("Inspect the destination history");
      expect(text).toContain("Do not blindly repeat");
      expect(text).not.toContain("This was a read-only lookup");
    }
  });

  it("does not give read-only calls the mutation warning", () => {
    const download = JSON.stringify(
      harness().result("download_dataset", { dataset_id: "d" }).content,
    );
    expect(download).toContain("This was a read-only lookup");
    expect(download).not.toContain("result is UNKNOWN");
  });

  it("does not treat response data, auth errors, or non-Galaxy failures as transport failures", () => {
    const h = harness();
    expect(h.result("get_histories", {}, "Request timed out", false)).toBeUndefined();
    expect(
      h.result("get_histories", {}, "Not connected to Galaxy. Authenticate via OAuth"),
    ).toBeUndefined();
    expect(h.result("bash")).toBeUndefined();
    expect(h.result("mcp__other__get_histories")).toBeUndefined();
    // Loom's own galaxy_* tools are not galaxy-ops calls.
    expect(h.result("galaxy_job_record")).toBeUndefined();
    expect(galaxyCall("galaxy_job_record", {}, GALAXY)).toBeUndefined();
    expect(galaxyCall("bash", {}, GALAXY)).toBeUndefined();
    expect(galaxyCall("run_tool", { a: 1 }, GALAXY)).toEqual({ name: "run_tool", args: { a: 1 } });
  });

  it("keeps a timed-out read blocked across an extension's follow-up, not a user's message", () => {
    // A poller auto-resume is sent as input from the extension; it is not the user moving on.
    const h = harness();
    h.result("get_histories", { limit: 100 });
    h.followUp();
    expect(h.check("get_histories", { limit: 100 }).block).toBe(true);
    h.reset();
    expect(h.check("get_histories", { limit: 100 })).toBeUndefined();
  });

  it("appends one dropped hint and does not block the retry", () => {
    const h = harness();
    const details = { galaxy: { tool: "get_history_details", kind: "dropped" } };
    const input = { history_id: "h1" };
    const result = h.result(
      "get_history_details",
      input,
      "Get history details failed: fetch failed",
      true,
      details,
    );
    expect(result?.content).toHaveLength(2);
    expect(result?.content.at(-1).text).toBe(
      galaxyRecoveryHint("get_history_details", "dropped", GALAXY),
    );
    expect(h.check("get_history_details", input)).toBeUndefined();
    expect(
      h.result("get_history_details", input, "x\n[loom Galaxy recovery]\ny", true, details),
    ).toBeUndefined();
  });

  it("appends the auth hint and does not open a transport incident", () => {
    const h = harness();
    const env = JSON.stringify({ success: false, message: "Galaxy API 401", errorKind: "auth" });
    const details = { galaxy: { tool: "get_histories", kind: "auth", elapsedMs: 3 } };
    const out = h.result("get_histories", { limit: 5 }, env, true, details);
    expect(JSON.stringify(out.content)).toContain("Ask the user to run /connect");
    // An auth refusal is not a timed-out read, so the identical call is not blocked.
    expect(h.check("get_histories", { limit: 5 })).toBeUndefined();
  });

  it("appends the outage hint and does not open a transport incident", () => {
    const h = harness();
    const env = JSON.stringify({
      success: false,
      message: "Galaxy is unavailable",
      errorKind: "service_outage",
    });
    const details = { galaxy: { tool: "get_histories", kind: "service_outage", elapsedMs: 3 } };
    const out = h.result("get_histories", { limit: 5 }, env, true, details);
    expect(JSON.stringify(out.content)).toContain("is down");
    expect(h.check("get_histories", { limit: 5 })).toBeUndefined();
  });

  it("reads the deadline's kind from details and blocks the identical read", () => {
    const h = harness();
    const env = JSON.stringify({ success: false, message: GALAXY_DEADLINE_TEXT });
    const details = { galaxy: { tool: "get_histories", kind: "timeout", elapsedMs: 300_000 } };
    const out = h.result("get_histories", { limit: 5 }, env, true, details);
    expect(JSON.stringify(out.content)).toContain("Narrow or paginate");
    expect(h.check("get_histories", { limit: 5 })?.block).toBe(true);
  });
});

describe("galaxyRecoveryHint", () => {
  it.each([
    [
      "a timed-out discovery call fetches once, without the saved-output reader",
      "get_tool_panel",
      "timeout",
      ["fetch get_tool_panel once.", "After one narrowed retry fails"],
      ["connect()", "mcp_read_output"],
    ],
    [
      "a timed-out read keeps narrowing without the saved-response advice",
      "get_history_details",
      "timeout",
      ["Narrow or paginate"],
      ["saved response"],
    ],
    [
      // galaxy-ops reports a 400 as a connection failure, so the advice must send the model to
      // the message rather than straight to "unreachable".
      "a dropped read gets retry-once advice, not the timeout's narrowing",
      "get_history_details",
      "dropped",
      [
        "Retrying the identical call once is safe",
        "read the error -- a rejected argument needs different input",
        "After one retry fails",
      ],
      ["MCP", "Narrow or paginate", "saved response", "connect()", "narrowed retry"],
    ],
    [
      "a dropped discovery call gets no discovery advice",
      "get_tool_panel",
      "dropped",
      [],
      ["fetch get_tool_panel once", "search_tools_by_name"],
    ],
    ...["run_tool", "create_history"].map((tool) => [
      `a dropped ${tool} is checked with a cheap read before any retry`,
      tool,
      "dropped",
      [
        "UNKNOWN",
        "record it with galaxy_job_record or galaxy_invocation_record",
        "check once with a cheap read",
      ],
      ["Narrow or paginate", "Retrying the identical call once is safe"],
    ]),
    [
      "a refused credential asks for /connect, not a retry",
      "run_tool",
      "auth",
      ["/connect", "do not retry"],
      ["UNKNOWN"],
    ],
    [
      "an outage says to wait, not investigate",
      "run_tool",
      "service_outage",
      ["is down", "Don't investigate or retry"],
      ["UNKNOWN", "/connect", "check once"],
    ],
  ] as [string, string, GalaxyCallKind, string[], string[]][])(
    "%s",
    (_name, tool, kind, contains, excludes) => {
      const hint = galaxyRecoveryHint(tool, kind, GALAXY);
      expect(hint.startsWith("[loom Galaxy recovery]\n")).toBe(true);
      for (const text of contains) expect(hint).toContain(text);
      for (const text of excludes) expect(hint).not.toContain(text);
    },
  );
});
