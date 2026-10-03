import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { galaxyCall, registerMcpRecovery } from "../extensions/loom/mcp-recovery";

function harness() {
  const on = vi.fn();
  registerMcpRecovery({ on } as unknown as ExtensionAPI);
  const fire = (name: string, event: unknown) =>
    on.mock.calls.find(([key]) => key === name)![1](event);
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
  };
}

describe("Galaxy MCP recovery", () => {
  it("blocks catalog-wide schema fan-out before dispatch", () => {
    const h = harness();
    const decision = h.check("mcp__galaxy__search_tools_by_keywords", { keywords: ["tissue"] });
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("mcp__galaxy__search_tools_by_name");
    expect(decision.reason).toContain("input datatype");
    expect(h.check("mcp__galaxy__search_tools_by_name", { query: "tissue" })).toBeUndefined();
    expect(h.check("mcp__other__search_tools_by_keywords", {})).toBeUndefined();
  });

  it("adds actionable recovery for timeout failures, not a UI-only notice", () => {
    const result = harness().result("mcp__galaxy__get_histories", { limit: 100 });
    const text = JSON.stringify(result.content);
    expect(text).toContain("Narrow or paginate");
    expect(text).toContain("Continue the authorized task");
    expect(text).toContain("mcp__galaxy__connect()");
    expect(result.isError).toBeUndefined(); // never clear the original failure
  });

  it("tells the model to record an accepted submission that capture never saw", () => {
    // A timed-out submission is an error result, so the harness wrote no block
    // and nothing is polling it; recording it is the only way it gets watched.
    const text = JSON.stringify(
      harness().result("mcp__galaxy__run_tool", { tool_id: "fastp" }).content,
    );
    expect(text).toContain("may already have been accepted");
    expect(text).toContain("galaxy_job_record");
    expect(text).toContain("cannot capture");
  });

  it("prevents identical timed-out reads and allows a narrower request", () => {
    const h = harness();
    h.result("mcp__galaxy__get_histories", { limit: 100, offset: 0 });
    expect(h.check("mcp__galaxy__get_histories", { offset: 0, limit: 100 }).block).toBe(true);
    expect(h.check("mcp__galaxy__get_histories", { limit: 5 })).toBeUndefined();
    h.reset();
    expect(h.check("mcp__galaxy__get_histories", { limit: 100, offset: 0 })).toBeUndefined();
  });

  it("allows one identical read after a verified re-bind and bounds re-bind loops", () => {
    const h = harness();
    const args = { dataset_id: "fixture" };
    h.result("mcp__galaxy__get_dataset_details", args);
    expect(h.check("mcp__galaxy__connect")).toBeUndefined();
    h.result("mcp__galaxy__connect", {}, '{"success": true}', false);
    expect(h.check("mcp__galaxy__get_dataset_details", args)).toBeUndefined();
    h.result("mcp__galaxy__get_dataset_details", args);
    expect(h.check("mcp__galaxy__get_dataset_details", args).block).toBe(true);
    const capped = h.check("mcp__galaxy__connect");
    expect(capped.block).toBe(true);
    // Once the agent's attempt is spent, the user still needs a way out.
    expect(capped.reason).toContain("/mcp reconnect galaxy");
    h.reset();
    expect(h.check("mcp__galaxy__connect")).toBeUndefined();
  });

  it("does not cap or unlock anything outside an incident", () => {
    const h = harness();
    expect(h.check("mcp__galaxy__connect")).toBeUndefined();
    expect(h.check("mcp__galaxy__connect")).toBeUndefined();
  });

  it("does not unlock retries when the re-bind failed", () => {
    const h = harness();
    h.result("mcp__galaxy__get_histories");
    h.check("mcp__galaxy__connect");
    h.result("mcp__galaxy__connect", {}, "Failed to connect", true);
    expect(h.check("mcp__galaxy__get_histories").block).toBe(true);
  });

  it("allows later polling and a new recovery incident after a successful retry", () => {
    const h = harness();
    h.result("mcp__galaxy__get_histories");
    h.check("mcp__galaxy__connect");
    h.result("mcp__galaxy__connect", {}, '{"success": true}', false);
    expect(h.check("mcp__galaxy__get_histories")).toBeUndefined();
    h.result("mcp__galaxy__get_histories", {}, '{"success":true}', false);
    expect(h.check("mcp__galaxy__get_histories")).toBeUndefined();
    h.result("mcp__galaxy__get_histories");
    expect(h.check("mcp__galaxy__connect")).toBeUndefined();
  });

  it("requires outcome inspection for timed-out mutations and never replays them itself", () => {
    const h = harness();
    for (const name of [
      "mcp__galaxy__run_tool",
      "mcp__galaxy__invoke_workflow",
      "mcp__galaxy__upload_file_from_url",
      "mcp__galaxy__create_history",
      "mcp__galaxy__delete_user_tool",
    ]) {
      const text = JSON.stringify(h.result(name).content);
      expect(text).toContain("result is UNKNOWN");
      expect(text).toContain("Inspect the destination history");
      expect(text).toContain("Do not blindly repeat");
      expect(text).not.toContain("This was a read-only lookup");
    }
  });

  it("does not give read-only or session-binding calls the mutation warning", () => {
    const h = harness();
    const download = JSON.stringify(
      h.result("mcp__galaxy__download_dataset", { dataset_id: "d" }).content,
    );
    expect(download).toContain("This was a read-only lookup");
    expect(download).not.toContain("result is UNKNOWN");
    const connect = JSON.stringify(h.result("mcp__galaxy__connect").content);
    expect(connect).toContain("safe to call again once");
    expect(connect).not.toContain("result is UNKNOWN");
  });

  it("tells the agent a dropped connection comes back on its own", () => {
    for (const error of [
      "Connection closed (-32000)",
      "MCP connection closed",
      "MCP client is closed",
    ]) {
      const text = JSON.stringify(
        harness().result("mcp__galaxy__get_histories", {}, error).content,
      );
      expect(text).toContain("reconnects on the next call");
      expect(text).toContain("mcp__galaxy__connect()");
      expect(text).not.toContain("mcp(");
      expect(text).not.toContain("Run /mcp");
    }
  });

  it("recognizes pi's timeout wording", () => {
    const text = JSON.stringify(
      harness().result("mcp__galaxy__get_histories", {}, "MCP request timed out after 300000ms")
        .content,
    );
    expect(text).toContain("Narrow or paginate");
  });

  it("does not treat response data, auth errors, or non-Galaxy failures as transport failures", () => {
    const h = harness();
    expect(h.result("mcp__galaxy__get_histories", {}, "Request timed out", false)).toBeUndefined();
    expect(
      h.result("mcp__galaxy__get_histories", {}, "Not connected to Galaxy. Authenticate via OAuth"),
    ).toBeUndefined();
    expect(h.result("mcp__galaxy__get_histories", {}, "spawn uvx ENOENT")).toBeUndefined();
    expect(h.result("bash")).toBeUndefined();
    expect(h.result("mcp__other__get_histories")).toBeUndefined();
    // Loom's own galaxy_* tools are not galaxy-mcp calls.
    expect(h.result("galaxy_job_record")).toBeUndefined();
    expect(galaxyCall("galaxy_job_record", {})).toBeUndefined();
  });
});
