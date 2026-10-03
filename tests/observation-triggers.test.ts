import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  RETRY_LOOP_THRESHOLD,
  OBSERVATIONS_SESSION_CAP,
  newTriggerState,
  decideToolResultObservation,
  factsForToolResult,
  deliverObservation,
} from "../extensions/loom/observation-triggers.js";
import type { DeliverDeps } from "../extensions/loom/observation-triggers.js";
import type { Observation } from "../shared/observation-contract.js";
import type { ObservationFacts } from "../extensions/loom/observations.js";

const KEY = { mcpTool: "galaxy_run_tool", signature: "ToolExecutionError: dataset <id> failed" };

describe("decideToolResultObservation", () => {
  it("reports the first failure as a tool-error", () => {
    const state = newTriggerState();
    expect(decideToolResultObservation(state, KEY)).toEqual({
      kind: "tool-error",
      trigger: "tool_error",
    });
  });

  it("says nothing on the second identical failure", () => {
    const state = newTriggerState();
    decideToolResultObservation(state, KEY);
    expect(decideToolResultObservation(state, KEY)).toBeNull();
  });

  it("upgrades to a retry-loop at the threshold, exactly once", () => {
    const state = newTriggerState();
    expect(decideToolResultObservation(state, KEY)?.kind).toBe("tool-error");
    for (let i = 2; i < RETRY_LOOP_THRESHOLD; i++) {
      expect(decideToolResultObservation(state, KEY), `occurrence ${i}`).toBeNull();
    }
    expect(decideToolResultObservation(state, KEY)).toEqual({
      kind: "retry-loop",
      trigger: "retry_loop",
    });
    expect(decideToolResultObservation(state, KEY)).toBeNull();
    expect(decideToolResultObservation(state, KEY)).toBeNull();
  });

  it("keys on the tool AND the signature, so a different error is its own report", () => {
    const state = newTriggerState();
    decideToolResultObservation(state, KEY);
    expect(decideToolResultObservation(state, { ...KEY, signature: "HTTPError: 400" })?.kind).toBe(
      "tool-error",
    );
    expect(
      decideToolResultObservation(state, { ...KEY, mcpTool: "galaxy_invoke_workflow" })?.kind,
    ).toBe("tool-error");
  });

  it("never reports a signature-only or tool-only match as a loop", () => {
    const state = newTriggerState();
    for (let i = 0; i < 5; i++) {
      decideToolResultObservation(state, { mcpTool: `galaxy_tool_${i}`, signature: KEY.signature });
    }
    for (let i = 0; i < 5; i++) {
      expect(
        decideToolResultObservation(state, { mcpTool: "galaxy_run_tool", signature: `sig ${i}` })
          ?.kind,
      ).toBe("tool-error");
    }
  });

  it("counts a loop per Galaxy tool, not across different tools with one message", () => {
    const state = newTriggerState();
    for (const id of ["Filter1", "Grep1", "Cut1"]) {
      expect(decideToolResultObservation(state, { ...KEY, toolIds: [id] })?.kind, id).toBe(
        "tool-error",
      );
    }
  });

  it("reports nothing for an empty tool or signature", () => {
    const state = newTriggerState();
    expect(decideToolResultObservation(state, { mcpTool: "", signature: "x" })).toBeNull();
    expect(
      decideToolResultObservation(state, { mcpTool: "galaxy_run_tool", signature: "" }),
    ).toBeNull();
  });
});

describe("factsForToolResult", () => {
  it("builds facts from a galaxy tool failure", () => {
    const facts = factsForToolResult(
      "galaxy_run_tool",
      { tool_id: "Filter1", file_type: "tabular" },
      "ToolExecutionError: dataset 2a56fb8e4c1d9f70b3ac55e1d2f80911 failed",
    );
    expect(facts).toEqual({
      kind: "tool-error",
      trigger: "tool_error",
      mcpTool: "galaxy_run_tool",
      toolIds: ["Filter1"],
      datatypes: ["tabular"],
      rawSignature: "ToolExecutionError: dataset 2a56fb8e4c1d9f70b3ac55e1d2f80911 failed",
    });
  });

  it("normalises the mcp proxy call shape to the direct tool name", () => {
    const facts = factsForToolResult(
      "mcp",
      { server: "galaxy", tool: "run_tool", args: { tool_id: "Filter1" } },
      "boom",
    );
    expect(facts?.mcpTool).toBe("galaxy_run_tool");
    expect(facts?.toolIds).toEqual(["Filter1"]);
  });

  it("ignores a non-galaxy tool and an empty result", () => {
    expect(factsForToolResult("bash", { command: "ls" }, "No such file")).toBeNull();
    expect(factsForToolResult("galaxy_run_tool", {}, "")).toBeNull();
    expect(factsForToolResult("galaxy_run_tool", {}, "   ")).toBeNull();
  });
});

