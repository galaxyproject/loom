import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, MessageEndEvent, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { registerSraImportGate } from "../extensions/loom/sra-import-gate";

vi.mock("../extensions/loom/state", () => ({ getNotebookPath: () => null }));
const TOOL = "toolshed.g2.bx.psu.edu/repos/iuc/sra_tools/fasterq_dump/3.1.1+galaxy1";
function call(id: string, accession: string, overrides = {}) {
  return {
    type: "toolCall" as const,
    id,
    name: "mcp__galaxy__run_tool",
    arguments: {
      history_id: "history-1",
      tool_id: TOOL,
      inputs: {
        "input|input_select": "accession_number",
        "input|accession": accession,
        "adv|seq_defline": "@$ac.$si/$ri",
        "adv|minlen": 0,
        "adv|split": "--split-3",
        "adv|skip_technical": true,
      },
      ...overrides,
    },
  };
}

function harness() {
  const on = vi.fn();
  registerSraImportGate({ on } as unknown as ExtensionAPI);
  const handler = (name: string) => on.mock.calls.find(([event]) => event === name)![1];
  return {
    assistant: (calls: ReturnType<typeof call>[]) =>
      handler("message_end")({
        message: { role: "assistant", content: calls },
      } as unknown as MessageEndEvent),
    check: (c: ReturnType<typeof call>) =>
      handler("tool_call")({
        toolName: c.name,
        toolCallId: c.id,
        input: c.arguments,
      } as ToolCallEvent),
    reset: (event: string) => handler(event)({}),
  };
}
let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});

