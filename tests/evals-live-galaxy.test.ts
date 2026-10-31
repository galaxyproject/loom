import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { allOperations } from "@galaxyproject/galaxy-ops";
import { evaluate } from "../evals/lib/assertions";
import { filterScenarioDirs } from "../evals/lib/select";
import { makeRunId, runScenario, substituteRunId } from "../evals/lib/runner";
import { historyNamesToResolve, resolveHistoryIds } from "../evals/lib/galaxy-history";
import {
  EVAL_HISTORY_PREFIX,
  purgeEvalHistories,
  selectEvalHistories,
  type FetchLike,
} from "../evals/lib/galaxy-teardown";
import type { AnyEvent, Assertions, Scenario, ScenarioRun } from "../evals/lib/types";

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
  const userResult = end("get_user", '{"data":{"username":"alice","id":"1"}}', {
    details: { server: "galaxy", tool: "get_user" },
  });

  it("mustSucceed passes on a matching non-error result", () => {
    const failures = evaluate(
      run([userResult], {
        toolResults: {
          mustSucceed: [
            {
              name: "get_user",
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
    const errored = end("get_user", "Tool not found", { isError: true });
    for (const [events, expectation] of [
      [[errored], { name: "get_user" }],
      [[userResult], { name: "get_user", detailsContains: { server: "brc" } }],
      [[userResult], { name: "get_user", textContains: "[loom MCP output" }],
      [[], { name: "get_user" }],
    ] as const) {
      const failures = evaluate(
        run([...events], { toolResults: { mustSucceed: [{ ...expectation }] } }),
      );
      expect(failures.map((f) => f.assertion)).toEqual(["toolResults.mustSucceed"]);
    }
  });

  it("detailsContains reads dotted paths into nested details", () => {
    const bare = end("run_tool", '{"success":true}', {
      details: { server: "galaxy", galaxy: { tool: "run_tool", outputId: "01ABC" } },
    });
    const grade = (detailsContains: Record<string, string>) =>
      evaluate(
        run([bare], { toolResults: { mustSucceed: [{ name: "run_tool", detailsContains }] } }),
      ).map((f) => f.assertion);
    expect(grade({ "details.galaxy.tool": "run_tool" })).toEqual([]);
    expect(grade({ "galaxy.tool": "run_tool" })).toEqual([]);
    expect(grade({ "details.galaxy.outputId": "01ABC", server: "galaxy" })).toEqual([]);
    expect(grade({ server: "galaxy" })).toEqual([]);
    for (const miss of [
      { "details.galaxy.tool": "get_user" },
      { "details.galaxy.missing": "x" },
      { "galaxy.tool.deeper": "run_tool" },
      { "details.nothing.here": "x" },
    ]) {
      expect(grade(miss), JSON.stringify(miss)).toEqual(["toolResults.mustSucceed"]);
    }
  });

  it("a top-level key that contains a dot is still read as one key", () => {
    const dotted = end("run_tool", "{}", {
      details: { "galaxy.tool": "flat", galaxy: { tool: "nested" } },
    });
    const failures = evaluate(
      run([dotted], {
        toolResults: {
          mustSucceed: [{ name: "run_tool", detailsContains: { "galaxy.tool": "flat" } }],
        },
      }),
    );
    expect(failures).toEqual([]);
  });

  it("detailsPresent asks only that a dotted key is there", () => {
    const spilled = end("get_iwc_workflows", "[loom Galaxy output]", {
      details: { galaxy: { tool: "get_iwc_workflows", outputId: "01ABC" } },
    });
    const grade = (detailsPresent: string[], detailsContains?: Record<string, string>) =>
      evaluate(
        run([spilled], {
          toolResults: {
            mustSucceed: [{ name: "get_iwc_workflows", detailsPresent, detailsContains }],
          },
        }),
      ).map((f) => f.assertion);
    expect(grade(["details.galaxy.outputId"])).toEqual([]);
    expect(grade(["galaxy.outputId"], { "details.galaxy.tool": "get_iwc_workflows" })).toEqual([]);
    expect(grade(["details.galaxy.missing"])).toEqual(["toolResults.mustSucceed"]);
    expect(grade(["details.galaxy.outputId"], { "details.galaxy.tool": "x" })).toEqual([
      "toolResults.mustSucceed",
    ]);
  });

  it("mustNotSucceed tolerates a blocked call but not a successful one", () => {
    const blocked = end("update_history", "Destructive op denied", { isError: true });
    const ok = end("update_history", '{"data":{"deleted":true}}');
    const assertions: Assertions = {
      toolResults: { mustNotSucceed: ["update_history"] },
    };
    expect(evaluate(run([blocked], assertions))).toEqual([]);
    expect(evaluate(run([blocked, ok], assertions)).map((f) => f.assertion)).toEqual([
      "toolResults.mustNotSucceed",
    ]);
  });

  it("echoedInChat requires the captured value in the chat", () => {
    const assertions: Assertions = {
      toolResults: {
        echoedInChat: [{ name: "get_user", pattern: '"username":\\s*"([^"]+)"' }],
      },
    };
    expect(evaluate(run([userResult, chat("You are alice.")], assertions))).toEqual([]);
    const miss = evaluate(run([userResult, chat("You are bob.")], assertions));
    expect(miss.map((f) => f.detail)).toEqual([
      "chat never repeated the 'get_user' value \"alice\"",
    ]);
    const noResult = evaluate(run([chat("You are alice.")], assertions));
    expect(noResult[0].detail).toMatch(/no successful 'get_user' result/);
  });
});

describe("evals scenario selection", () => {
  const dirs = ["/s/galaxy-tools-a", "/s/galaxy-tools-b", "/s/routing-clear-galaxy", "/s/galaxy"];

  it("an exact name wins over a prefix", () => {
    expect(filterScenarioDirs(dirs, "galaxy")).toEqual(["/s/galaxy"]);
  });

  it("a non-exact filter selects the whole prefix family", () => {
    expect(filterScenarioDirs(dirs, "galaxy-tools")).toEqual([
      "/s/galaxy-tools-a",
      "/s/galaxy-tools-b",
    ]);
  });

  it("no filter selects everything", () => {
    expect(filterScenarioDirs(dirs, undefined)).toEqual(dirs);
  });

  it("a comma list unions its terms, each exact-or-prefix, in directory order", () => {
    expect(filterScenarioDirs(dirs, "galaxy, galaxy-tools-b")).toEqual([
      "/s/galaxy-tools-b",
      "/s/galaxy",
    ]);
    expect(filterScenarioDirs(dirs, "routing,galaxy-tools")).toEqual([
      "/s/galaxy-tools-a",
      "/s/galaxy-tools-b",
      "/s/routing-clear-galaxy",
    ]);
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

describe("evals live Galaxy scenarios", () => {
  const scenariosDir = path.resolve(__dirname, "..", "evals", "scenarios");
  const load = (name: string) =>
    JSON.parse(
      fs.readFileSync(path.join(scenariosDir, name, "scenario.json"), "utf-8"),
    ) as Scenario;
  const LIVE = [
    "galaxy-tools-destructive-gate",
    "galaxy-tools-job-capture",
    "galaxy-tools-large-output",
    "galaxy-tools-sra-gate",
    "galaxy-tools-upload-hidden",
    "iwc-find-from-question-tools",
    "plan-consults-iwc-tools",
    "execution-after-approval-tools",
    "execution-after-slash-approve-tools",
    "execution-after-chat-approve-tools",
  ];
  // Snapshot: allOperations is one mutable array shared by both galaxy-ops entries.
  const ops = new Set([...allOperations].map((o) => o.name));
  const orbitTools = new Set(["galaxy_read_output", "galaxy_upload_local_file"]);

  it("no scenario is left on the galaxy-mcp path", () => {
    const dirs = fs.readdirSync(scenariosDir);
    expect(dirs.filter((d) => d.startsWith("galaxy-mcp"))).toEqual([]);
    for (const d of dirs) {
      const env = load(d).env ?? {};
      expect(
        Object.keys(env).filter((k) => /GALAXY_TOOLS$/.test(k)),
        d,
      ).toEqual([]);
    }
  });

  for (const clone of LIVE) {
    it(`${clone} needs a model and a Galaxy, and names no MCP spelling`, () => {
      const c = load(clone);
      expect(c.tier).toBe(2);
      expect(c.requiresModel).toBe(true);
      expect(c.requiresGalaxy).toBe(true);
      // Only eval knobs (a poller drain, seeded proposal ids); never a Galaxy pathway switch.
      expect(Object.keys(c.env ?? {}).filter((k) => !/^ORBIT_EVAL_/.test(k))).toEqual([]);
      expect(JSON.stringify(c)).not.toContain("mcp__galaxy__");
      expect(JSON.stringify(c)).not.toContain("mcp_read_output");
    });

    it(`${clone} names only tools the bare path registers`, () => {
      const a = load(clone).assertions;
      const names = [
        ...(a.toolCalls?.mustInclude ?? []).map((m) => m.name),
        ...(a.toolCalls?.mustNotInclude ?? []),
        ...(a.toolResults?.mustSucceed ?? []).map((m) => m.name),
        ...(a.toolResults?.mustNotSucceed ?? []),
      ];
      expect(names.length).toBeGreaterThan(0);
      for (const n of names) expect(ops.has(n) || orbitTools.has(n), n).toBe(true);
    });
  }

  it("large-output drives get_iwc_workflows past the spill threshold", () => {
    const c = load("galaxy-tools-large-output");
    expect(c.assertions.toolResults?.mustSucceed).toContainEqual({
      name: "get_iwc_workflows",
      detailsContains: { "details.galaxy.tool": "get_iwc_workflows" },
      detailsPresent: ["details.galaxy.outputId"],
      textContains: "[loom Galaxy output]",
    });
    expect(c.assertions.toolCalls?.mustInclude?.map((m) => m.name)).toEqual(
      expect.arrayContaining(["get_iwc_workflows", "galaxy_read_output"]),
    );
    expect(c.description).not.toMatch(/Provisional/);
  });

  it("job-capture grades a bare run_tool result by its nested details", () => {
    const c = load("galaxy-tools-job-capture");
    const toolResults = c.assertions.toolResults!;
    const result = (details: object) =>
      evaluate(run([end("run_tool", '{"success":true}', { details })], { toolResults }));
    expect(result({ galaxy: { tool: "run_tool", elapsedMs: 12 } })).toEqual([]);
    expect(result({ server: "galaxy", tool: "run_tool" }).map((f) => f.assertion)).toEqual([
      "toolResults.mustSucceed",
    ]);
  });

  it("init-gate-galaxy-no-connection pins empty credentials", () => {
    // Configured credentials count as connected (there is no connect tool),
    // so ambient GALAXY_* would let /execute through.
    expect(load("init-gate-galaxy-no-connection").env).toMatchObject({
      GALAXY_URL: "",
      GALAXY_API_KEY: "",
    });
  });
});

describe("evals target-history assertion", () => {
  const call = (history_id: unknown): AnyEvent => ({
    type: "tool_execution_start",
    toolName: "run_tool",
    args: { tool_id: "addValue", history_id },
  });
  const assertions: Assertions = {
    toolCalls: { inHistory: [{ name: "run_tool", history: "hist1" }] },
  };
  const graded = (events: AnyEvent[], histories?: ScenarioRun["histories"]) => {
    const r = run(events, assertions);
    r.histories = histories;
    return evaluate(r);
  };
  const resolved = { ids: { hist1: "aaaa1111" }, errors: {} };

  it("passes when every run_tool call targets the named history", () => {
    expect(graded([call("aaaa1111"), call("aaaa1111")], resolved)).toEqual([]);
    // Vacuous with no call at all; mustInclude is what requires one.
    expect(graded([], resolved)).toEqual([]);
  });

  it("fails a retry that moved the job to another history, or a name passed as the id", () => {
    const f = graded(
      [call("aaaa1111"), call("bbbb2222"), call("hist1"), call(undefined)],
      resolved,
    );
    expect(f.map((x) => x.assertion)).toEqual(["toolCalls.inHistory"]);
    expect(f[0].detail).toContain("3 'run_tool' call(s)");
    expect(f[0].detail).toContain('"bbbb2222"');
    expect(f[0].detail).toContain('"hist1"');
  });

  it("fails, with the reason, when the history never resolved", () => {
    const f = graded([call("aaaa1111")], {
      ids: {},
      errors: { hist1: "no live history named 'hist1'" },
    });
    expect(f.map((x) => x.assertion)).toEqual(["toolCalls.inHistory"]);
    expect(f[0].detail).toContain("no live history named 'hist1'");
    expect(graded([call("aaaa1111")]).map((x) => x.assertion)).toEqual(["toolCalls.inHistory"]);
  });

  it("reads another argument when the tool names its history differently", () => {
    const r = run(
      [{ type: "tool_execution_start", toolName: "upload", args: { target: "aaaa1111" } }],
      { toolCalls: { inHistory: [{ name: "upload", history: "hist1", arg: "target" }] } },
    );
    r.histories = resolved;
    expect(evaluate(r)).toEqual([]);
  });

  it("is applied to every scenario whose prompt names hist1 and that grades run_tool", () => {
    const dir = path.resolve(__dirname, "..", "evals", "scenarios");
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name, "scenario.json");
      if (!fs.existsSync(file)) continue;
      const s = JSON.parse(fs.readFileSync(file, "utf-8")) as Scenario;
      const namesHist1 = s.inputs.some((i) => /\bhist1\b/.test(i));
      const gradesRunTool = JSON.stringify(s.assertions.toolCalls ?? {}).includes("run_tool");
      if (!namesHist1 || !gradesRunTool) continue;
      expect(s.assertions.toolCalls?.inHistory, name).toEqual([
        { name: "run_tool", history: "hist1" },
      ]);
    }
    const slash = JSON.parse(
      fs.readFileSync(
        path.join(dir, "execution-after-slash-approve-tools", "scenario.json"),
        "utf-8",
      ),
    ) as Scenario;
    expect(historyNamesToResolve(slash.assertions)).toEqual(["hist1"]);
  });
});

describe("evals history resolution", () => {
  const listing = (rows: object[], status = 200): FetchLike => {
    return async () => ({ ok: status < 400, status, json: async () => rows });
  };

  it("resolves an exact, live name and sends the key", async () => {
    const urls: string[] = [];
    const headers: Record<string, string>[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      urls.push(url);
      headers.push(init?.headers ?? {});
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: "x1", name: "hist10" },
          { id: "x2", name: "hist1", deleted: true },
          { id: "x3", name: "hist1" },
        ],
      };
    };
    const r = await resolveHistoryIds({
      galaxyUrl: "https://galaxy.example/",
      apiKey: "k",
      names: ["hist1"],
      fetchImpl,
    });
    expect(r).toEqual({ ids: { hist1: "x3" }, errors: {} });
    expect(urls[0]).toMatch(/^https:\/\/galaxy\.example\/api\/histories\?/);
    expect(urls[0]).toContain("qv=hist1");
    expect(headers[0]["x-api-key"]).toBe("k");
  });

  it("errors on no match, an ambiguous name, an HTTP failure, a throw, or no credentials", async () => {
    const base = { galaxyUrl: "https://g", apiKey: "k", names: ["hist1"] };
    expect(
      (await resolveHistoryIds({ ...base, fetchImpl: listing([{ id: "x1", name: "other" }]) }))
        .errors.hist1,
    ).toMatch(/no live history named 'hist1'/);
    expect(
      (
        await resolveHistoryIds({
          ...base,
          fetchImpl: listing([
            { id: "x1", name: "hist1" },
            { id: "x2", name: "hist1" },
          ]),
        })
      ).errors.hist1,
    ).toMatch(/2 live histories/);
    expect(
      (await resolveHistoryIds({ ...base, fetchImpl: listing([], 403) })).errors.hist1,
    ).toMatch(/HTTP 403/);
    const boom: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect((await resolveHistoryIds({ ...base, fetchImpl: boom })).errors.hist1).toBe(
      "ECONNREFUSED",
    );
    const r = await resolveHistoryIds({ ...base, apiKey: undefined, fetchImpl: boom });
    expect(r).toEqual({ ids: {}, errors: { hist1: "GALAXY_URL/GALAXY_API_KEY unset" } });
  });

  it("makes no request when nothing needs resolving", async () => {
    const boom: FetchLike = async () => {
      throw new Error("should not be called");
    };
    expect(
      await resolveHistoryIds({ galaxyUrl: "https://g", apiKey: "k", names: [], fetchImpl: boom }),
    ).toEqual({ ids: {}, errors: {} });
  });

  it("fails the run without spawning when a history doesn't resolve", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-eval-test-"));
    const saved = { url: process.env.GALAXY_URL, key: process.env.GALAXY_API_KEY };
    try {
      delete process.env.GALAXY_URL;
      delete process.env.GALAXY_API_KEY;
      const scenario: Scenario = {
        name: "t",
        tier: 2,
        inputs: ["Run addValue in hist1"],
        assertions: { toolCalls: { inHistory: [{ name: "run_tool", history: "hist1" }] } },
      };
      fs.writeFileSync(path.join(tmp, "scenario.json"), JSON.stringify(scenario));
      const r = await runScenario(tmp, null);
      expect(r.exitCode).toBe(-3);
      expect(r.events).toEqual([]);
      expect(r.stderr).toContain("history 'hist1' not resolved");
      expect(evaluate(r).map((f) => f.assertion)).toEqual(["toolCalls.inHistory"]);
      // A model cell too: no "check credentials/proxy" noise beside the real reason.
      const modelRun = { ...r, model: { id: "m", provider: "p", model: "m" } };
      expect(evaluate(modelRun).map((f) => f.assertion)).toEqual(["toolCalls.inHistory"]);
    } finally {
      if (saved.url === undefined) delete process.env.GALAXY_URL;
      else process.env.GALAXY_URL = saved.url;
      if (saved.key === undefined) delete process.env.GALAXY_API_KEY;
      else process.env.GALAXY_API_KEY = saved.key;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