const facts: ObservationFacts = {
  kind: "tool-error",
  trigger: "tool_error",
  mcpTool: "galaxy_run_tool",
  toolIds: ["Filter1"],
  datatypes: ["tabular"],
  rawSignature: "ToolExecutionError: Job 12345 refused a header-only table",
};

function deps(over: Partial<DeliverDeps> = {}): DeliverDeps & {
  rows: Array<[string, Record<string, unknown>]>;
} {
  const rows: Array<[string, Record<string, unknown>]> = [];
  const base: DeliverDeps = {
    mode: "auto",
    currentMode: () => over.mode ?? "auto",
    state: newTriggerState(),
    installToken: () => "a".repeat(32),
    describe: async () => "",
    confirm: async () => true,
    submit: async () => ({
      ok: true,
      status: 202,
      id: "x",
      retractToken: "b".repeat(32),
      queueable: false,
    }),
    record: (kind, payload) => rows.push([kind, payload]),
  };
  return { ...base, ...over, rows };
}

const ctx = { hasUI: true } as unknown as ExtensionContext;

describe("deliverObservation", () => {
  // A delivered observation writes the sent log and the retract token under
  // the state dir, so every case runs against a throwaway HOME.
  let tmpHome: string;
  const realHome = process.env.HOME;
  const realUserProfile = process.env.USERPROFILE;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-obs-trig-"));
    fs.mkdirSync(path.join(tmpHome, ".loom"), { recursive: true });
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realUserProfile;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("sends in auto mode and records built + sent", async () => {
    const describe = vi.fn().mockResolvedValue("a description");
    const submit = vi.fn().mockResolvedValue({ ok: true, status: 202, queueable: false });
    const d = deps({ describe, submit });
    expect(await deliverObservation(facts, ctx, d)).toBe("sent");
    const kinds = d.rows.map(([k]) => k);
    expect(kinds).toEqual(["observation.built", "observation.sent"]);
    const built = d.rows[0][1];
    // auto is structured-only: no error text, no description, no model call.
    expect("signature" in built).toBe(false);
    expect(built.shape).toBe("structured");
    expect(describe).not.toHaveBeenCalled();
    const sent = submit.mock.calls[0][0] as Observation;
    expect(sent.signature).toBe("unknown");
    expect(sent.description).toBe("");
    expect(built.leakScan).toBe("clean");
    expect(built.valid).toBe(true);
    expect(built.stage).toBe("tool-parameterization");
    expect(built.toolIds).toBe("Filter1");
    expect(d.state.delivered).toBe(1);
  });

  it("sends a name-bearing error in auto mode as structure only", async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true, status: 202, queueable: false });
    const d = deps({ submit });
    const outcome = await deliverObservation(
      { ...facts, rawSignature: "ValueError: could not convert string to float: 'Alice Smith'" },
      ctx,
      d,
    );
    expect(outcome).toBe("sent");
    expect(JSON.stringify(submit.mock.calls[0][0])).not.toMatch(/Alice|Smith/);
    expect(JSON.stringify(d.rows)).not.toMatch(/Alice|Smith/);
  });

  it("withholds the signature, not the report, when the staged scan trips in ask", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const describe = vi.fn().mockResolvedValue("A connection to the server was refused.");
    const submit = vi.fn().mockResolvedValue({ ok: true, status: 202, queueable: false });
    const d = deps({ mode: "ask", confirm, describe, submit });
    const outcome = await deliverObservation(
      { ...facts, rawSignature: "Connection to galaxyprod:12345 refused" },
      ctx,
      d,
    );
    expect(outcome).toBe("sent");
    expect(describe).toHaveBeenCalledOnce();
    const [shown, , note] = confirm.mock.calls[0];
    expect((shown as Observation).signature).toBe("unknown");
    expect(note).toBe("error text withheld: it contained a host name");
    const sent = submit.mock.calls[0][0] as Observation;
    expect(sent.signature).toBe("unknown");
    expect(sent.description).toBe("A connection to the server was refused.");
    expect(sent.mcpTool).toBe("galaxy_run_tool");
    expect(JSON.stringify(sent)).not.toContain("galaxyprod");
    expect(d.rows[0][1].signatureWithheld).toBe("host-port");
    expect(JSON.stringify(d.rows)).not.toContain("galaxyprod");
  });

  it("normalizes and sends common real Galaxy errors in ask, with nothing withheld", async () => {
    for (const [raw, expected] of [
      ["Dataset 1a2b3c4d5e6f7a8b9c0d not found", "Dataset <id> not found"],
      ["History 0123456789abcdef0123 is deleted", "History <id> is deleted"],
      [
        "Failed to fetch https://usegalaxy.org/api/datasets/1a2b3c4d5e6f7a8b",
        "Failed to fetch <url>",
      ],
      [
        "No such file: /galaxy/server/database/objects/0/0/1/dataset_001.dat",
        "No such file: <path>",
      ],
      ["Job 12345 failed", "Job <n> failed"],
    ]) {
      const confirm = vi.fn().mockResolvedValue(true);
      const submit = vi.fn().mockResolvedValue({ ok: true, status: 202, queueable: false });
      const d = deps({ mode: "ask", confirm, submit });
      expect(await deliverObservation({ ...facts, rawSignature: raw }, ctx, d), raw).toBe("sent");
      expect(confirm.mock.calls[0][2], raw).toBeUndefined();
      expect((submit.mock.calls[0][0] as Observation).signature, raw).toBe(expected);
      expect(d.rows[0][1].signatureWithheld, raw).toBe("");
    }
  });

  it("does not send when collection is turned off while the description is being written", async () => {
    let mode: "ask" | "off" = "ask";
    const submit = vi.fn();
    const d = deps({
      mode: "ask",
      currentMode: () => mode,
      describe: async () => {
        mode = "off";
        return "";
      },
      submit,
    });
    expect(await deliverObservation(facts, ctx, d)).toBe("skipped");
    expect(submit).not.toHaveBeenCalled();
    expect(d.rows.at(-1)).toEqual(["observation.skipped", { reason: "mode-changed" }]);
  });

  it("does not send when collection is turned off while the confirm is open", async () => {
    let mode: "ask" | "off" = "ask";
    const submit = vi.fn();
    const d = deps({
      mode: "ask",
      currentMode: () => mode,
      confirm: async () => {
        mode = "off";
        return true;
      },
      submit,
    });
    expect(await deliverObservation(facts, ctx, d)).toBe("skipped");
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not send an auto delivery once the user has stepped back to ask", async () => {
    const submit = vi.fn();
    const d = deps({ mode: "auto", currentMode: () => "ask", submit });
    expect(await deliverObservation(facts, ctx, d)).toBe("skipped");
    expect(submit).not.toHaveBeenCalled();
  });

  it("still sends what the user confirmed in ask after a switch to auto", async () => {
    const d = deps({ mode: "ask", currentMode: () => "auto" });
    expect(await deliverObservation(facts, ctx, d)).toBe("sent");
  });

  it("keeps a declined /observe note out of every activity row", async () => {
    const note = "Alice Smith had BRCA1 expression 3.14";
    const d = deps({ mode: "ask", confirm: async () => false });
    const outcome = await deliverObservation(
      {
        kind: "user-correction",
        trigger: "explicit",
        toolIds: [],
        datatypes: [],
        rawSignature: note,
      },
      ctx,
      d,
    );
    expect(outcome).toBe("declined");
    expect(d.rows.map(([k]) => k)).toEqual(["observation.built", "observation.declined"]);
    expect(JSON.stringify(d.rows)).not.toMatch(/Alice|Smith|BRCA1|3\.14/);
  });

  it("keeps a sent /observe note out of the activity log too", async () => {
    const note = "The agent picked the wrong reference genome";
    const d = deps({ mode: "ask" });
    expect(
      await deliverObservation(
        {
          kind: "user-correction",
          trigger: "explicit",
          toolIds: [],
          datatypes: [],
          rawSignature: note,
        },
        ctx,
        d,
      ),
    ).toBe("sent");
    expect(JSON.stringify(d.rows)).not.toContain("reference genome");
  });

  it("says unsaved, not queued, when the outbox can't be written", async () => {
    // The second review's setup: both state dirs are regular files.
    fs.rmSync(path.join(tmpHome, ".loom"), { recursive: true, force: true });
    fs.writeFileSync(path.join(tmpHome, ".loom"), "not a directory");
    fs.writeFileSync(path.join(tmpHome, ".orbit"), "not a directory");
    const d = deps({
      submit: async () => ({ ok: false, status: 503, error: "unconfigured", queueable: true }),
    });
    expect(await deliverObservation(facts, ctx, d)).toBe("unsaved");
    expect(d.rows.map(([k]) => k)).toEqual(["observation.built", "observation.unsaved"]);
    expect(d.state.delivered).toBe(0);
  });

  it("hands the description prompt the built observation, never the raw facts", async () => {
    const raw = factsForToolResult(
      "mcp",
      { server: "galaxy", tool: "alice@clinic.org", args: {} },
      "Unknown tool",
    )!;
    expect(raw.mcpTool).toBe("galaxy_alice@clinic.org");
    const describe = vi.fn().mockResolvedValue("");
    const d = deps({ mode: "ask", describe });
    await deliverObservation(raw, ctx, d);
    expect(describe).toHaveBeenCalledOnce();
    expect(JSON.stringify(describe.mock.calls[0][0])).not.toContain("alice");
  });

  it("logs only field:reason names from a Worker refusal, never its free text", async () => {
    const d = deps({
      submit: async () => ({
        ok: false,
        status: 400,
        errors: ["signature:bad-length", "rejected for alice@institute.edu at /Users/alice"],
        queueable: false,
      }),
    });
    expect(await deliverObservation(facts, ctx, d)).toBe("invalid");
    const row = d.rows.find(([k]) => k === "observation.invalid")?.[1];
    expect(row?.errors).toBe("signature:bad-length");
  });

  it("collects nothing when the mode is off", async () => {
    const d = deps({
      mode: "off",
      submit: async () => {
        throw new Error("must not send");
      },
    });
    expect(await deliverObservation(facts, ctx, d)).toBe("skipped");
    expect(d.rows).toEqual([["observation.skipped", { reason: "mode-off" }]]);
  });

  it("never sends in ask mode without a UI to confirm with", async () => {
    const d = deps({
      mode: "ask",
      submit: async () => {
        throw new Error("must not send");
      },
    });
    const headless = { hasUI: false } as unknown as ExtensionContext;
    expect(await deliverObservation(facts, headless, d)).toBe("skipped");
    expect(d.rows).toEqual([["observation.skipped", { reason: "no-ui" }]]);
  });

  it("shows the payload and drops it when the user declines", async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    const d = deps({
      mode: "ask",
      confirm,
      submit: async () => {
        throw new Error("must not send");
      },
    });
    expect(await deliverObservation(facts, ctx, d)).toBe("declined");
    expect(confirm).toHaveBeenCalledOnce();
    expect((confirm.mock.calls[0][0] as Observation).signature).toBe(
      "ToolExecutionError: Job <n> refused a header-only table",
    );
    expect(d.rows.map(([k]) => k)).toEqual(["observation.built", "observation.declined"]);
    expect(d.state.delivered).toBe(0);
  });

  it("records a decline without the signature", async () => {
    const d = deps({ mode: "ask", confirm: async () => false });
    await deliverObservation(facts, ctx, d);
    expect(d.rows.find(([k]) => k === "observation.declined")?.[1]).toEqual({ kind: "tool-error" });
  });

  it("records a queued send by status, never by the error text", async () => {
    const d = deps({
      submit: async () => ({
        ok: false,
        error: "getaddrinfo ENOTFOUND alice-laptop.local",
        queueable: true,
      }),
    });
    await deliverObservation(facts, ctx, d);
    expect(JSON.stringify(d.rows)).not.toContain("alice");
    expect(d.rows.find(([k]) => k === "observation.queued")?.[1].reason).toBe("unreachable");
  });

  it("sends in ask mode once confirmed", async () => {
    const d = deps({ mode: "ask" });
    expect(await deliverObservation(facts, ctx, d)).toBe("sent");
  });

  it("refuses to send a payload the validator rejects", async () => {
    const d = deps({
      describe: async () => "the run for alice@institute.edu failed",
      installToken: () => "NOT-HEX",
      submit: async () => {
        throw new Error("must not send");
      },
    });
    expect(await deliverObservation(facts, ctx, d)).toBe("invalid");
    const invalid = d.rows.find(([k]) => k === "observation.invalid");
    expect(String(invalid?.[1].errors)).toContain("installToken:not-32-hex");
    // Field names only, never the value.
    expect(String(invalid?.[1].errors)).not.toContain("alice");
  });

  it("withholds a signature only the client-side table catches, and sends the rest", async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true, status: 202, queueable: false });
    const d = deps({ mode: "ask", submit });
    // Legal under the wire validator, caught only by the client-side table.
    const outcome = await deliverObservation(
      { ...facts, rawSignature: "connection refused by 10.12.4.7 port 8080" },
      ctx,
      d,
    );
    expect(outcome).toBe("sent");
    expect((submit.mock.calls[0][0] as Observation).signature).toBe("unknown");
    expect(String(d.rows[0][1].signatureWithheld)).toContain("ipv4");
  });

  it("keeps withheld text and dropped tool ids out of the activity log", async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true, status: 202, queueable: false });
    const d = deps({ mode: "ask", submit });
    await deliverObservation(
      { ...facts, toolIds: ["/home/alice/tool.xml"], rawSignature: "refused dataset 42 for alice" },
      ctx,
      d,
    );
    const logged = JSON.stringify(d.rows);
    expect(logged).not.toContain("alice");
    expect(logged).not.toContain("dataset 42");
    expect("signature" in d.rows[0][1]).toBe(false);
    expect(JSON.stringify(submit.mock.calls[0][0])).not.toMatch(/alice|dataset 42/);
  });

  it("does not ask for a description when the structured half can't be sent", async () => {
    const describe = vi.fn().mockResolvedValue("x");
    const d = deps({ mode: "ask", describe, confirm: vi.fn(), installToken: () => "NOT-HEX" });
    expect(await deliverObservation(facts, ctx, d)).toBe("invalid");
    expect(describe).not.toHaveBeenCalled();
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("queues a queueable failure and records it as queued", async () => {
    const d = deps({
      submit: async () => ({ ok: false, status: 503, error: "unconfigured", queueable: true }),
    });
    expect(await deliverObservation(facts, ctx, d)).toBe("queued");
    expect(d.rows.map(([k]) => k)).toEqual(["observation.built", "observation.queued"]);
    expect(d.state.delivered).toBe(1);
  });

  it("drops a permanent rejection instead of queuing it forever", async () => {
    const d = deps({
      submit: async () => ({
        ok: false,
        status: 400,
        errors: ["signature:bad-length"],
        queueable: false,
      }),
    });
    expect(await deliverObservation(facts, ctx, d)).toBe("invalid");
    expect(d.state.delivered).toBe(0);
  });

  it("stops at the session cap", async () => {
    const d = deps();
    d.state.delivered = OBSERVATIONS_SESSION_CAP;
    expect(await deliverObservation(facts, ctx, d)).toBe("skipped");
    expect(d.rows).toEqual([["observation.skipped", { reason: "session-cap" }]]);
  });

  it("survives a describe that throws, with an empty description", async () => {
    const d = deps({
      mode: "ask",
      describe: async () => {
        throw new Error("model exploded");
      },
    });
    expect(await deliverObservation(facts, ctx, d)).toBe("sent");
    expect(d.rows[0][1].descriptionLength).toBe(0);
  });
});

