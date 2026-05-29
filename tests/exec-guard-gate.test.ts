import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { registerExecGuard } from "../extensions/loom/exec-guard/gate";

let sandbox: string, prevHome: string | undefined;
let handler: (event: any, ctx: any) => Promise<any>;
const fakePi = {
  on: (evt: string, h: any) => {
    if (evt === "tool_call") handler = h;
  },
} as any;

function ctx(over: any = {}) {
  return {
    cwd: path.join(sandbox, "project"),
    hasUI: true,
    model: { id: "claude-opus-4-8", provider: "anthropic", cost: { input: 15, output: 75 } },
    ui: { select: vi.fn(async () => "Deny"), confirm: vi.fn(async () => false), notify: vi.fn() },
    ...over,
  };
}

beforeEach(() => {
  prevHome = process.env.HOME;
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loom-gate-")));
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  fs.mkdirSync(path.join(sandbox, "project"), { recursive: true });
  // Pre-acknowledge local-execution consent so these tests exercise the gate,
  // not the one-time disclosure (which has its own test in T8).
  fs.mkdirSync(path.join(sandbox, ".loom"), { recursive: true });
  fs.writeFileSync(
    path.join(sandbox, ".loom", "config.json"),
    JSON.stringify({
      guardian: { consentAcknowledged: { version: "1", at: "2026-01-01T00:00:00Z" } },
    }),
  );
  delete process.env.LOOM_DANGEROUSLY_BYPASS_PERMISSIONS;
  delete process.env.LOOM_SAFE;
  registerExecGuard(fakePi);
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("registerExecGuard", () => {
  it("blocks catastrophic bash without prompting", async () => {
    const c = ctx();
    const r = await handler(
      { type: "tool_call", toolName: "bash", toolCallId: "1", input: { command: "sudo rm -rf /" } },
      c,
    );
    expect(r?.block).toBe(true);
    expect(c.ui.select).not.toHaveBeenCalled();
  });
  it("allows safe bash (returns void/no block)", async () => {
    const r = await handler(
      { type: "tool_call", toolName: "bash", toolCallId: "2", input: { command: "ls -la" } },
      ctx(),
    );
    expect(r?.block).toBeFalsy();
  });
  it("prompts on unknown bash and blocks when user denies", async () => {
    const c = ctx();
    const r = await handler(
      { type: "tool_call", toolName: "bash", toolCallId: "3", input: { command: "python x.py" } },
      c,
    );
    expect(c.ui.select).toHaveBeenCalled();
    expect(r?.block).toBe(true);
  });
  it("allows when user approves once", async () => {
    const c = ctx({ ui: { select: vi.fn(async () => "Allow once"), notify: vi.fn() } });
    const r = await handler(
      { type: "tool_call", toolName: "bash", toolCallId: "4", input: { command: "python x.py" } },
      c,
    );
    expect(r?.block).toBeFalsy();
  });
  it("non-interactive denies unknown bash without prompting", async () => {
    const c = ctx({ hasUI: false });
    const r = await handler(
      { type: "tool_call", toolName: "bash", toolCallId: "5", input: { command: "python x.py" } },
      c,
    );
    expect(r?.block).toBe(true);
  });
  it("bypass env lets catastrophic through", async () => {
    process.env.LOOM_DANGEROUSLY_BYPASS_PERMISSIONS = "1";
    const r = await handler(
      { type: "tool_call", toolName: "bash", toolCallId: "6", input: { command: "rm -rf /" } },
      ctx(),
    );
    expect(r?.block).toBeFalsy();
  });
});
