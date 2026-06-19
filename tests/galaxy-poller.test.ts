import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The background poller fires a completion toast when checkInvocations reports
// an invocation that JUST reached a terminal state (autoAction completed/failed).
// Mock the poller's four dependencies so we can drive a single tick (kicked off
// synchronously by startGalaxyPoller) and observe exactly what it notifies.
vi.mock("../extensions/loom/state.js", () => ({
  getNotebookPath: vi.fn(() => "/fake/notebook.md"),
}));
vi.mock("../extensions/loom/notebook-writer.js", () => ({
  readNotebook: vi.fn(async () => "notebook contents"),
  // Always report one in-flight block so tick() proceeds to checkInvocations.
  findInvocationBlocks: vi.fn(() => [{ status: "in_progress", invocationId: "inv1" }]),
}));
vi.mock("../extensions/loom/tools.js", () => ({
  checkInvocations: vi.fn(),
}));
vi.mock("../extensions/loom/galaxy-api.js", () => ({
  getGalaxyConfig: vi.fn(() => ({ url: "https://galaxy.test", apiKey: "k" })),
}));

import { startGalaxyPoller, stopGalaxyPoller } from "../extensions/loom/galaxy-poller";
import { checkInvocations } from "../extensions/loom/tools.js";

const mockCheck = vi.mocked(checkInvocations);

/** A checkInvocations return whose details carry per-invocation results. */
function resultWith(results: unknown[]) {
  return {
    content: [{ type: "text" as const, text: "{}" }],
    details: { checked: results.length, results },
  };
}

describe("galaxy-poller completion notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clear the 15s interval the poller installs so it doesn't leak between tests.
    stopGalaxyPoller();
  });

  it("fires a completed toast once when an invocation reaches a terminal ok state", async () => {
    mockCheck.mockResolvedValue(
      resultWith([
        {
          invocationId: "inv1",
          label: "RNA-seq run",
          jobSummary: { ok: 3 },
          autoAction: "completed",
        },
      ]),
    );
    const notify = vi.fn();

    startGalaxyPoller(notify);

    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith(
      '✅ Galaxy: "RNA-seq run" finished (3 jobs ok) — ask me to verify the outputs.',
      "info",
    );
  });

  it("fires a failed toast at warning level with the error count", async () => {
    mockCheck.mockResolvedValue(
      resultWith([
        {
          invocationId: "inv1",
          label: "Variant call",
          jobSummary: { ok: 1, error: 2 },
          autoAction: "failed",
        },
      ]),
    );
    const notify = vi.fn();

    startGalaxyPoller(notify);

    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith(
      '❌ Galaxy: "Variant call" failed (2 job error(s)) — ask me to investigate.',
      "warning",
    );
  });

  it("falls back to notebookAnchor then invocationId when no label is present", async () => {
    mockCheck.mockResolvedValue(
      resultWith([
        {
          invocationId: "inv-xyz",
          notebookAnchor: "plan-1-step-3",
          jobSummary: { ok: 1 },
          autoAction: "completed",
        },
      ]),
    );
    const notify = vi.fn();

    startGalaxyPoller(notify);

    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][0]).toContain('"plan-1-step-3"');
  });

  it("does not notify for invocations that are still in progress (no autoAction)", async () => {
    mockCheck.mockResolvedValue(
      resultWith([
        {
          invocationId: "inv1",
          label: "Still running",
          jobSummary: { ok: 1 },
          autoAction: undefined,
        },
      ]),
    );
    const notify = vi.fn();

    startGalaxyPoller(notify);

    await vi.waitFor(() => expect(mockCheck).toHaveBeenCalled());
    await Promise.resolve();
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not throw or notify when the result omits a results array", async () => {
    // Mirrors the checkInvocations early-return shape: details has no `results`.
    mockCheck.mockResolvedValue({
      content: [{ type: "text" as const, text: "{}" }],
      details: { checked: 0 },
    });
    const notify = vi.fn();

    startGalaxyPoller(notify);

    await vi.waitFor(() => expect(mockCheck).toHaveBeenCalled());
    await Promise.resolve();
    expect(notify).not.toHaveBeenCalled();
  });

  it("swallows a throwing notifier so the poll loop's catch keeps the timer alive", async () => {
    mockCheck.mockResolvedValue(
      resultWith([
        { invocationId: "inv1", label: "x", jobSummary: { ok: 1 }, autoAction: "completed" },
      ]),
    );
    const notify = vi.fn(() => {
      throw new Error("UI is gone");
    });

    // Must not reject/throw out of the fire-and-forget tick.
    expect(() => startGalaxyPoller(notify)).not.toThrow();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
  });
});
