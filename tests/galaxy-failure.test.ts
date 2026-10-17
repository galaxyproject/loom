import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  GALAXY_DEADLINE_TEXT,
  galaxyFailureKind,
  kindOfEnvelope,
} from "../extensions/loom/galaxy-failure";
import { classifyGalaxyFailure } from "../extensions/loom/galaxy-transport-error";
import { runGalaxyCall, wrapGalaxyTool } from "../extensions/loom/galaxy-tool-wrap";
import type { GalaxyTool } from "../extensions/loom/galaxy-tool-source";
import { galaxyRecoveryHint, registerMcpRecovery } from "../extensions/loom/mcp-recovery";
import { MCP_FAMILY, bareFamily, hasConnectTool } from "../shared/galaxy-mcp-tools.js";

const BARE = bareFamily(["get_histories", "run_tool"]);

describe("kindOfEnvelope", () => {
  it("maps galaxy-ops' error kinds onto the kinds recovery has advice for", () => {
    expect(kindOfEnvelope("connection")).toBe("dropped");
    expect(kindOfEnvelope("auth")).toBe("auth");
    for (const kind of ["not_found", "validation", "version", "job_failed", "unknown", undefined])
      expect(kindOfEnvelope(kind)).toBeUndefined();
  });
});

describe("galaxyFailureKind", () => {
  it("reads details.galaxy.kind before the text", () => {
    // The text alone reads as a dropped connection; the call says what it was.
    const text = "Connection closed (-32000)";
    expect(
      galaxyFailureKind(
        { galaxy: { tool: "get_histories", kind: "auth" } },
        text,
        "get_histories",
        BARE,
      ),
    ).toBe("auth");
    expect(
      galaxyFailureKind(
        { galaxy: { tool: "get_histories", kind: "timeout" } },
        "",
        "get_histories",
        BARE,
      ),
    ).toBe("timeout");
  });

  it("a typed envelope without recovery advice is never text-classified", async () => {
    // Galaxy's own words can carry an MCP wire phrase; the envelope's errorKind already said
    // what the failure was, and none of these has recovery advice.
    const cases: [string, string, string][] = [
      [
        "run_tool",
        "tool_request_rejected",
        "Tool request for upload1 was rejected: request timed out fetching URL (-32001)",
      ],
      ["get_histories", "not_found", "Not found (404): connection closed"],
      ["get_histories", "validation", "history_id: Not connected (-32000)"],
    ];
    for (const [tool, errorKind, message] of cases) {
      const result = await runGalaxyCall(
        tool,
        undefined,
        async () => ({ data: undefined, success: false, errorKind, message }) as never,
        { context: () => ({}) as never },
      );
      expect(result.isError).toBe(true);
      expect(
        galaxyFailureKind(
          result.details,
          result.content[0].text,
          tool,
          bareFamily(["run_tool", "get_histories"]),
        ),
      ).toBeNull();
    }
  });

  it("still text-classifies an extra, which records no kind", async () => {
    const extra: GalaxyTool = {
      name: "get_histories",
      label: "extra",
      description: "",
      parameters: {} as never,
      execute: async () => ({
        content: [{ type: "text", text: "Connection closed (-32000)" }],
        details: {},
        isError: true,
      }),
    };
    const result = await wrapGalaxyTool(extra).execute("c1", {}, undefined, undefined, {} as never);
    expect(result.details).not.toHaveProperty("galaxy.kind");
    const text = (result.content[0] as { text: string }).text;
    expect(galaxyFailureKind(result.details, text, "get_histories", BARE)).toBe("dropped");
  });

  it("falls back to the text classifier without a recorded kind", () => {
    expect(
      galaxyFailureKind(
        { galaxy: { tool: "get_histories" } },
        GALAXY_DEADLINE_TEXT,
        "get_histories",
        BARE,
      ),
    ).toBe("timeout");
    expect(
      galaxyFailureKind(undefined, "Failed to call tool: Not connected", "get_histories", BARE),
    ).toBe("dropped");
    expect(galaxyFailureKind({}, "No such history", "get_histories", BARE)).toBeNull();
  });

  it("classifies MCP results exactly as the text classifier does", () => {
    const cases: [string, string][] = [
      ["mcp__galaxy__get_dataset_details", "Failed to call tool: Request timed out"],
      ["mcp__galaxy__run_tool", "MCP error -32001"],
      ["mcp__galaxy__get_histories", "Connection closed (-32000)"],
      [
        "mcp__galaxy__get_histories",
        "Not connected to Galaxy. Authenticate via OAuth or run connect()...",
      ],
      ["mcp__galaxy__get_histories", "Galaxy API 404: not found"],
      ["bash", "Request timed out"],
    ];
    for (const [tool, text] of cases) {
      const details = { fullOutputPath: "/tmp/x", truncation: { truncated: true } };
      expect(galaxyFailureKind(details, text, tool)).toBe(classifyGalaxyFailure(tool, text));
      expect(galaxyFailureKind(undefined, text, tool, MCP_FAMILY)).toBe(
        classifyGalaxyFailure(tool, text, MCP_FAMILY),
      );
    }
  });
});

describe("hasConnectTool", () => {
  it("is true for the MCP family and false for a bare family without connect", () => {
    expect(hasConnectTool(MCP_FAMILY)).toBe(true);
    expect(hasConnectTool(BARE)).toBe(false);
    expect(hasConnectTool(bareFamily(["connect"]))).toBe(true);
  });
});

describe("recovery for a refused credential", () => {
  function harness() {
    const on = vi.fn();
    registerMcpRecovery({ on } as unknown as ExtensionAPI, BARE);
    const fire = (name: string, event: unknown) =>
      on.mock.calls.find(([key]) => key === name)![1](event);
    return {
      check: (toolName: string, input = {}) => fire("tool_call", { toolName, input }),
      result: (toolName: string, input: object, text: string, details: unknown) =>
        fire("tool_result", {
          toolName,
          input,
          content: [{ type: "text", text }],
          isError: true,
          details,
        }),
    };
  }

  it("tells the model to ask for /connect, not to retry", () => {
    const hint = galaxyRecoveryHint("run_tool", "auth", BARE);
    expect(hint).toContain("/connect");
    expect(hint).toContain("do not retry");
    expect(hint).not.toContain("UNKNOWN");
  });

  it("appends the auth hint and does not open a transport incident", () => {
    const h = harness();
    const env = JSON.stringify({ success: false, message: "Galaxy API 401", errorKind: "auth" });
    const details = { galaxy: { tool: "get_histories", kind: "auth", elapsedMs: 3 } };
    const out = h.result("get_histories", { limit: 5 }, env, details);
    expect(JSON.stringify(out.content)).toContain("Ask the user to run /connect");
    // An auth refusal is not a timed-out read, so the identical call is not blocked.
    expect(h.check("get_histories", { limit: 5 })).toBeUndefined();
  });

  it("reads the deadline's kind from details and blocks the identical read", () => {
    const h = harness();
    const env = JSON.stringify({ success: false, message: GALAXY_DEADLINE_TEXT });
    const details = { galaxy: { tool: "get_histories", kind: "timeout", elapsedMs: 300_000 } };
    expect(JSON.stringify(h.result("get_histories", { limit: 5 }, env, details).content)).toContain(
      "Narrow or paginate",
    );
    expect(h.check("get_histories", { limit: 5 })?.block).toBe(true);
  });
});