describe("SRA import gate", () => {
  it("blocks all seven same-settings singleton submissions before any tool can execute", () => {
    // Shape and settings from the reported Orbit turn; destination is a fixture.
    const calls = Array.from({ length: 7 }, (_, i) => call(`c${i}`, `SRR${17449121 - i}`));
    h.assistant(calls);
    const execute = vi.fn();
    for (const c of calls) {
      const decision = h.check(c);
      expect(decision?.block).toBe(true);
      expect(decision.reason).toContain(
        "SRR17449121,SRR17449120,SRR17449119,SRR17449118,SRR17449117,SRR17449116,SRR17449115",
      );
      if (!decision?.block) execute(c.arguments);
    }
    expect(execute).not.toHaveBeenCalled();
    // The model fixes it without a permission prompt or extra manifest upload.
    const batch = call("batch", calls.map((c) => c.arguments.inputs["input|accession"]).join(","));
    h.assistant([batch]);
    expect(h.check(batch)).toBeUndefined();
  });

  it("allows a corrected subset after excluding existing imports, then releases the batch", () => {
    h.assistant([call("a", "SRR1"), call("b", "SRR2"), call("c", "SRR3")]);
    const corrected = call("remaining", "SRR2,SRR3");
    h.assistant([corrected]);
    expect(h.check(corrected)).toBeUndefined();
    const later = call("later", "SRR2");
    h.assistant([later]);
    expect(h.check(later)).toBeUndefined();
  });

  it("does not force unrelated later accessions into an earlier rejected batch", () => {
    h.assistant([call("a", "SRR1"), call("b", "SRR2")]);
    const unrelated = call("unrelated", "ERR10");
    h.assistant([unrelated]);
    expect(h.check(unrelated)).toBeUndefined();
  });

  it("does not let the model serialize a rejected batch across messages", () => {
    h.assistant([call("a", "SRR1"), call("b", "SRR2"), call("c", "SRR3")]);
    expect(h.check(call("a", "SRR1"))?.block).toBe(true);
    // Indistinguishable from "preflight found the others already imported".
    const first = call("first", "SRR1");
    h.assistant([first]);
    expect(h.check(first)).toBeUndefined();
    const second = call("second", "SRR2");
    h.assistant([second]);
    const decision = h.check(second);
    expect(decision?.block).toBe(true);
    expect(decision.reason).toContain('"SRR2,SRR3"');
  });

  it("allows the one accession a history preflight left missing", () => {
    h.assistant([call("a", "SRR1"), call("b", "SRR2")]);
    const missing = call("missing", "SRR2");
    h.assistant([missing]);
    expect(h.check(missing)).toBeUndefined();
  });

  it("allows splitting an already-submitted batch to recover from its failure", () => {
    const batch = call("batch", "SRR1,SRR2");
    h.assistant([batch]);
    expect(h.check(batch)).toBeUndefined();
    const split = [call("a", "SRR1"), call("b", "SRR2")];
    h.assistant(split);
    for (const c of split) expect(h.check(c)).toBeUndefined();
  });

  it("allows a genuine single accession and a targeted retry in a later turn", () => {
    const single = call("only", "SRR1");
    h.assistant([single]);
    expect(h.check(single)).toBeUndefined();
    h.assistant([call("a", "SRR1"), call("b", "SRR2")]);
    h.reset("agent_end");
    h.assistant([single]);
    expect(h.check(single)).toBeUndefined();
  });

  it.each(["input", "session_start"])("does not carry a batch across %s", (event) => {
    h.assistant([call("a", "SRR1"), call("b", "SRR2")]);
    h.reset(event);
    expect(h.check(call("next", "SRR1"))).toBeUndefined();
  });

  it.each(["history", "settings", "version", "storage"])(
    "keeps imports with different %s separate",
    (difference) => {
      const a = call("a", "SRR1");
      const b = call("b", "SRR2");
      if (difference === "history") b.arguments.history_id = "history-2";
      if (difference === "settings") b.arguments.inputs["adv|minlen"] = 100;
      if (difference === "version") b.arguments.tool_id = TOOL.replace("3.1.1", "3.0.0");
      if (difference === "storage")
        Object.assign(b.arguments, { preferred_object_store_id: "archive" });
      h.assistant([a, b]);
      expect(h.check(a)).toBeUndefined();
      expect(h.check(b)).toBeUndefined();
    },
  );

  it("accepts both nested and flat tool input encodings as the same settings", () => {
    const a = call("a", "SRR1");
    const b = call("b", "SRR2", {
      inputs: {
        input: { input_select: "accession_number", accession: "SRR2", __current_case__: 0 },
        adv: { seq_defline: "@$ac.$si/$ri", minlen: 0, split: "--split-3", skip_technical: true },
      },
    });
    h.assistant([a, b]);
    expect(h.check(a)?.block).toBe(true);
    expect(h.check(b)?.block).toBe(true);
  });

  it("recognizes the generic MCP proxy with JSON-string arguments", () => {
    const calls = [call("a", "SRR1"), call("b", "SRR2")].map((c) => ({
      ...c,
      name: "mcp",
      arguments: {
        tool: "mcp__galaxy__run_tool",
        args: JSON.stringify(c.arguments),
      },
    })) as unknown as ReturnType<typeof call>[];
    h.assistant(calls);
    expect(calls.every((c) => h.check(c)?.block)).toBe(true);
  });

  it.each(["fastq_dump", "fasterq_dump"])(
    "handles bare %s tool IDs and namespaced MCP calls",
    (toolId) => {
      const calls = [
        call("a", "ERR1", { tool_id: toolId }),
        call("b", "DRR2", { tool_id: toolId }),
      ].map((c) => ({ ...c, name: "mcp__galaxy__run_tool" }));
      h.assistant(calls);
      expect(calls.every((c) => h.check(c)?.block)).toBe(true);
    },
  );

  it("allows one list-file HDA as the correction for a rejected batch", () => {
    h.assistant([call("a", "SRR1"), call("b", "SRR2")]);
    const corrected = call("file", "unused");
    const inputs = corrected.arguments.inputs as Record<string, unknown>;
    delete inputs["input|accession"];
    inputs["input|input_select"] = "file_list";
    inputs["input|file_list"] = { src: "hda", id: "manifest-1" };
    h.assistant([corrected]);
    expect(h.check(corrected)).toBeUndefined();
  });

  it.each([
    { __class__: "Batch", values: ["SRR1", "SRR2"] },
    { batch: true, values: ["SRR1", "SRR2"] },
    { src: "hdca", id: "mapped-manifests" },
  ])("rejects Galaxy mapping/batch expansion: %j", (value) => {
    const mapped = call("mapped", "unused", {
      inputs: {
        "input|input_select": "file_list",
        "input|file_list": value,
      },
    });
    h.assistant([mapped]);
    expect(h.check(mapped)?.block).toBe(true);
  });

  it("blocks duplicate accessions in a single call and in sibling calls", () => {
    const duplicate = call("duplicate", "SRR1,SRR1");
    h.assistant([duplicate]);
    expect(h.check(duplicate)?.block).toBe(true);
    const siblings = [call("a", "SRR1"), call("b", "SRR1")];
    h.assistant(siblings);
    expect(siblings.every((c) => h.check(c)?.block)).toBe(true);
    const corrected = call("deduplicated", "SRR1");
    h.assistant([corrected]);
    expect(h.check(corrected)).toBeUndefined();
  });

  it("leaves unrelated tools, custom wrappers, local archives and malformed inputs alone", () => {
    const calls = [
      call("a", "SRR1", { tool_id: "fastp" }),
      call("b", "SRR2", { tool_id: "fastp" }),
      call("c", "SRR1", { tool_id: TOOL.replace("/iuc/", "/custom/") }),
      call("d", "SRR2", { tool_id: TOOL.replace("/iuc/", "/custom/") }),
      call("e", "SRR1", {
        inputs: {
          "input|input_select": "sra_file",
          "input|sra_file": { src: "hdca", id: "archives" },
        },
      }),
      call("f", "SRR1", { inputs: "not JSON" }),
    ];
    h.assistant(calls);
    for (const c of calls) expect(h.check(c)).toBeUndefined();
    expect(
      h.check({ ...call("read", "SRR1"), name: "mcp__galaxy__get_tool_input_template" }),
    ).toBeUndefined();
  });
});
