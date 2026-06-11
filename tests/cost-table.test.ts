import { describe, it, expect } from "vitest";
import {
  buildCostBreakdown,
  resolveCostCommand,
  buildCostAppendPrompt,
  runCostCommand,
  type CostCommandView,
  type Usage,
} from "../app/src/renderer/cost-table.js";

// A tiny pricing table + computeCost stand-in. The point of the unit is that it
// builds the table purely from counters via an injected cost function, so the
// test never touches the renderer's real PRICING map.
const PRICE: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  "claude-haiku-4-5": { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

function computeCost(u: Usage, model: string): number | null {
  const p = PRICE[model];
  if (!p) return null;
  return (
    (u.input * p.in) / 1_000_000 +
    (u.output * p.out) / 1_000_000 +
    (u.cacheRead * p.cacheRead) / 1_000_000 +
    (u.cacheWrite * p.cacheWrite) / 1_000_000
  );
}

describe("buildCostBreakdown", () => {
  it("builds the markdown table directly from the per-model usage counters", () => {
    const usage = new Map<string, Usage>([
      ["claude-haiku-4-5", { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 100 }],
    ]);

    const { table, grandCost, totalCostKnown } = buildCostBreakdown(usage, computeCost);

    expect(table).toContain("`claude-haiku-4-5`");
    expect(table).toContain("1,000"); // input, toLocaleString
    expect(table).toContain("500"); // output
    expect(table).toContain("2,000"); // cache read
    expect(table).toContain("**Total**");
    expect(totalCostKnown).toBe(true);
    // 1000*1 + 500*5 + 2000*0.1 + 100*1.25 = 1000 + 2500 + 200 + 125 = 3825 / 1e6
    expect(grandCost).toBeCloseTo(0.003825, 6);
    expect(table).toContain("$0.0038");
  });

  it("flags models with no pricing entry as unknown and the total as a lower bound", () => {
    const usage = new Map<string, Usage>([
      ["mystery-model", { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }],
    ]);

    const { table, totalCostKnown } = buildCostBreakdown(usage, computeCost);

    expect(totalCostKnown).toBe(false);
    expect(table).toContain("unknown (no pricing entry)");
    expect(table).toContain("some models unpriced");
  });

  it("sums tokens across every model into the total row", () => {
    const usage = new Map<string, Usage>([
      ["claude-haiku-4-5", { input: 100, output: 10, cacheRead: 5, cacheWrite: 1 }],
      ["mystery-model", { input: 200, output: 20, cacheRead: 5, cacheWrite: 1 }],
    ]);

    const { table } = buildCostBreakdown(usage, computeCost);

    // 100 + 200 = 300 input, 10 + 20 = 30 output across both models.
    expect(table).toMatch(/\*\*Total\*\*[^\n]*\*\*300\*\*[^\n]*\*\*30\*\*/);
  });
});

describe("resolveCostCommand", () => {
  it("returns an empty action when no billable turns have been recorded", () => {
    const action = resolveCostCommand(new Map(), computeCost);
    expect(action.kind).toBe("empty");
  });

  // The default /cost path must be a pure local render: resolveCostCommand's only
  // collaborator is the injected cost function — it has no access to any agent /
  // prompt mechanism, so by construction it cannot issue a model call.
  it("returns a local-render table action built from counters, with no model call", () => {
    const usage = new Map<string, Usage>([
      ["claude-haiku-4-5", { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }],
    ]);

    const action = resolveCostCommand(usage, computeCost);

    expect(action.kind).toBe("table");
    if (action.kind === "table") {
      expect(action.table).toContain("`claude-haiku-4-5`");
      expect(action.table).toContain("1,000");
    }
  });
});

describe("buildCostAppendPrompt", () => {
  it("embeds the already-rendered table verbatim under the Session cost heading", () => {
    const table = "| Model | Cost |\n|---|---|\n| `x` | $0 |";
    const prompt = buildCostAppendPrompt(table);

    expect(prompt).toContain(table);
    expect(prompt).toContain("## Session cost");
    expect(prompt).toMatch(/append/i);
  });
});

describe("runCostCommand", () => {
  function makeView() {
    const calls = {
      addUserMessage: [] as string[],
      addErrorMessage: [] as string[],
      renderBreakdown: [] as string[],
      beginNotebookAppend: 0,
      promptAgent: [] as string[],
    };
    let captured: (() => void) | null = null;
    const view: CostCommandView = {
      addUserMessage: (t) => void calls.addUserMessage.push(t),
      addErrorMessage: (t) => void calls.addErrorMessage.push(t),
      renderBreakdown: (table, onAppend) => {
        calls.renderBreakdown.push(table);
        captured = onAppend;
      },
      beginNotebookAppend: () => void (calls.beginNotebookAppend += 1),
      promptAgent: (m) => void calls.promptAgent.push(m),
    };
    return { view, calls, clickAppend: () => captured?.() };
  }

  const usage = () =>
    new Map<string, Usage>([
      ["claude-haiku-4-5", { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }],
    ]);

  it("renders the breakdown locally and makes NO model call on the default path", () => {
    const { view, calls } = makeView();

    runCostCommand("/cost", usage(), computeCost, view);

    expect(calls.addUserMessage).toEqual(["/cost"]);
    expect(calls.renderBreakdown).toHaveLength(1);
    expect(calls.renderBreakdown[0]).toContain("`claude-haiku-4-5`");
    // The whole point of #263: the default /cost path must not bill the model.
    expect(calls.promptAgent).toEqual([]);
    expect(calls.beginNotebookAppend).toBe(0);
  });

  it("calls the agent only when the opt-in append action fires", () => {
    const { view, calls, clickAppend } = makeView();

    runCostCommand("/cost", usage(), computeCost, view);
    expect(calls.promptAgent).toEqual([]);

    clickAppend();

    expect(calls.beginNotebookAppend).toBe(1);
    expect(calls.promptAgent).toHaveLength(1);
    expect(calls.promptAgent[0]).toContain("## Session cost");
    expect(calls.promptAgent[0]).toContain("`claude-haiku-4-5`");
  });

  it("shows an error and makes no model call when no usage is recorded", () => {
    const { view, calls } = makeView();

    runCostCommand("/cost", new Map(), computeCost, view);

    expect(calls.addUserMessage).toEqual(["/cost"]);
    expect(calls.addErrorMessage).toHaveLength(1);
    expect(calls.renderBreakdown).toEqual([]);
    expect(calls.promptAgent).toEqual([]);
  });
});
