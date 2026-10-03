import { describe, it, expect, vi, beforeEach } from "vitest";

const setObservationsMode = vi.fn();
const markAutoAcknowledged = vi.fn();
const retractObservation = vi.fn();
const forgetRetractToken = vi.fn();
const appendSentLog = vi.fn();
const deliverObservation = vi.fn();
const removeFromObservationOutbox = vi.fn();
let mode = "ask";
let hardDisabled = false;
let acknowledged = false;
let sentRows: any[] = [];
let token: string | undefined = "b".repeat(32);
let lastFacts: any = null;

vi.mock("../extensions/loom/observations-config.js", () => ({
  resolveObservationsMode: () => mode,
  isObservationsHardDisabled: () => hardDisabled,
  setObservationsMode: (m: string) => setObservationsMode(m),
  peekInstallToken: () => "a".repeat(32),
  getOrCreateInstallToken: () => "a".repeat(32),
  hasAcknowledgedAuto: () => acknowledged,
  markAutoAcknowledged: () => markAutoAcknowledged(),
}));

vi.mock("../extensions/loom/observations.js", async () => {
  const actual = await vi.importActual<any>("../extensions/loom/observations.js");
  return {
    ...actual,
    readSentLog: () => sentRows,
    readRetractToken: () => token,
    forgetRetractToken: (...a: unknown[]) => forgetRetractToken(...a),
    appendSentLog: (...a: unknown[]) => appendSentLog(...a),
    retractObservation: (...a: unknown[]) => retractObservation(...a),
    removeFromObservationOutbox: (...a: unknown[]) => removeFromObservationOutbox(...a),
    observationsFilePath: (n: string) => `/fake/.loom/${n}`,
  };
});

vi.mock("../extensions/loom/observation-triggers.js", () => ({
  deliverObservation: (...a: unknown[]) => deliverObservation(...a),
  liveDeliverDeps: () => ({ mode }),
  recordObservationActivity: vi.fn(),
  lastObservationFacts: () => lastFacts,
  localWriteWarning: (o: string) =>
    o === "unsaved"
      ? "couldn't be saved locally"
      : o === "sent-unretractable"
        ? "token lost"
        : undefined,
}));

const {
  registerObservationsCommand,
  formatObservationsStatus,
  sentLogSummary,
  sampleObservationFacts,
} = await import("../extensions/loom/observations-command.js");

function makeApi() {
  const commands = new Map<
    string,
    { handler: (a: string | undefined, ctx: any) => Promise<void> }
  >();
  const pi = { registerCommand: vi.fn((n: string, d: any) => commands.set(n, d)) };
  return { pi, commands };
}

function uiMock(over: Record<string, any> = {}) {
  return {
    notify: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    select: vi.fn().mockResolvedValue("something the agent got wrong"),
    input: vi.fn().mockResolvedValue(""),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mode = "ask";
  hardDisabled = false;
  acknowledged = false;
  sentRows = [];
  token = "b".repeat(32);
  lastFacts = null;
});

describe("formatObservationsStatus", () => {
  it("names the mode, the log and the counts", () => {
    const text = formatObservationsStatus({
      mode: "ask",
      hardDisabled: false,
      hasToken: true,
      sentLogPath: "/fake/.loom/observations-sent.jsonl",
      counts: { sent: 3, queued: 1, retracted: 2, cancelled: 4 },
    });
    expect(text).toContain("mode: ask");
    expect(text).toContain("/fake/.loom/observations-sent.jsonl");
    expect(text).toContain("3 sent");
    expect(text).toContain("1 queued");
    expect(text).toContain("2 retracted");
    expect(text).toContain("4 cancelled");
  });

  it("says so when the env has hard-disabled it", () => {
    const text = formatObservationsStatus({
      mode: "off",
      hardDisabled: true,
      hasToken: false,
      sentLogPath: "/x",
      counts: { sent: 0, queued: 0, retracted: 0, cancelled: 0 },
    });
    expect(text).toMatch(/ORBIT_OBSERVATIONS=off/);
  });

  it("never prints the install token value", () => {
    const text = formatObservationsStatus({
      mode: "auto",
      hardDisabled: false,
      hasToken: true,
      sentLogPath: "/x",
      counts: { sent: 0, queued: 0, retracted: 0, cancelled: 0 },
    });
    expect(text).not.toContain("a".repeat(32));
  });
});

