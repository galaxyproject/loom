import { describe, it, expect, vi } from "vitest";
import {
  PRIVACY_STATEMENT,
  renderObservationForConfirm,
  confirmObservation,
  describeObservation,
} from "../extensions/loom/observation-ui.js";
import type { Observation } from "../shared/observation-contract.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const obs: Observation = {
  schemaVersion: 1,
  id: "550e8400-e29b-41d4-a716-446655440000",
  clientTs: "2026-09-30T12:00:00.000Z",
  client: { app: "loom-cli", version: "0.8.0", platform: "darwin" },
  installToken: "a".repeat(32),
  kind: "tool-error",
  stage: "tool-parameterization",
  trigger: "tool_error",
  tools: [{ id: "Filter1", version: "1.1.1" }],
  mcpTool: "galaxy_run_tool",
  datatypes: ["tabular"],
  signature: "ToolExecutionError: dataset <id> failed",
  galaxy: { server: "usegalaxy.org" },
  description: "A filter step refused a header-only table.",
};

describe("renderObservationForConfirm", () => {
  it("shows every field that will be sent", () => {
    const text = renderObservationForConfirm(obs);
    for (const needle of [
      "kind: tool-error",
      "stage: tool-parameterization",
      "trigger: tool_error",
      "galaxy server: usegalaxy.org",
      "mcp tool: galaxy_run_tool",
      "galaxy tools: Filter1 1.1.1",
      "datatypes: tabular",
      "signature: ToolExecutionError: dataset <id> failed",
      "description: A filter step refused a header-only table.",
      "client: loom-cli 0.8.0 darwin",
    ]) {
      expect(text, needle).toContain(needle);
    }
  });

  it("never prints the install token value", () => {
    const text = renderObservationForConfirm(obs);
    expect(text).not.toContain("a".repeat(32));
    expect(text).toContain("install token:");
  });

  it("renders an empty description and absent optionals readably", () => {
    const text = renderObservationForConfirm({
      ...obs,
      description: "",
      mcpTool: undefined,
      tools: [],
      datatypes: [],
      galaxy: { server: "private" },
    });
    expect(text).toContain("description: (none)");
    expect(text).toContain("galaxy tools: (none)");
    expect(text).toContain("galaxy server: private");
  });
});

describe("confirmObservation", () => {
  it("puts the payload in the confirm and returns the answer", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const ctx = { hasUI: true, ui: { confirm } } as unknown as ExtensionContext;
    expect(await confirmObservation(obs, ctx)).toBe(true);
    const [title, message] = confirm.mock.calls[0];
    expect(String(title)).toMatch(/send this/i);
    expect(String(message)).toContain("signature: ToolExecutionError: dataset <id> failed");
    expect(String(message)).toContain(PRIVACY_STATEMENT);
  });

  it("says plainly what each mode sends", () => {
    expect(PRIVACY_STATEMENT).toContain(
      "In `ask` mode the signature and description are shown to you in full and sent only if you say yes; error text that still looks like it names a host, address, path or id after scrubbing is withheld, and you are offered the rest.",
    );
    expect(PRIVACY_STATEMENT).toContain("In `auto` mode no free text is sent at all");
  });

  it("puts the withheld-text reason above the payload", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const ctx = { hasUI: true, ui: { confirm } } as unknown as ExtensionContext;
    await confirmObservation(
      { ...obs, signature: "unknown" },
      ctx,
      "error text withheld: it contained a host name",
    );
    const message = String(confirm.mock.calls[0][1]);
    expect(message.indexOf("error text withheld: it contained a host name")).toBeLessThan(
      message.indexOf("signature: unknown"),
    );
  });

  it("returns false rather than throwing when the UI is gone", async () => {
    const ctx = {
      hasUI: true,
      ui: {
        confirm: () => {
          throw new Error("stale context");
        },
      },
    } as unknown as ExtensionContext;
    expect(await confirmObservation(obs, ctx)).toBe(false);
  });
});

describe("describeObservation", () => {
  it("asks the user in ask mode, validating and re-prompting once", async () => {
    const input = vi
      .fn()
      .mockResolvedValueOnce("the run for alice@institute.edu failed")
      .mockResolvedValueOnce("A paired-end input was rejected.");
    const notify = vi.fn();
    const ctx = { hasUI: true, ui: { input, notify } } as unknown as ExtensionContext;
    expect(await describeObservation("ask", obs, ctx)).toBe("A paired-end input was rejected.");
    expect(input).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("left blank"), "warning");
  });

  it("accepts an empty answer in ask mode without nagging", async () => {
    const input = vi.fn().mockResolvedValue("");
    const ctx = { hasUI: true, ui: { input, notify: vi.fn() } } as unknown as ExtensionContext;
    expect(await describeObservation("ask", obs, ctx)).toBe("");
    expect(input).toHaveBeenCalledOnce();
  });

  it("gives up after the second bad answer", async () => {
    const input = vi.fn().mockResolvedValue("mail alice@institute.edu");
    const ctx = { hasUI: true, ui: { input, notify: vi.fn() } } as unknown as ExtensionContext;
    expect(await describeObservation("ask", obs, ctx)).toBe("");
    expect(input).toHaveBeenCalledTimes(2);
  });

  it("prompts with the built signature, not the raw facts", async () => {
    const input = vi.fn().mockResolvedValue("");
    const ctx = { hasUI: true, ui: { input, notify: vi.fn() } } as unknown as ExtensionContext;
    await describeObservation("ask", obs, ctx);
    expect(input.mock.calls[0][1]).toBe("signature: ToolExecutionError: dataset <id> failed");
  });

  it("never asks and never calls a model in auto or off mode", async () => {
    const input = vi.fn();
    const complete = vi.fn();
    const ctx = {
      hasUI: true,
      ui: { input },
      model: { id: "m", provider: "p" },
      modelRegistry: { complete },
    } as unknown as ExtensionContext;
    expect(await describeObservation("auto", obs, ctx)).toBe("");
    expect(await describeObservation("off", obs, ctx)).toBe("");
    expect(input).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});
