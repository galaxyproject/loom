// @vitest-environment happy-dom
//
// Stateful tests for the ChatPanel -> export `history` buffer. These drive a
// real ChatPanel against a happy-dom container (the pure historyToMarkdown /
// fragmentToMarkdown helpers are covered separately in chat-panel.test.ts).
import { beforeEach, describe, expect, it } from "vitest";
import { ChatPanel } from "../app/src/renderer/chat/chat-panel.js";
import { TEAM_DISPATCH_KIND } from "../shared/team-dispatch-contract.js";

beforeEach(() => {
  document.body.innerHTML = "";
});

function makePanel(): ChatPanel {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return new ChatPanel(container);
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("ChatPanel error history", () => {
  it("records one entry per visible card when duplicate errors collapse", () => {
    const panel = makePanel();
    // The UI collapses consecutive identical errors into one card with "(xN)";
    // the export must mirror that, not emit one block per swallowed duplicate.
    panel.addErrorMessage("boom");
    panel.addErrorMessage("boom");
    panel.addErrorMessage("boom");
    const md = panel.exportAsMarkdown();
    expect(countOccurrences(md, "*Error: boom*")).toBe(1);
  });

  it("records distinct errors separately", () => {
    const panel = makePanel();
    panel.addErrorMessage("first");
    panel.addErrorMessage("second");
    const md = panel.exportAsMarkdown();
    expect(md).toContain("*Error: first*");
    expect(md).toContain("*Error: second*");
  });
});

describe("ChatPanel tool history", () => {
  it("correlates updates by id, not by rendered tool name", () => {
    const panel = makePanel();
    // Two tools with the SAME name in one turn -- matching on name alone would
    // land both updates on the last record.
    panel.addToolCard("a", "team_dispatch");
    panel.addToolCard("b", "team_dispatch");
    panel.updateToolCard("a", "done", "result-A");
    panel.updateToolCard("b", "error", "result-B");
    const [blockA, blockB] = panel.exportAsMarkdown().split("\n---\n\n");
    expect(blockA).toContain("✓");
    expect(blockA).toContain("result-A");
    expect(blockB).toContain("✗");
    expect(blockB).toContain("result-B");
  });

  it("syncs team_dispatch records even though the card render returns early", () => {
    const panel = makePanel();
    panel.addToolCard("td", "team_dispatch");
    panel.updateToolCard("td", "done", "team finished", {
      kind: TEAM_DISPATCH_KIND,
      summary: "ran the team",
    });
    // Without the fix the team_dispatch branch returns before syncing history,
    // so the export would stay frozen at the running badge.
    const md = panel.exportAsMarkdown();
    expect(md).toContain("Tool call ✓");
    expect(md).not.toContain("Tool call …");
  });
});

describe("ChatPanel text/tool ordering", () => {
  it("records assistant prose in order relative to tool cards", () => {
    const panel = makePanel();
    panel.startAssistantMessage();
    panel.appendDelta("Let me run a team.");
    panel.addToolCard("t1", "team_dispatch");
    panel.updateToolCard("t1", "done", "team result");
    panel.separateNextBlock();
    panel.appendDelta("All done!");
    panel.finishAssistantMessage();

    const md = panel.exportAsMarkdown();
    const iBefore = md.indexOf("Let me run a team.");
    const iTool = md.indexOf("Tool call");
    const iAfter = md.indexOf("All done!");
    expect(iBefore).toBeGreaterThanOrEqual(0);
    expect(iAfter).toBeGreaterThanOrEqual(0);
    // prose-before-tool must export before the tool card, prose-after must follow it
    expect(iBefore).toBeLessThan(iTool);
    expect(iTool).toBeLessThan(iAfter);
  });

  it("flushes pending prose before an error so order is preserved", () => {
    const panel = makePanel();
    panel.startAssistantMessage();
    panel.appendDelta("Trying the thing.");
    panel.addErrorMessage("it broke");
    panel.finishAssistantMessage();
    const md = panel.exportAsMarkdown();
    expect(md.indexOf("Trying the thing.")).toBeLessThan(md.indexOf("*Error: it broke*"));
  });
});
