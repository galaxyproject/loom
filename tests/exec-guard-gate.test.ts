import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { registerExecGuard } from "../extensions/loom/exec-guard/gate";
import { APPROVAL_DETAIL_LIMIT, splitApprovalPrompt } from "../shared/approval-prompt.js";

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
  it("discloses once on first gated action and records consent", async () => {
    // Clear the pre-seeded consent for this test only.
    fs.writeFileSync(path.join(sandbox, ".loom", "config.json"), JSON.stringify({}));
    const confirm = vi.fn(async () => true);
    const c = ctx({ ui: { select: vi.fn(async () => "Deny"), confirm, notify: vi.fn() } });
    await handler(
      { type: "tool_call", toolName: "bash", toolCallId: "7", input: { command: "python a.py" } },
      c,
    );
    await handler(
      { type: "tool_call", toolName: "bash", toolCallId: "8", input: { command: "python b.py" } },
      c,
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    const cfg = JSON.parse(fs.readFileSync(path.join(sandbox, ".loom", "config.json"), "utf-8"));
    expect(cfg.guardian.consentAcknowledged).toBeTruthy();
  });
  it("declining consent blocks the action without prompting for the command", async () => {
    fs.writeFileSync(path.join(sandbox, ".loom", "config.json"), JSON.stringify({}));
    const select = vi.fn(async () => "Allow once");
    const c = ctx({ ui: { select, confirm: vi.fn(async () => false), notify: vi.fn() } });
    const r = await handler(
      { type: "tool_call", toolName: "bash", toolCallId: "9", input: { command: "python a.py" } },
      c,
    );
    expect(r?.block).toBe(true);
    expect(select).not.toHaveBeenCalled();
  });
});

describe("registerExecGuard -- approval prompt legibility (#399)", () => {
  const longCommand = `python train.py ${"--flag value ".repeat(60)}`.trim();

  it("shows the whole command, not a silent 200-char slice", async () => {
    const select = vi.fn(async () => "Deny");
    const c = ctx({ ui: { select, confirm: vi.fn(async () => false), notify: vi.fn() } });
    await handler(
      { type: "tool_call", toolName: "bash", toolCallId: "p1", input: { command: longCommand } },
      c,
    );
    const title = select.mock.calls[0][0] as string;
    expect(longCommand.length).toBeGreaterThan(200);
    expect(title).toContain(longCommand);
  });

  it("keeps the command out of the heading so shells can render it as a body", async () => {
    const select = vi.fn(async () => "Deny");
    const c = ctx({ ui: { select, confirm: vi.fn(async () => false), notify: vi.fn() } });
    await handler(
      {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "p2",
        input: { command: "python x.py\n  --verbose" },
      },
      c,
    );
    const { heading, detail } = splitApprovalPrompt(select.mock.calls[0][0] as string);
    expect(heading).toBe("Allow claude-opus-4-8 to run this command?");
    // Newlines inside the command survive the trip.
    expect(detail).toBe("python x.py\n  --verbose");
  });

  it("says so explicitly when a command is too long to show in full", async () => {
    const select = vi.fn(async () => "Deny");
    const c = ctx({ ui: { select, confirm: vi.fn(async () => false), notify: vi.fn() } });
    const huge = `python x.py ${"z".repeat(APPROVAL_DETAIL_LIMIT * 2)}`;
    await handler(
      { type: "tool_call", toolName: "bash", toolCallId: "p3", input: { command: huge } },
      c,
    );
    const title = select.mock.calls[0][0] as string;
    expect(title).toContain("truncated");
    expect(title).toContain(String(huge.length));
  });

  it("prompts with the command even when pi emits a capitalized tool name", async () => {
    const select = vi.fn(async () => "Deny");
    const c = ctx({ ui: { select, confirm: vi.fn(async () => false), notify: vi.fn() } });
    await handler(
      { type: "tool_call", toolName: "Bash", toolCallId: "p5", input: { command: "python x.py" } },
      c,
    );
    expect(select).toHaveBeenCalled();
    const { heading, detail } = splitApprovalPrompt(select.mock.calls[0][0] as string);
    expect(heading).toBe("Allow claude-opus-4-8 to run this command?");
    expect(detail).toBe("python x.py");
  });

  it("gives path-gated tools the same heading/detail shape", async () => {
    const select = vi.fn(async () => "Deny");
    const c = ctx({ ui: { select, confirm: vi.fn(async () => false), notify: vi.fn() } });
    const hook = path.join(sandbox, "project", ".git", "hooks", "pre-commit");
    await handler(
      { type: "tool_call", toolName: "write", toolCallId: "p4", input: { path: hook } },
      c,
    );
    expect(select).toHaveBeenCalled();
    const { heading, detail } = splitApprovalPrompt(select.mock.calls[0][0] as string);
    expect(heading).toBe("Allow claude-opus-4-8 to write this path?");
    expect(detail).toBe(hook);
  });
});

