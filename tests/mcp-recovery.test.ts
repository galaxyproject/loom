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
  it("blocks catalog-wide schema fan-out before dispatch, including proxy calls", () => {
    const h = harness();
    for (const [name, input] of [
      ["galaxy_search_tools_by_keywords", { keywords: ["tissue"] }],
      ["mcp__galaxy__search_tools_by_keywords", { keywords: ["tissue"] }],
      [
        "mcp",
        { server: "galaxy", tool: "search_tools_by_keywords", args: '{"keywords":["tissue"]}' },
      ],
    ] as const) {
      const decision = h.check(name, input);
      expect(decision.block).toBe(true);
      expect(decision.reason).toContain("galaxy_search_tools_by_name");
      expect(decision.reason).toContain("input datatype");
    }
    expect(h.check("galaxy_search_tools_by_name", { query: "tissue" })).toBeUndefined();
    expect(h.check("mcp", { server: "other", tool: "search_tools_by_keywords" })).toBeUndefined();
  });

  it("adds actionable recovery for direct and proxy timeout failures, not a UI-only notice", () => {
    const h = harness();
    for (const [name, input] of [
      ["galaxy_get_histories", { limit: 100 }],
      ["mcp", { server: "galaxy", tool: "get_histories", args: { limit: 100 } }],
    ] as const) {
      const result = h.result(name, input);
      const text = JSON.stringify(result.content);
      expect(text).toContain("Narrow or paginate");
      expect(text).toContain("Continue the authorized task");
      expect(text).toContain("connect");
      expect(result.isError).toBeUndefined(); // never clear the original failure
    }
  });

  it("tells the model to record an accepted submission that capture never saw", () => {
    // A timed-out submission is an error result, so the harness wrote no block
    // and nothing is polling it; recording it is the only way it gets watched.
    const text = JSON.stringify(harness().result("galaxy_run_tool", { tool_id: "fastp" }).content);
    expect(text).toContain("may already have been accepted");
    expect(text).toContain("galaxy_job_record");
    expect(text).toContain("cannot capture");
  });

  it("prevents identical timed-out reads and allows a narrower request", () => {
    const h = harness();
    h.result("galaxy_get_histories", { limit: 100, offset: 0 });
    expect(h.check("galaxy_get_histories", { offset: 0, limit: 100 }).block).toBe(true);
    expect(
      h.check("mcp", { tool: "galaxy_get_histories", args: '{"limit":100,"offset":0}' }).block,
    ).toBe(true);
    expect(h.check("galaxy_get_histories", { limit: 5 })).toBeUndefined();
    h.reset();
    expect(h.check("galaxy_get_histories", { limit: 100, offset: 0 })).toBeUndefined();
  });

  it("allows one identical read after a verified reconnect and bounds reconnect loops", () => {
    const h = harness();
    const args = { dataset_id: "fixture" };
    h.result("galaxy_get_dataset_details", args);
    expect(h.check("mcp", { connect: "galaxy" })).toBeUndefined();
    h.result("mcp", { connect: "galaxy" }, "connected", false, { mode: "list", server: "galaxy" });
    expect(h.check("galaxy_get_dataset_details", args)).toBeUndefined();
    h.result("galaxy_get_dataset_details", args);
    expect(h.check("galaxy_get_dataset_details", args).block).toBe(true);
    const capped = h.check("mcp", { connect: "galaxy" });
    expect(capped.block).toBe(true);
    // Once the agent's attempt is spent, the user still needs a way out.
    expect(capped.reason).toContain("/mcp reconnect galaxy");
    expect(h.check("mcp", { connect: "other" })).toBeUndefined();
    h.reset();
    expect(h.check("mcp", { connect: "galaxy" })).toBeUndefined();
  });

  it("does not unlock retries when reconnect failed but the proxy isError flag is false", () => {
    const h = harness();
    h.result("galaxy_get_histories");
    h.result("mcp", { connect: "galaxy" }, "Failed", false, {
      mode: "connect",
      error: "connect_failed",
    });
    expect(h.check("galaxy_get_histories").block).toBe(true);
  });

  it("allows later polling and a new recovery incident after a successful retry", () => {
    const h = harness();
    h.result("galaxy_get_histories");
    h.check("mcp", { connect: "galaxy" });
    h.result("mcp", { connect: "galaxy" }, "connected", false, { mode: "list" });
    expect(h.check("galaxy_get_histories")).toBeUndefined();
    h.result("galaxy_get_histories", {}, '{"success":true}', false);
    expect(h.check("galaxy_get_histories")).toBeUndefined();
    h.result("galaxy_get_histories");
    expect(h.check("mcp", { connect: "galaxy" })).toBeUndefined();
  });

  it("requires outcome inspection for timed-out mutations and never replays them itself", () => {
    const h = harness();
    for (const name of [
      "galaxy_run_tool",
      "galaxy_invoke_workflow",
      "galaxy_upload_file_from_url",
      "galaxy_create_history",
      "galaxy_delete_user_tool",
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
      h.result("galaxy_download_dataset", { dataset_id: "d" }).content,
    );
    expect(download).toContain("This was a read-only lookup");
    expect(download).not.toContain("result is UNKNOWN");
    const connect = JSON.stringify(h.result("galaxy_connect").content);
    expect(connect).toContain("safe to call again after reconnecting");
    expect(connect).not.toContain("result is UNKNOWN");
  });

  it("gives dropped connections an agent-callable reconnect", () => {
    const text = JSON.stringify(
      harness().result("galaxy_get_histories", {}, "Connection closed (-32000)").content,
    );
    expect(text).toContain("mcp(");
    expect(text).toContain("yourself once");
    expect(text).not.toContain("Run /mcp");
  });

  it("recognizes adapter proxy errors that carry details.error instead of isError", () => {
    const h = harness();
    expect(
      h.result("mcp", { server: "galaxy", tool: "get_histories" }, "Request timed out", false, {
        error: "call_failed",
      }),
    ).toBeDefined();
  });

  it("does not treat response data, auth errors, or non-Galaxy failures as transport failures", () => {
    const h = harness();
    expect(h.result("galaxy_get_histories", {}, "Request timed out", false)).toBeUndefined();
    expect(
      h.result("galaxy_get_histories", {}, "Not connected to Galaxy. Authenticate via OAuth"),
    ).toBeUndefined();
    expect(h.result("galaxy_get_histories", {}, "spawn uvx ENOENT")).toBeUndefined();
    expect(h.result("bash")).toBeUndefined();
    expect(h.result("mcp", { server: "other", tool: "get_histories" })).toBeUndefined();
    expect(
      galaxyCall("mcp", { server: "galaxy", tool: "get_histories", args: "invalid" }),
    ).toBeUndefined();
  });
});
