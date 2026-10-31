import { describe, expect, it } from "vitest";
import {
  GALAXY_DEADLINE_TEXT,
  galaxyFailureKind,
  kindOfEnvelope,
  classifyGalaxyFailure,
  transportCode,
  type GalaxyFailureKind,
} from "../extensions/orbit/galaxy-failure";
import { runGalaxyCall, wrapGalaxyTool } from "../extensions/orbit/galaxy-tool-wrap";
import type { GalaxyTool } from "../extensions/orbit/galaxy-tool-source";
import { bareFamily } from "../shared/galaxy-tool-family.js";
import { GALAXY } from "./galaxy-family-fixture";

const BARE = bareFamily(["get_histories", "run_tool"]);

describe("kindOfEnvelope", () => {
  it("maps galaxy-ops' error kinds onto the kinds recovery has advice for", () => {
    expect(kindOfEnvelope("connection")).toBe("dropped");
    expect(kindOfEnvelope("auth")).toBe("auth");
    expect(kindOfEnvelope("service_outage")).toBe("service_outage");
    for (const kind of ["not_found", "validation", "version", "job_failed", "unknown", undefined])
      expect(kindOfEnvelope(kind)).toBeUndefined();
  });
});

/** The shape undici throws: a bare TypeError with the reason on cause. */
function fetchFailed(code: string, message = "some transport failure"): TypeError {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(message), { code }),
  });
}

describe("transportCode", () => {
  it("finds the code undici leaves on cause", () => {
    expect(transportCode(fetchFailed("UND_ERR_CONNECT_TIMEOUT"))).toBe("UND_ERR_CONNECT_TIMEOUT");
  });

  it("walks a nested cause chain", () => {
    const inner = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    const err = new TypeError("fetch failed", { cause: new Error("socket", { cause: inner }) });
    expect(transportCode(err)).toBe("ECONNRESET");
  });

  it("falls back to an AggregateError's first error", () => {
    const agg = new AggregateError([Object.assign(new Error("refused"), { code: "ECONNREFUSED" })]);
    expect(transportCode(new TypeError("fetch failed", { cause: agg }))).toBe("ECONNREFUSED");
  });

  it("ignores a numeric code and an error with none", () => {
    expect(transportCode(new DOMException("aborted", "AbortError"))).toBeUndefined();
    expect(transportCode(new TypeError("fetch failed"))).toBeUndefined();
    expect(transportCode(undefined)).toBeUndefined();
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
});

describe("classifyGalaxyFailure", () => {
  // Every text-only reading, so galaxyFailureKind without a recorded kind must agree with it.
  it.each([
    // The exact text a slow usegalaxy.org call produces.
    ["get_dataset_details", "Failed to call tool: Request timed out", "timeout"],
    ["run_tool", "MCP error -32001", "timeout"],
    // pi's own timeout wording.
    ["get_histories", "MCP request timed out after 300000ms", "timeout"],
    ["get_histories", GALAXY_DEADLINE_TEXT, "timeout"],
    // A body mentioning both is a timeout -- the actionable one.
    ["run_tool", "Request timed out; client not connected", "timeout"],
    ["get_histories", "Connection closed (-32000)", "dropped"],
    ["get_histories", "Failed to call tool: Not connected", "dropped"],
    ["get_histories", "Not connected to Galaxy. Authenticate via OAuth or run connect()...", null],
    ["get_histories", "Galaxy API 404: not found", null],
    ["get_histories", "No such history", null],
    ["bash", "Request timed out", null],
    ["run_tool", undefined, null],
    [undefined, "Request timed out", null],
  ] as [string | undefined, string | undefined, GalaxyFailureKind][])(
    "%s %j is %s",
    (tool, text, kind) => {
      expect(classifyGalaxyFailure(tool, text, GALAXY)).toBe(kind);
      for (const details of [
        undefined,
        {},
        { fullOutputPath: "/tmp/x", truncation: { truncated: true } },
        { galaxy: { tool: "get_histories" } },
      ]) {
        expect(galaxyFailureKind(details, text, tool, GALAXY)).toBe(kind);
      }
    },
  );
});
