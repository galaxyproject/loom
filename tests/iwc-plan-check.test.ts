import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const galaxyStatus = vi.hoisted(() => ({ value: "usable" }));
vi.mock("../extensions/loom/profiles", () => ({ activeGalaxyStatus: () => galaxyStatus.value }));

import {
  draftsPlan,
  IWC_PLAN_NUDGE,
  isIwcLookup,
  registerIwcPlanCheck,
} from "../extensions/loom/iwc-plan-check";
import { setActiveFollowUpDelivery, type FollowUpDelivery } from "../extensions/loom/auto-resume";
import { resetState, setNotebookPath } from "../extensions/loom/state";
import { resetActivity } from "../extensions/loom/activity";

const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...extra,
});
const PLAN =
  "Here's a draft:\n```plan\n## Plan A: QC [local]\n- [ ] 1. **FastQC** -- raw reads\n```";
const TOOLS = ["read", "mcp__galaxy__recommend_iwc_workflows", "mcp__galaxy__run_tool"];

describe("draftsPlan", () => {
  it("sees a plan fence or a bare plan heading in assistant text", () => {
    expect(draftsPlan([assistant(PLAN)])).toBe(true);
    expect(draftsPlan([assistant("## Plan B: RNA-seq DE [galaxy]\n- [ ] 1. x")])).toBe(true);
  });

  it("ignores prose about plans and the user's own messages", () => {
    expect(draftsPlan([assistant("Want me to draft a plan for this?")])).toBe(false);
    expect(draftsPlan([{ role: "user", content: [{ type: "text", text: PLAN }] }])).toBe(false);
  });
});

describe("isIwcLookup", () => {
  it("counts the IWC tools", () => {
    expect(isIwcLookup("mcp__galaxy__recommend_iwc_workflows")).toBe(true);
    expect(isIwcLookup("mcp__galaxy__search_iwc_workflows")).toBe(true);
  });

  it("doesn't count other Galaxy tools", () => {
    expect(isIwcLookup("mcp__galaxy__search_tools_by_name")).toBe(false);
    expect(isIwcLookup("mcp__galaxy__run_tool")).toBe(false);
  });
});

describe("registerIwcPlanCheck", () => {
  let dir: string;
  let delivered: string[];
  let activeTools: string[];

  function hooks() {
    const on = vi.fn();
    registerIwcPlanCheck({ on, getActiveTools: () => activeTools } as unknown as ExtensionAPI);
    const get = (name: string) => on.mock.calls.find(([n]) => n === name)![1];
    return {
      sessionStart: () => get("session_start")({}),
      toolStart: (toolName: string, args: unknown = {}) =>
        get("tool_execution_start")({ toolName, args }),
      agentEnd: (messages: unknown[]) => get("agent_end")({ messages }),
    };
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
    galaxyStatus.value = "usable";
    activeTools = TOOLS;
    delivered = [];
    setActiveFollowUpDelivery({
      deliver: (t: string) => delivered.push(t),
    } as unknown as FollowUpDelivery);
    dir = mkdtempSync(join(tmpdir(), "iwc-plan-check-"));
    writeFileSync(join(dir, "notebook.md"), "# nb\n");
    setNotebookPath(join(dir, "notebook.md"));
  });
  afterEach(() => {
    setActiveFollowUpDelivery(null);
    setNotebookPath(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends one follow-up when a plan is drafted without an IWC lookup", async () => {
    const h = hooks();
    await h.toolStart("mcp__galaxy__search_tools_by_name");
    await h.agentEnd([assistant(PLAN)]);
    expect(delivered).toEqual([IWC_PLAN_NUDGE]);
    expect(activityKinds()).toEqual(["plan.iwc_check"]);
  });

  it("only nudges once per session", async () => {
    const h = hooks();
    await h.agentEnd([assistant(PLAN)]);
    await h.agentEnd([assistant(PLAN)]);
    expect(delivered).toHaveLength(1);
    await h.sessionStart();
    await h.agentEnd([assistant(PLAN)]);
    expect(delivered).toHaveLength(2);
  });

  it("stays quiet once IWC has been consulted this session", async () => {
    const h = hooks();
    await h.toolStart("mcp__galaxy__recommend_iwc_workflows", {});
    await h.agentEnd([assistant("some answer")]);
    await h.agentEnd([assistant(PLAN)]);
    expect(delivered).toEqual([]);
  });

  it("stays quiet without a plan, without Galaxy, without the IWC tools, or after Stop", async () => {
    const h = hooks();
    await h.agentEnd([assistant("Here's how DESeq2 works.")]);

    galaxyStatus.value = "none";
    await h.agentEnd([assistant(PLAN)]);
    galaxyStatus.value = "usable";

    activeTools = ["read", "write", "edit"];
    await h.agentEnd([assistant(PLAN)]);
    activeTools = TOOLS;

    await h.agentEnd([assistant(PLAN, { stopReason: "aborted" })]);
    expect(delivered).toEqual([]);
    expect(activityKinds()).toEqual([]);
  });
});