describe("sentLogSummary", () => {
  it("says so when nothing has been sent", () => {
    expect(sentLogSummary([])).toMatch(/nothing/i);
  });

  it("renders one line per row, newest last, with the id for retraction", () => {
    const text = sentLogSummary([
      {
        at: "2026-09-30T10:00:00.000Z",
        id: "550e8400-e29b-41d4-a716-446655440000",
        status: "sent",
        kind: "tool-error",
        stage: "tool-parameterization",
        trigger: "tool_error",
        signature: "ToolExecutionError: dataset <id> failed",
        tools: ["Filter1"],
        datatypes: ["tabular"],
        server: "usegalaxy.org",
        description: "",
      },
    ]);
    expect(text).toContain("550e8400-e29b-41d4-a716-446655440000");
    expect(text).toContain("tool-error");
    expect(text).toContain("ToolExecutionError: dataset <id> failed");
    expect(text).toContain("sent");
  });

  it("marks the latest status for an id that was later retracted", () => {
    const row = {
      at: "2026-09-30T10:00:00.000Z",
      id: "id-1",
      kind: "tool-error",
      stage: "unknown",
      trigger: "tool_error",
      signature: "x",
      tools: [],
      datatypes: [],
      server: "private",
      description: "",
    };
    const text = sentLogSummary([
      { ...row, status: "sent" } as any,
      { ...row, at: "2026-09-30T11:00:00.000Z", status: "retracted" } as any,
    ]);
    expect(text.match(/id-1/g)).toHaveLength(1);
    expect(text).toContain("retracted");
  });
});

