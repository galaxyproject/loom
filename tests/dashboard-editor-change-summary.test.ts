import { describe, expect, it } from "vitest";
import { describeDocumentChange } from "../app/src/renderer/dashboard/editor/change-summary.js";
import type { DashboardDocument, DashboardPanel } from "../shared/dashboard-contract.js";

const nameOf = (panel: DashboardPanel): string => panel.title ?? panel.widget;

function doc(overrides: Partial<DashboardDocument> = {}): DashboardDocument {
  return {
    version: 1,
    activeId: "d",
    dashboards: [
      {
        id: "d",
        title: "Main",
        panels: [
          {
            id: "p0",
            widget: "notebook",
            title: "Notebook",
            config: { follow: true },
            layout: { span: 2, rows: 3 },
          },
          { id: "p1", widget: "jobs", title: "Jobs", config: {}, layout: { span: 1, rows: 2 } },
        ],
      },
    ],
    ...overrides,
  };
}

function edit(fn: (d: DashboardDocument) => void): DashboardDocument {
  const next = doc();
  fn(next);
  return next;
}

describe("a change confined to panel settings", () => {
  it("names the panel and is marked as a config change", () => {
    const after = edit((d) => {
      d.dashboards[0].panels[0].config = { follow: false };
    });
    expect(describeDocumentChange(doc(), after, nameOf)).toEqual({
      kind: "config",
      label: "Changed “Notebook” settings",
    });
  });

  it("says so without naming one when several moved", () => {
    const after = edit((d) => {
      d.dashboards[0].panels[0].config = { follow: false };
      d.dashboards[0].panels[1].config = { limit: 3 };
    });
    expect(describeDocumentChange(doc(), after, nameOf)).toEqual({
      kind: "config",
      label: "Changed some panel settings",
    });
  });

  it("is not a config change when anything else moved with it", () => {
    const after = edit((d) => {
      d.dashboards[0].panels[0].config = { follow: false };
      d.dashboards[0].panels[0].layout.rows = 5;
    });
    expect(describeDocumentChange(doc(), after, nameOf).kind).toBe("structure");
  });
});

describe("a structural change", () => {
  it("names a panel that appeared", () => {
    const after = edit((d) => {
      d.dashboards[0].panels.push({
        id: "p2",
        widget: "plan",
        title: "Plan",
        config: {},
        layout: { span: 1, rows: 2 },
      });
    });
    expect(describeDocumentChange(doc(), after, nameOf)).toEqual({
      kind: "structure",
      label: "“Plan” was added",
    });
  });

  it("names a panel that went", () => {
    const after = edit((d) => {
      d.dashboards[0].panels.splice(1, 1);
    });
    expect(describeDocumentChange(doc(), after, nameOf).label).toBe("“Jobs” was removed");
  });

  it("counts rather than names when several came or went", () => {
    const added = edit((d) => {
      d.dashboards[0].panels.push(
        { id: "p2", widget: "plan", config: {}, layout: { span: 1, rows: 2 } },
        { id: "p3", widget: "results", config: {}, layout: { span: 1, rows: 2 } },
      );
    });
    expect(describeDocumentChange(doc(), added, nameOf).label).toBe("2 panels were added");
    const gone = edit((d) => {
      d.dashboards[0].panels = [];
    });
    expect(describeDocumentChange(doc(), gone, nameOf).label).toBe("2 panels were removed");
  });

  it("names a dashboard that appeared or went, in preference to its panels", () => {
    const added = edit((d) => {
      d.dashboards.push({
        id: "e",
        title: "Monitoring",
        panels: [{ id: "q0", widget: "jobs", config: {}, layout: { span: 1, rows: 2 } }],
      });
    });
    expect(describeDocumentChange(doc(), added, nameOf).label).toBe(
      "A dashboard was added: “Monitoring”",
    );
    expect(describeDocumentChange(added, doc(), nameOf).label).toBe(
      "A dashboard was removed: “Monitoring”",
    );
  });

  it("falls back to saying only that something changed", () => {
    const reordered = edit((d) => {
      d.dashboards[0].panels.reverse();
    });
    expect(describeDocumentChange(doc(), reordered, nameOf)).toEqual({
      kind: "structure",
      label: "The dashboard was changed outside the editor",
    });
  });

  it("does not mistake a panel that only moved dashboards for one that vanished", () => {
    // Same panel id under a different dashboard is a different panel to this,
    // which is what keeps the presets' reused `p-notebook` from confusing it.
    const before = edit((d) => {
      d.dashboards.push({ id: "e", title: "Other", panels: [] });
    });
    const after = JSON.parse(JSON.stringify(before)) as DashboardDocument;
    after.dashboards[1].panels.push(after.dashboards[0].panels.pop()!);
    const change = describeDocumentChange(before, after, nameOf);
    expect(change.kind).toBe("structure");
    expect(change.label).toBe("“Jobs” was added");
  });
});
