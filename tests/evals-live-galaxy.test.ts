import { describe, it, expect } from "vitest";
import { evaluate } from "../evals/lib/assertions";
import { filterScenarioDirs } from "../evals/lib/select";
import { makeRunId, substituteRunId, uvCacheEnv } from "../evals/lib/runner";
import {
  EVAL_HISTORY_PREFIX,
  purgeEvalHistories,
  selectEvalHistories,
  type FetchLike,
} from "../evals/lib/galaxy-teardown";
import type { AnyEvent, Assertions, ScenarioRun } from "../evals/lib/types";

function run(events: AnyEvent[], assertions: Assertions): ScenarioRun {
  return {
    scenarioDir: "/tmp/x",
    scenario: { name: "t", tier: 2, inputs: ["go"], assertions },
    model: null,
    exitCode: 0,
    events,
    stdout: "",
    stderr: "",
    notebookContent: null,
    activityEvents: [],
    failures: [],
    durationMs: 1,
  };
}

function end(toolName: string, text: string, opts: { isError?: boolean; details?: object } = {}) {
  return {
    type: "tool_execution_end",
    toolName,
    isError: opts.isError ?? false,
    result: { content: [{ type: "text", text }], details: opts.details ?? {} },
  };
}

function chat(text: string): AnyEvent {
  return { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } };
}

describe("evals toolResults assertions", () => {
  const userResult = end("mcp__galaxy__get_user", '{"data":{"username":"alice","id":"1"}}', {
    details: { server: "galaxy", tool: "get_user" },
  });

  it("mustSucceed passes on a matching non-error result", () => {
    const failures = evaluate(
      run([userResult], {
        toolResults: {
          mustSucceed: [
            {
              name: "mcp__galaxy__get_user",
              detailsContains: { server: "galaxy" },
              textContains: "username",
            },
          ],
        },
      }),
    );
    expect(failures).toEqual([]);
  });

  it("mustSucceed fails on an error result, wrong details, or missing text", () => {
    const errored = end("mcp__galaxy__get_user", "Tool not found", { isError: true });
    for (const [events, expectation] of [
      [[errored], { name: "mcp__galaxy__get_user" }],
      [[userResult], { name: "mcp__galaxy__get_user", detailsContains: { server: "brc" } }],
      [[userResult], { name: "mcp__galaxy__get_user", textContains: "[loom MCP output" }],
      [[], { name: "mcp__galaxy__get_user" }],
    ] as const) {
      const failures = evaluate(
        run([...events], { toolResults: { mustSucceed: [{ ...expectation }] } }),
      );
      expect(failures.map((f) => f.assertion)).toEqual(["toolResults.mustSucceed"]);
    }
  });

  it("mustNotSucceed tolerates a blocked call but not a successful one", () => {
    const blocked = end("mcp__galaxy__update_history", "Destructive op denied", { isError: true });
    const ok = end("mcp__galaxy__update_history", '{"data":{"deleted":true}}');
    const assertions: Assertions = {
      toolResults: { mustNotSucceed: ["mcp__galaxy__update_history"] },
    };
    expect(evaluate(run([blocked], assertions))).toEqual([]);
    expect(evaluate(run([blocked, ok], assertions)).map((f) => f.assertion)).toEqual([
      "toolResults.mustNotSucceed",
    ]);
  });

  it("echoedInChat requires the captured value in the chat", () => {
    const assertions: Assertions = {
      toolResults: {
        echoedInChat: [{ name: "mcp__galaxy__get_user", pattern: '"username":\\s*"([^"]+)"' }],
      },
    };
    expect(evaluate(run([userResult, chat("You are alice.")], assertions))).toEqual([]);
    const miss = evaluate(run([userResult, chat("You are bob.")], assertions));
    expect(miss.map((f) => f.detail)).toEqual([
      "chat never repeated the 'mcp__galaxy__get_user' value \"alice\"",
    ]);
    const noResult = evaluate(run([chat("You are alice.")], assertions));
    expect(noResult[0].detail).toMatch(/no successful 'mcp__galaxy__get_user' result/);
  });
});

