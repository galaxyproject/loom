import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  applySkillTriggers,
  IWC_CANDIDATES_HINT,
  registerSkillTriggers,
  type SkillTrigger,
} from "../extensions/loom/skill-triggers";
import { INVOCATION_FAILED_HINT } from "../extensions/loom/invocation-failure-hint";
import { resetState, setNotebookPath } from "../extensions/loom/state";
import { resetActivity } from "../extensions/loom/activity";

const TOOLS = ["mcp__brc_analytics__get_organism", "mcp__galaxy__run_tool"];
// "brс" -- the "с" is Cyrillic.
const CONFUSED = "mcp__brс_analytics__get_organism";
const FAILED_CHECK = JSON.stringify({
  success: true,
  results: [{ invocationId: "abc", autoAction: "failed" }],
});

const text = (t: string) => ({ type: "text", text: t });

describe("applySkillTriggers -- the ported rows", () => {
  it("points a confusable tool name at the real one on a not-found error", () => {
    const out = applySkillTriggers(
      { toolName: CONFUSED, isError: true, content: [text(`Tool ${CONFUSED} not found`)] },
      () => TOOLS,
    );
    expect(out?.fired.map((f) => f.id)).toEqual(["tool-name-confusables"]);
    expect(out?.content[0].text).toContain("Did you mean `mcp__brc_analytics__get_organism`?");
  });

  it("stays quiet on a not-found error with no lookalike", () => {
    const out = applySkillTriggers(
      { toolName: "made_up", isError: true, content: [text("Tool made_up not found")] },
      () => TOOLS,
    );
    expect(out).toBeNull();
  });

  it("appends the triage hint to a failed invocation check", () => {
    const out = applySkillTriggers(
      { toolName: "galaxy_invocation_check_one", isError: false, content: [text(FAILED_CHECK)] },
      () => TOOLS,
    );
    expect(out?.fired.map((f) => f.id)).toEqual(["invocation-failed"]);
    expect(out?.content[0].text).toContain(INVOCATION_FAILED_HINT);
  });

  it("reminds the model to vet IWC candidates on recommend and search results", () => {
    for (const toolName of [
      "mcp__galaxy__recommend_iwc_workflows",
      "mcp__galaxy__search_iwc_workflows",
    ]) {
      const out = applySkillTriggers(
        { toolName, isError: false, content: [text('{"data":[],"count":0}')] },
        () => TOOLS,
      );
      expect(out?.fired.map((f) => f.id)).toEqual(["iwc-candidates"]);
      expect(out?.content[0].text).toContain(IWC_CANDIDATES_HINT);
    }
  });

  it("hints on an IWC result the output guard truncated into non-JSON", () => {
    const truncated = '{"data": [{"name": "RNA-Seq\n\n[Output truncated: 2000 lines shown]';
    const out = applySkillTriggers(
      {
        toolName: "mcp__galaxy__recommend_iwc_workflows",
        isError: false,
        content: [text(truncated)],
      },
      () => TOOLS,
    );
    expect(out?.content[0].text).toContain(IWC_CANDIDATES_HINT);
  });

  it("leaves other IWC tools and failed IWC calls alone", () => {
    for (const [toolName, isError] of [
      ["mcp__galaxy__get_iwc_workflow_details", false],
      ["mcp__galaxy__import_workflow_from_iwc", false],
      ["mcp__galaxy__recommend_iwc_workflows", true],
    ] as const) {
      expect(
        applySkillTriggers({ toolName, isError, content: [text("{}")] }, () => TOOLS),
      ).toBeNull();
    }
  });

  it("only watches the tools a row names", () => {
    const out = applySkillTriggers(
      { toolName: "mcp__galaxy__run_tool", isError: false, content: [text(FAILED_CHECK)] },
      () => TOOLS,
    );
    expect(out).toBeNull();
  });

  it("keeps success rows off error results and error rows off successes", () => {
    expect(
      applySkillTriggers(
        { toolName: "galaxy_invocation_check_all", isError: true, content: [text(FAILED_CHECK)] },
        () => TOOLS,
      ),
    ).toBeNull();
    expect(
      applySkillTriggers(
        { toolName: CONFUSED, isError: false, content: [text(`Tool ${CONFUSED} not found`)] },
        () => TOOLS,
      ),
    ).toBeNull();
  });
});

