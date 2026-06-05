import { describe, it, expect, vi, beforeEach } from "vitest";

const submitFeedback = vi.fn();
const appendToOutbox = vi.fn();
vi.mock("../extensions/loom/feedback.js", () => ({
  submitFeedback: (...a: unknown[]) => submitFeedback(...a),
  buildBrainSysinfo: () => ({ platform: "darwin" }),
  appendToOutbox: (...a: unknown[]) => appendToOutbox(...a),
  readLoomVersion: () => "0.0.0-test",
}));
vi.mock("../extensions/loom/activity.js", () => ({ getRecentActivityEvents: () => [] }));
vi.mock("../extensions/loom/config.js", () => ({ loadConfig: () => ({ testerId: "orbit-007" }) }));

const { registerFeedbackCommand } = await import("../extensions/loom/feedback-command.js");

function makeApi() {
  const commands = new Map<
    string,
    { handler: (a: string | undefined, ctx: any) => Promise<void> }
  >();
  const pi = { registerCommand: vi.fn((n: string, d: any) => commands.set(n, d)) };
  return { pi, commands };
}

function uiMock(overrides: Record<string, any> = {}) {
  return {
    input: vi.fn().mockResolvedValue("My title"),
    editor: vi.fn().mockResolvedValue("My body"),
    confirm: vi.fn().mockResolvedValue(true),
    notify: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("/feedback", () => {
  it("registers a feedback command", () => {
    const { pi, commands } = makeApi();
    registerFeedbackCommand(pi as any);
    expect(commands.has("feedback")).toBe(true);
  });

  it("notifies and skips POST when there is no UI", async () => {
    const { pi, commands } = makeApi();
    registerFeedbackCommand(pi as any);
    const notify = vi.fn();
    await commands.get("feedback")!.handler(undefined, { hasUI: false, ui: { notify } });
    expect(notify).toHaveBeenCalled();
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  it("gathers input and POSTs when UI is present", async () => {
    submitFeedback.mockResolvedValue({ ok: true, id: "z" });
    const { pi, commands } = makeApi();
    registerFeedbackCommand(pi as any);
    const ui = uiMock();
    await commands.get("feedback")!.handler(undefined, { hasUI: true, ui });
    expect(submitFeedback).toHaveBeenCalledOnce();
    const payload = submitFeedback.mock.calls[0][0];
    expect(payload.source).toBe("loom-cli");
    expect(payload.title).toBe("My title");
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Thanks"), "info");
    expect(appendToOutbox).not.toHaveBeenCalled();
  });

  it("stamps the testerId from config onto the payload", async () => {
    submitFeedback.mockResolvedValue({ ok: true, id: "z" });
    const { pi, commands } = makeApi();
    registerFeedbackCommand(pi as any);
    await commands.get("feedback")!.handler(undefined, { hasUI: true, ui: uiMock() });
    expect(submitFeedback.mock.calls[0][0].testerId).toBe("orbit-007");
  });

  it("stamps appVersion even when diagnostics are declined", async () => {
    submitFeedback.mockResolvedValue({ ok: true, id: "z" });
    const { pi, commands } = makeApi();
    registerFeedbackCommand(pi as any);
    const ui = uiMock({ confirm: vi.fn().mockResolvedValue(false) });
    await commands.get("feedback")!.handler(undefined, { hasUI: true, ui });
    const payload = submitFeedback.mock.calls[0][0];
    expect(payload.sysinfo).toEqual({ appVersion: "0.0.0-test" });
    expect(payload.activityTail).toBeUndefined();
  });

  it("saves to the outbox and warns when the POST fails", async () => {
    submitFeedback.mockResolvedValue({ ok: false, error: "offline" });
    appendToOutbox.mockReturnValue("/cfg/feedback-outbox.jsonl");
    const { pi, commands } = makeApi();
    registerFeedbackCommand(pi as any);
    const ui = uiMock();
    await commands.get("feedback")!.handler(undefined, { hasUI: true, ui });
    expect(appendToOutbox).toHaveBeenCalledOnce();
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("saved locally"), "warning");
  });

  it("renders 'unknown error' with an error toast when the outbox also fails", async () => {
    submitFeedback.mockResolvedValue({ ok: false });
    appendToOutbox.mockReturnValue(null);
    const { pi, commands } = makeApi();
    registerFeedbackCommand(pi as any);
    const ui = uiMock();
    await commands.get("feedback")!.handler(undefined, { hasUI: true, ui });
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("unknown error"), "error");
  });

  it("aborts if the user cancels the title", async () => {
    const { pi, commands } = makeApi();
    registerFeedbackCommand(pi as any);
    const ui = uiMock({ input: vi.fn().mockResolvedValue(undefined) });
    await commands.get("feedback")!.handler(undefined, { hasUI: true, ui });
    expect(submitFeedback).not.toHaveBeenCalled();
  });
});