describe("/observations", () => {
  it("registers both commands", () => {
    const { pi, commands } = makeApi();
    registerObservationsCommand(pi as any);
    expect(commands.has("observations")).toBe(true);
    expect(commands.has("observe")).toBe(true);
  });

  it("bare /observations shows status", async () => {
    const { pi, commands } = makeApi();
    registerObservationsCommand(pi as any);
    const ui = uiMock();
    await commands.get("observations")!.handler(undefined, { hasUI: true, ui });
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("mode: ask"), "info");
  });

  it("rejects an unknown subcommand with the usage", async () => {
    const { pi, commands } = makeApi();
    registerObservationsCommand(pi as any);
    const ui = uiMock();
    await commands.get("observations")!.handler("explode", { hasUI: true, ui });
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage"), "warning");
  });

  it("mode off and mode ask are set without a consent prompt", async () => {
    const { pi, commands } = makeApi();
    registerObservationsCommand(pi as any);
    const ui = uiMock();
    await commands.get("observations")!.handler("mode off", { hasUI: true, ui });
    expect(setObservationsMode).toHaveBeenCalledWith("off");
    expect(ui.confirm).not.toHaveBeenCalled();
  });

  it("mode auto shows a real sample payload and the privacy statement first", async () => {
    const { pi, commands } = makeApi();
    registerObservationsCommand(pi as any);
    const ui = uiMock();
    await commands.get("observations")!.handler("mode auto", { hasUI: true, ui });
    expect(ui.confirm).toHaveBeenCalledOnce();
    const message = String(ui.confirm.mock.calls[0][1]);
    expect(message).toContain("signature: unknown");
    expect(message).toContain("description: (none)");
    expect(message).toContain("In `auto` mode no free text is sent at all");
    expect(message).toContain("Rows expire after 180 days");
    expect(setObservationsMode).toHaveBeenCalledWith("auto");
    expect(markAutoAcknowledged).toHaveBeenCalledOnce();
  });

  it("mode auto is not set when the sample is declined", async () => {
    const { pi, commands } = makeApi();
    registerObservationsCommand(pi as any);
    const ui = uiMock({ confirm: vi.fn().mockResolvedValue(false) });
    await commands.get("observations")!.handler("mode auto", { hasUI: true, ui });
    expect(setObservationsMode).not.toHaveBeenCalled();
  });

  it("mode auto skips the sample once acknowledged", async () => {
    acknowledged = true;
    const { pi, commands } = makeApi();
    registerObservationsCommand(pi as any);
    const ui = uiMock();
    await commands.get("observations")!.handler("mode auto", { hasUI: true, ui });
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(setObservationsMode).toHaveBeenCalledWith("auto");
  });

  it("refuses mode auto with no UI to show the sample in", async () => {
    const { pi, commands } = makeApi();
    registerObservationsCommand(pi as any);
    const notify = vi.fn();
    await commands.get("observations")!.handler("mode auto", { hasUI: false, ui: { notify } });
    expect(setObservationsMode).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "warning");
  });

  it("surfaces the env hard-disable instead of writing the config", async () => {
    hardDisabled = true;
    setObservationsMode.mockImplementation(() => {
      throw new Error("Observations are hard-disabled for this install");
    });
    const { pi, commands } = makeApi();
    registerObservationsCommand(pi as any);
    const ui = uiMock();
    await commands.get("observations")!.handler("mode ask", { hasUI: true, ui });
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("hard-disabled"), "error");
  });

  it("retract deletes the row, forgets the token and logs the retraction", async () => {
    retractObservation.mockResolvedValue({ ok: true, alreadyGone: false });
    sentRows = [
      {
        at: "2026-09-30T10:00:00.000Z",
        id: "id-1",
        status: "sent",
        kind: "tool-error",
        stage: "unknown",
        trigger: "tool_error",
        signature: "x",
        tools: [],
        datatypes: [],
        server: "private",
        description: "",
      },
    ];
    const { pi, commands } = makeApi();
    registerObservationsCommand(pi as any);
    const ui = uiMock();
    await commands.get("observations")!.handler("retract id-1", { hasUI: true, ui });
    expect(retractObservation).toHaveBeenCalledWith("id-1", "b".repeat(32));
    expect(forgetRetractToken).toHaveBeenCalledWith("id-1");
    expect(appendSentLog).toHaveBeenCalledWith(
      expect.objectContaining({ id: "id-1", status: "retracted" }),
    );
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Retracted"), "info");
    // A sent row left behind in the outbox must not go again after a retract.
    expect(removeFromObservationOutbox).toHaveBeenCalledWith("id-1");
  });

  it("retract of a queued row with no token cancels it from the outbox", async () => {
    token = undefined;
    removeFromObservationOutbox.mockReturnValue("removed");
    const { pi, commands } = makeApi();
    registerObservationsCommand(pi as any);
    const ui = uiMock();
    await commands.get("observations")!.handler("retract id-q", { hasUI: true, ui });
    expect(retractObservation).not.toHaveBeenCalled();
    expect(removeFromObservationOutbox).toHaveBeenCalledWith("id-q");
    expect(appendSentLog).toHaveBeenCalledWith(
      expect.objectContaining({ id: "id-q", status: "cancelled" }),
    );
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Cancelled id-q"), "info");
  });

  it("retract of a queued row says so when a drain is mid-send", async () => {
    token = undefined;
    removeFromObservationOutbox.mockReturnValue("busy");
    const { pi, commands } = makeApi();
    registerObservationsCommand(pi as any);
    const ui = uiMock();
    await commands.get("observations")!.handler("retract id-q", { hasUI: true, ui });
    expect(appendSentLog).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Try again"), "warning");
  });

  it("retract reports an unknown id without calling the service", async () => {
    token = undefined;
    removeFromObservationOutbox.mockReturnValue("absent");
    const { pi, commands } = makeApi();
    registerObservationsCommand(pi as any);
    const ui = uiMock();
    await commands.get("observations")!.handler("retract nope", { hasUI: true, ui });
    expect(retractObservation).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("no retract token"), "warning");
  });

  it("retract treats an already-gone row as done", async () => {
    retractObservation.mockResolvedValue({ ok: true, alreadyGone: true });
    const { pi, commands } = makeApi();
    registerObservationsCommand(pi as any);
    const ui = uiMock();
    await commands.get("observations")!.handler("retract id-1", { hasUI: true, ui });
    expect(forgetRetractToken).toHaveBeenCalledWith("id-1");
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("already"), "info");
  });

  it("retract keeps the token when the service could not be reached", async () => {
    retractObservation.mockResolvedValue({ ok: false, alreadyGone: false, error: "offline" });
    const { pi, commands } = makeApi();
    registerObservationsCommand(pi as any);
    const ui = uiMock();
    await commands.get("observations")!.handler("retract id-1", { hasUI: true, ui });
    expect(forgetRetractToken).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("offline"), "error");
  });
});