describe("evals scenario selection", () => {
  const dirs = ["/s/galaxy-mcp-a", "/s/galaxy-mcp-b", "/s/routing-clear-galaxy", "/s/galaxy"];

  it("an exact name wins over a prefix", () => {
    expect(filterScenarioDirs(dirs, "galaxy")).toEqual(["/s/galaxy"]);
  });

  it("a non-exact filter selects the whole prefix family", () => {
    expect(filterScenarioDirs(dirs, "galaxy-mcp")).toEqual(["/s/galaxy-mcp-a", "/s/galaxy-mcp-b"]);
  });

  it("no filter selects everything", () => {
    expect(filterScenarioDirs(dirs, undefined)).toEqual(dirs);
  });
});

describe("evals uv cache passthrough", () => {
  it("defaults to the real home's cache and honors explicit settings", () => {
    expect(uvCacheEnv({}, "/home/u")).toEqual({
      UV_CACHE_DIR: "/home/u/.cache/uv",
      UV_PYTHON_INSTALL_DIR: "/home/u/.local/share/uv/python",
    });
    expect(uvCacheEnv({ UV_CACHE_DIR: "/c", XDG_DATA_HOME: "/d" }, "/home/u")).toEqual({
      UV_CACHE_DIR: "/c",
      UV_PYTHON_INSTALL_DIR: "/d/uv/python",
    });
  });
});

describe("evals run ids", () => {
  it("are timestamped, unique-ish, and substituted everywhere", () => {
    const id = makeRunId(new Date("2026-10-03T12:34:56.789Z"), () => 0.5);
    expect(id).toMatch(/^20261003123456-[0-9a-z]{4}$/);
    expect(substituteRunId("loom-eval-x-{{RUN_ID}} and {{RUN_ID}}", id)).toBe(
      `loom-eval-x-${id} and ${id}`,
    );
  });
});

describe("evals Galaxy teardown", () => {
  const histories = [
    { id: "h1", name: "loom-eval-delete-RUN1" },
    { id: "h2", name: "loom-eval-delete-RUN2" }, // another process's run
    { id: "h3", name: "my analysis RUN1" }, // has the run id, lacks the prefix
    { id: "h4", name: "loom-eval-job-RUN1", purged: true },
    { id: "h1", name: "loom-eval-delete-RUN1" }, // listed twice (deleted + live)
  ];

  it("selects only prefixed, unpurged histories carrying one of this run's ids", () => {
    expect(selectEvalHistories(histories, ["RUN1"]).map((h) => h.id)).toEqual(["h1"]);
    expect(selectEvalHistories(histories, []).map((h) => h.id)).toEqual([]);
    expect(() => selectEvalHistories(histories, ["RUN1"], "")).toThrow();
    expect(EVAL_HISTORY_PREFIX).toBe("loom-eval-");
  });

  it("lists live and deleted histories, then purges only the selected ones", async () => {
    const calls: { url: string; method: string }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method ?? "GET" });
      if ((init?.method ?? "GET") === "GET") {
        const deleted = url.includes("deleted=true");
        return {
          ok: true,
          status: 200,
          json: async () => (deleted ? [{ id: "h9", name: "loom-eval-sra-RUN1" }] : histories),
        };
      }
      return {
        ok: !url.includes("h9"),
        status: url.includes("h9") ? 403 : 200,
        json: async () => ({}),
      };
    };
    const result = await purgeEvalHistories({
      galaxyUrl: "https://galaxy.example/",
      apiKey: "k",
      runIds: ["RUN1"],
      fetchImpl,
    });
    expect(result.purged.map((h) => h.id)).toEqual(["h1"]);
    expect(result.failed).toEqual([{ id: "h9", name: "loom-eval-sra-RUN1", error: "HTTP 403" }]);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      "https://galaxy.example/api/histories/h1?purge=true",
      "https://galaxy.example/api/histories/h9?purge=true",
    ]);
  });

  it("does nothing without run ids", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("should not be called");
    };
    const result = await purgeEvalHistories({
      galaxyUrl: "https://galaxy.example",
      apiKey: "k",
      runIds: [],
      fetchImpl,
    });
    expect(result).toEqual({ purged: [], failed: [] });
  });
});