describe("registerObservationTriggers", () => {
  let tmpHome: string;
  const realHome = process.env.HOME;
  const realUserProfile = process.env.USERPROFILE;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-obs-reg-"));
    fs.mkdirSync(path.join(tmpHome, ".loom"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".loom", "config.json"),
      JSON.stringify({ observations: { mode: "ask" } }),
    );
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    delete process.env.ORBIT_OBSERVATIONS;
    delete process.env.LOOM_OBSERVATIONS;
  });
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realUserProfile;
    vi.unstubAllGlobals();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function fakePi() {
    type Handler = (e: unknown, ctx: unknown) => Promise<unknown>;
    const handlers = new Map<string, Handler[]>();
    const api = {
      on: (name: string, fn: Handler) => {
        handlers.set(name, [...(handlers.get(name) ?? []), fn]);
      },
    };
    const emit = async (name: string, event: unknown, ctx: unknown) => {
      for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
    };
    return { api, emit };
  }

  const failure = {
    toolName: "galaxy_run_tool",
    input: { tool_id: "Filter1" },
    content: [{ type: "text", text: "ToolExecutionError: Job 12345 refused a header-only table" }],
    isError: true,
    details: undefined,
  };

  it("only enqueues inside tool_result, and confirms and sends on settle", async () => {
    const { registerObservationTriggers, pendingObservationCount } =
      await import("../extensions/loom/observation-triggers.js");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ ok: true, id: "x", retractToken: "b".repeat(32) }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const confirm = vi.fn().mockResolvedValue(true);
    const ctx = {
      hasUI: true,
      ui: { confirm, input: vi.fn().mockResolvedValue(""), notify: vi.fn() },
    };
    const pi = fakePi();
    registerObservationTriggers(pi.api as any);
    await pi.emit("session_start", {}, ctx);

    await pi.emit("tool_result", failure, ctx);
    expect(confirm).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pendingObservationCount()).toBe(1);

    await pi.emit("agent_settled", {}, ctx);
    expect(confirm).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(pendingObservationCount()).toBe(0);
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(sent.signature).toBe("ToolExecutionError: Job <n> refused a header-only table");
  });

  it("raises one assertion-failed report per session however often the gate blocks", async () => {
    const { registerObservationTriggers, pendingObservationCount } =
      await import("../extensions/loom/observation-triggers.js");
    const { notifyEvidenceDecision } = await import("../extensions/loom/evidence-gate.js");
    const pi = fakePi();
    registerObservationTriggers(pi.api as unknown as ExtensionAPI);
    await pi.emit("session_start", {}, {});
    const block = {
      outcome: "blocked" as const,
      toolName: "edit",
      steps: ["#s1"],
      mode: "deny" as const,
    };
    notifyEvidenceDecision(block);
    notifyEvidenceDecision(block);
    notifyEvidenceDecision({ ...block, outcome: "warned" });
    notifyEvidenceDecision(block);
    expect(pendingObservationCount()).toBe(1);

    await pi.emit("session_start", {}, {});
    notifyEvidenceDecision(block);
    expect(pendingObservationCount()).toBe(1);
  });

  it("enqueues nothing while the env hard-disable is set", async () => {
    process.env.LOOM_OBSERVATIONS = "off";
    const { registerObservationTriggers, pendingObservationCount } =
      await import("../extensions/loom/observation-triggers.js");
    const pi = fakePi();
    registerObservationTriggers(pi.api as unknown as ExtensionAPI);
    await pi.emit("session_start", {}, {});
    await pi.emit("tool_result", failure, {});
    expect(pendingObservationCount()).toBe(0);
  });

  it("ignores a successful result and a non-galaxy failure", async () => {
    const { registerObservationTriggers, pendingObservationCount } =
      await import("../extensions/loom/observation-triggers.js");
    const pi = fakePi();
    registerObservationTriggers(pi.api as unknown as ExtensionAPI);
    await pi.emit("session_start", {}, {});
    await pi.emit("tool_result", { ...failure, isError: false }, {});
    await pi.emit("tool_result", { ...failure, toolName: "bash", input: { command: "ls" } }, {});
    expect(pendingObservationCount()).toBe(0);
  });
});