describe("/observe", () => {
  it("tells the user when a retryable send couldn't be saved locally", async () => {
    deliverObservation.mockResolvedValue("unsaved");
    const { pi, commands } = makeApi();
    registerObservationsCommand(pi as any);
    const ui = uiMock();
    await commands.get("observe")!.handler("the filter dropped every row", { hasUI: true, ui });
    expect(ui.notify).toHaveBeenCalledWith("couldn't be saved locally", "warning");
    expect(ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Saved locally"), "warning");
  });

  it("delivers a user-correction observation with the chosen kind", async () => {
    deliverObservation.mockResolvedValue("sent");
    const { pi, commands } = makeApi();
    registerObservationsCommand(pi as any);
    const ui = uiMock();
    await commands.get("observe")!.handler("the filter dropped every row", { hasUI: true, ui });
    expect(deliverObservation).toHaveBeenCalledOnce();
    const facts = deliverObservation.mock.calls[0][0];
    expect(facts.kind).toBe("user-correction");
    expect(facts.trigger).toBe("explicit");
    expect(facts.rawSignature).toBe("the filter dropped every row");
  });

  it("uses the silent-wrong-result kind when that is what the user picks", async () => {
    deliverObservation.mockResolvedValue("sent");
    const { pi, commands } = makeApi();
    registerObservationsCommand(pi as any);
    const ui = uiMock({
      select: vi.fn().mockResolvedValue("a result that looked fine but was wrong"),
    });
    await commands.get("observe")!.handler("counts were all zero", { hasUI: true, ui });
    expect(deliverObservation.mock.calls[0][0].kind).toBe("silent-wrong-result");
  });

  it("needs interactive mode and a non-off mode", async () => {
    const { pi, commands } = makeApi();
    registerObservationsCommand(pi as any);
    const notify = vi.fn();
    await commands.get("observe")!.handler("x", { hasUI: false, ui: { notify } });
    expect(deliverObservation).not.toHaveBeenCalled();

    mode = "off";
    const ui = uiMock();
    await commands.get("observe")!.handler("x", { hasUI: true, ui });
    expect(deliverObservation).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("off"), "info");
  });

  it("asks for the note when none was typed, and does nothing if it is empty", async () => {
    const { pi, commands } = makeApi();
    registerObservationsCommand(pi as any);
    const ui = uiMock({ input: vi.fn().mockResolvedValue("") });
    await commands.get("observe")!.handler(undefined, { hasUI: true, ui });
    expect(deliverObservation).not.toHaveBeenCalled();
  });
});

describe("sampleObservationFacts", () => {
  const seen = {
    kind: "tool-error",
    trigger: "tool_error",
    mcpTool: "galaxy_run_tool",
    toolIds: ["Filter1"],
    datatypes: ["tabular"],
    rawSignature: "ToolExecutionError: header-only table",
  };

  it("shows what a trigger actually saw when it would be sent", () => {
    lastFacts = seen;
    expect(sampleObservationFacts()).toBe(seen);
  });

  it("shows the structured shape, so error text a trigger saw never reaches the sample", async () => {
    lastFacts = { ...seen, rawSignature: "refused dataset 42 for Alice Smith" };
    const { pi, commands } = makeApi();
    registerObservationsCommand(pi as any);
    const ui = uiMock();
    await commands.get("observations")!.handler("mode auto", { hasUI: true, ui });
    const message = String(ui.confirm.mock.calls[0][1]);
    expect(message).not.toMatch(/dataset 42|Alice|Smith/);
    expect(message).toContain("signature: unknown");
    expect(message).toContain("galaxy tools: Filter1");
  });

  it("falls back to a representative sample with nothing seen yet", () => {
    expect(sampleObservationFacts().mcpTool).toBe("galaxy_run_tool");
  });
});