describe("registerExecGuard -- destructive Galaxy ops (#338)", () => {
  const delEvent = (id: string) => ({
    type: "tool_call",
    toolName: "galaxy_update_history",
    toolCallId: id,
    input: { deleted: true, history_id: "h" },
  });
  const purgeEvent = (id: string) => ({
    type: "tool_call",
    toolName: "galaxy_update_history",
    toolCallId: id,
    input: { purged: true, history_id: "h" },
  });

  it("uses a yes/no confirm (not the 4-choice select) and blocks on cancel", async () => {
    const c = ctx(); // confirm -> false
    const r = await handler(delEvent("d1"), c);
    expect(c.ui.confirm).toHaveBeenCalled();
    expect(c.ui.select).not.toHaveBeenCalled();
    expect(r?.block).toBe(true);
  });

  it("proceeds when the user confirms", async () => {
    const c = ctx({ ui: { select: vi.fn(), confirm: vi.fn(async () => true), notify: vi.fn() } });
    const r = await handler(delEvent("d2"), c);
    expect(r?.block).toBeFalsy();
  });

  it("re-prompts every time -- a destructive op is never cached for the session", async () => {
    const confirm = vi.fn();
    confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const c = ctx({ ui: { select: vi.fn(), confirm, notify: vi.fn() } });
    const r1 = await handler(delEvent("dup"), c);
    const r2 = await handler(delEvent("dup"), c); // identical input
    expect(r1?.block).toBeFalsy();
    expect(r2?.block).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("purge confirmation is honest about irreversibility", async () => {
    const confirm = vi.fn(async () => false);
    const c = ctx({ ui: { select: vi.fn(), confirm, notify: vi.fn() } });
    await handler(purgeEvent("d4"), c);
    const msg = confirm.mock.calls[0][1] as string;
    expect(msg).toMatch(/purge/i);
    expect(msg).toMatch(/cannot be undone|permanent/i);
  });

  it("delete confirmation flags the whole-history scope", async () => {
    const confirm = vi.fn(async () => false);
    const c = ctx({ ui: { select: vi.fn(), confirm, notify: vi.fn() } });
    await handler(delEvent("d5"), c);
    expect(confirm.mock.calls[0][1] as string).toMatch(/entire history/i);
  });

  it("non-interactive denies a destructive op without prompting", async () => {
    const confirm = vi.fn(async () => true);
    const c = ctx({ hasUI: false, ui: { select: vi.fn(), confirm, notify: vi.fn() } });
    const r = await handler(delEvent("d6"), c);
    expect(r?.block).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("shows its own destructive confirm even before local-exec consent is acknowledged", async () => {
    fs.writeFileSync(path.join(sandbox, ".loom", "config.json"), JSON.stringify({}));
    const confirm = vi.fn(async () => false);
    const c = ctx({ ui: { select: vi.fn(), confirm, notify: vi.fn() } });
    const r = await handler(delEvent("d7"), c);
    expect(r?.block).toBe(true);
    // exactly one confirm -- the destructive one, not a separate consent disclosure first
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][1] as string).toMatch(/entire history/i);
  });
});