describe("applySkillTriggers -- table mechanics", () => {
  const always = (id: string, hint: string): SkillTrigger => ({
    id,
    on: "success",
    hint: () => hint,
  });

  it("lets several rows fire on one result, in table order", () => {
    const out = applySkillTriggers(
      { toolName: "t", isError: false, content: [text("result")] },
      () => [],
      [always("a", "HINT A"), always("b", "HINT B")],
    );
    expect(out?.fired.map((f) => f.id)).toEqual(["a", "b"]);
    expect(out?.content[0].text).toBe("result\n\nHINT A\n\nHINT B");
  });

  it("does not stack a hint the result already carries", () => {
    const out = applySkillTriggers(
      { toolName: "t", isError: false, content: [text("result\n\nHINT A")] },
      () => [],
      [always("a", "HINT A")],
    );
    expect(out).toBeNull();
  });

  it("appends to the first text block that yields a hint, skipping non-text blocks", () => {
    const row: SkillTrigger = {
      id: "second",
      on: "success",
      hint: ({ text: t }) => (t === "two" ? "HINT" : null),
    };
    const content = [{ type: "image" }, text("one"), text("two")];
    const out = applySkillTriggers({ toolName: "t", isError: false, content }, () => [], [row]);
    expect(out?.content).toEqual([{ type: "image" }, text("one"), text("two\n\nHINT")]);
    expect(content[2].text).toBe("two");
  });
});

describe("registerSkillTriggers", () => {
  let dir: string;

  function hook() {
    const on = vi.fn();
    registerSkillTriggers({ on, getActiveTools: () => TOOLS } as unknown as ExtensionAPI);
    const handler = on.mock.calls.find(([n]) => n === "message_end")![1];
    return (message: unknown) => handler({ message });
  }

  function activityKinds(): string[] {
    try {
      return readFileSync(join(dir, "activity.jsonl"), "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).kind);
    } catch {
      return [];
    }
  }

  beforeEach(() => {
    resetState();
    resetActivity();
    dir = mkdtempSync(join(tmpdir(), "skill-triggers-"));
    writeFileSync(join(dir, "notebook.md"), "# nb\n");
    setNotebookPath(join(dir, "notebook.md"));
  });
  afterEach(() => {
    setNotebookPath(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rewrites the tool result and logs a skill.hint event", () => {
    const fire = hook();
    const res = fire({
      role: "toolResult",
      toolName: "galaxy_invocation_check_all",
      toolCallId: "call-1",
      isError: false,
      content: [text(FAILED_CHECK)],
    });
    expect(res.message.content[0].text).toContain(INVOCATION_FAILED_HINT);
    const line = JSON.parse(readFileSync(join(dir, "activity.jsonl"), "utf-8").trim());
    expect(line.kind).toBe("skill.hint");
    expect(line.payload).toEqual({
      trigger: "invocation-failed",
      toolName: "galaxy_invocation_check_all",
      toolCallId: "call-1",
    });
  });

  it("uses the live active-tool list for the confusables row", () => {
    const fire = hook();
    const res = fire({
      role: "toolResult",
      toolName: CONFUSED,
      toolCallId: "call-2",
      isError: true,
      content: [text(`Tool ${CONFUSED} not found`)],
    });
    expect(res.message.content[0].text).toContain(
      "Did you mean `mcp__brc_analytics__get_organism`?",
    );
  });

  it("leaves results alone and logs nothing when no row fires", () => {
    const fire = hook();
    const res = fire({
      role: "toolResult",
      toolName: "mcp__galaxy__run_tool",
      toolCallId: "call-3",
      isError: false,
      content: [text("{}")],
    });
    expect(res).toBeUndefined();
    expect(activityKinds()).toEqual([]);
  });

  it("ignores messages that aren't tool results", () => {
    const fire = hook();
    expect(fire({ role: "assistant", content: [text(FAILED_CHECK)] })).toBeUndefined();
  });

  it("still hints when there is no notebook to log to", () => {
    setNotebookPath(null);
    const fire = hook();
    const res = fire({
      role: "toolResult",
      toolName: "galaxy_invocation_check_one",
      toolCallId: "call-4",
      isError: false,
      content: [text(FAILED_CHECK)],
    });
    expect(res.message.content[0].text).toContain(INVOCATION_FAILED_HINT);
  });
});
