import { describe, expect, it } from "vitest";
import {
  addPanel,
  configurePanel,
  createDashboard,
  deleteDashboard,
  duplicateDashboard,
  movePanel,
  removePanel,
  renameDashboard,
  renamePanel,
  resetDocument,
  resizePanel,
  selectDashboard,
  slugify,
  uniqueDashboardId,
  uniquePanelId,
} from "../app/src/renderer/dashboard/editor/operations.js";
import { MAX_DASHBOARDS, MAX_PANELS } from "../shared/dashboard-contract.js";
import {
  DASHBOARD_PRESETS,
  validateDashboardDocument,
  type DashboardDocument,
  type DashboardPanel,
} from "../shared/dashboard-contract.js";

/** A panel written by a build that knows a widget this one does not. */
const FROM_THE_FUTURE: DashboardPanel = {
  id: "p-future",
  widget: "galaxy-history-live",
  title: "Live history",
  config: { historyId: "abc123", nested: { deep: [1, 2, 3] } },
  layout: { span: 2, rows: 4 },
  addedBy: "agent",
  reason: "written by a newer build",
  pinned: true,
};

function doc(): DashboardDocument {
  return {
    version: 1,
    activeId: "a",
    dashboards: [
      {
        id: "a",
        title: "A",
        panels: [
          { id: "p1", widget: "notebook", config: { follow: true }, layout: { span: 2, rows: 3 } },
          { id: "p2", widget: "jobs", config: {}, layout: { span: 1, rows: 2 } },
          JSON.parse(JSON.stringify(FROM_THE_FUTURE)) as DashboardPanel,
        ],
      },
      { id: "b", title: "B", panels: [] },
    ],
  };
}

function panels(document: DashboardDocument, dashboardId = "a"): DashboardPanel[] {
  return document.dashboards.find((d) => d.id === dashboardId)?.panels ?? [];
}

function ids(document: DashboardDocument, dashboardId = "a"): string[] {
  return panels(document, dashboardId).map((p) => p.id);
}

describe("operations never mutate their input", () => {
  it("leaves the document it was given untouched", () => {
    const before = doc();
    const snapshot = JSON.stringify(before);
    addPanel(before, "a", "plan");
    removePanel(before, "a", "p1");
    movePanel(before, "a", "p1", 1);
    resizePanel(before, "a", "p1", { span: 1, rows: 6 });
    renamePanel(before, "a", "p1", "Renamed");
    configurePanel(before, "a", "p1", { follow: false });
    createDashboard(before, { title: "C" });
    duplicateDashboard(before, "a");
    deleteDashboard(before, "b");
    renameDashboard(before, "a", "AA");
    selectDashboard(before, "b");
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("a panel this build does not understand", () => {
  const untouched = (document: DashboardDocument): void => {
    const survivor = panels(document).find((p) => p.id === "p-future");
    expect(survivor).toEqual(FROM_THE_FUTURE);
  };

  it("survives every edit to its neighbours, byte for byte", () => {
    untouched(addPanel(doc(), "a", "plan"));
    untouched(removePanel(doc(), "a", "p1"));
    untouched(movePanel(doc(), "a", "p1", 1));
    untouched(resizePanel(doc(), "a", "p1", { span: 1 }));
    untouched(renamePanel(doc(), "a", "p1", "Something else"));
    untouched(configurePanel(doc(), "a", "p1", { follow: false }));
    untouched(duplicateDashboard(doc(), "a"));
    untouched(renameDashboard(doc(), "a", "AA"));
    untouched(selectDashboard(doc(), "b"));
  });

  it("can be moved, resized, renamed and removed like any other panel", () => {
    expect(ids(movePanel(doc(), "a", "p-future", -1))).toEqual(["p1", "p-future", "p2"]);
    expect(panels(resizePanel(doc(), "a", "p-future", { span: 1, rows: 1 }))[2].layout).toEqual({
      span: 1,
      rows: 1,
    });
    expect(panels(renamePanel(doc(), "a", "p-future", "Mine now"))[2].title).toBe("Mine now");
    expect(ids(removePanel(doc(), "a", "p-future"))).toEqual(["p1", "p2"]);
  });

  it("stays valid after being edited, so the layout still round-trips", () => {
    const next = movePanel(doc(), "a", "p-future", -1);
    const result = validateDashboardDocument(next);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.problems).toEqual([]);
      expect(result.document.dashboards[0].panels[1]).toEqual(FROM_THE_FUTURE);
    }
  });
});

describe("addPanel", () => {
  it("appends a panel with a unique id and marks it as the user's", () => {
    const next = addPanel(doc(), "a", "plan");
    expect(ids(next)).toEqual(["p1", "p2", "p-future", "p-plan"]);
    const added = panels(next)[3];
    expect(added.widget).toBe("plan");
    expect(added.addedBy).toBe("user");
    expect(added.layout).toEqual({ span: 1, rows: 2 });
    expect(added.config).toEqual({});
  });

  it("does not reuse an id another panel already has", () => {
    const base = addPanel(doc(), "a", "plan");
    const next = addPanel(base, "a", "plan");
    expect(ids(next)).toEqual(["p1", "p2", "p-future", "p-plan", "p-plan-2"]);
  });

  it("honours a requested title, size, config and position", () => {
    const next = addPanel(doc(), "a", "results", {
      title: "  Figures  ",
      span: 2,
      rows: 99,
      config: { limit: 4 },
      index: 0,
      addedBy: "agent",
      reason: "  a step wrote a plot  ",
    });
    const added = panels(next)[0];
    expect(added.title).toBe("Figures");
    expect(added.layout).toEqual({ span: 2, rows: 6 });
    expect(added.config).toEqual({ limit: 4 });
    expect(added.addedBy).toBe("agent");
    expect(added.reason).toBe("a step wrote a plot");
  });

  it("refuses an unknown dashboard, an empty widget type, and a full dashboard", () => {
    const base = doc();
    expect(addPanel(base, "nope", "plan")).toBe(base);
    expect(addPanel(base, "a", "   ")).toBe(base);

    let full = { ...base, dashboards: [{ id: "a", title: "A", panels: [] }], activeId: "a" };
    for (let i = 0; i < MAX_PANELS; i++) full = addPanel(full, "a", "plan");
    expect(panels(full)).toHaveLength(MAX_PANELS);
    expect(addPanel(full, "a", "plan")).toBe(full);
  });
});

describe("removePanel", () => {
  it("drops the named panel and leaves the rest in order", () => {
    expect(ids(removePanel(doc(), "a", "p1"))).toEqual(["p2", "p-future"]);
  });

  it("is a no-op for a panel or dashboard that is not there", () => {
    const base = doc();
    expect(removePanel(base, "a", "nope")).toBe(base);
    expect(removePanel(base, "nope", "p1")).toBe(base);
    // Panel ids are unique per dashboard, so the id must be looked up in the
    // dashboard it was named with, not wherever it happens to match.
    expect(removePanel(base, "b", "p1")).toBe(base);
  });
});

describe("movePanel", () => {
  it("moves one place in either direction", () => {
    expect(ids(movePanel(doc(), "a", "p1", 1))).toEqual(["p2", "p1", "p-future"]);
    expect(ids(movePanel(doc(), "a", "p-future", -1))).toEqual(["p1", "p-future", "p2"]);
  });

  it("is a no-op past either end, and for a zero move", () => {
    const base = doc();
    expect(movePanel(base, "a", "p1", -1)).toBe(base);
    expect(movePanel(base, "a", "p-future", 1)).toBe(base);
    expect(movePanel(base, "a", "p1", 0)).toBe(base);
    expect(movePanel(base, "a", "p1", 99)).toBe(base);
  });
});

describe("resizePanel", () => {
  it("sets width and height independently", () => {
    expect(panels(resizePanel(doc(), "a", "p2", { span: 2 }))[1].layout).toEqual({
      span: 2,
      rows: 2,
    });
    expect(panels(resizePanel(doc(), "a", "p2", { rows: 5 }))[1].layout).toEqual({
      span: 1,
      rows: 5,
    });
  });

  it("clamps height to the schema's range instead of writing an invalid one", () => {
    expect(panels(resizePanel(doc(), "a", "p2", { rows: 0 }))[1].layout.rows).toBe(1);
    expect(panels(resizePanel(doc(), "a", "p2", { rows: 1000 }))[1].layout.rows).toBe(6);
    expect(panels(resizePanel(doc(), "a", "p2", { rows: 2.6 }))[1].layout.rows).toBe(3);
  });

  it("is a no-op when nothing would change, including at a bound", () => {
    const base = doc();
    expect(resizePanel(base, "a", "p2", { span: 1 })).toBe(base);
    expect(resizePanel(base, "a", "p2", { rows: 2 })).toBe(base);
    expect(resizePanel(base, "a", "p2", {})).toBe(base);
    const short = resizePanel(base, "a", "p2", { rows: 1 });
    expect(resizePanel(short, "a", "p2", { rows: 0 })).toBe(short);
  });
});

describe("renamePanel", () => {
  it("sets a title and clears it again", () => {
    const named = renamePanel(doc(), "a", "p2", "  Galaxy work  ");
    expect(panels(named)[1].title).toBe("Galaxy work");
    const cleared = renamePanel(named, "a", "p2", "   ");
    expect(panels(cleared)[1].title).toBeUndefined();
    expect("title" in panels(cleared)[1]).toBe(false);
  });

  it("is a no-op when the name is the one it already has", () => {
    const named = renamePanel(doc(), "a", "p2", "Galaxy work");
    expect(renamePanel(named, "a", "p2", " Galaxy work ")).toBe(named);
    const base = doc();
    expect(renamePanel(base, "a", "p2", "")).toBe(base);
  });
});

describe("configurePanel", () => {
  it("replaces the config wholesale rather than merging", () => {
    const next = configurePanel(doc(), "a", "p1", { other: 1 });
    expect(panels(next)[0].config).toEqual({ other: 1 });
  });

  it("copies the config it is given, so a later edit to that object does not leak in", () => {
    const config: Record<string, unknown> = { follow: false };
    const next = configurePanel(doc(), "a", "p1", config);
    config.follow = true;
    expect(panels(next)[0].config).toEqual({ follow: false });
  });

  it("is a no-op for an identical config", () => {
    const base = doc();
    expect(configurePanel(base, "a", "p1", { follow: true })).toBe(base);
  });
});

describe("dashboards", () => {
  it("creates an empty one, selected, with an id derived from the name", () => {
    const next = createDashboard(doc(), { title: "My QC run" });
    expect(next.dashboards.map((d) => d.id)).toEqual(["a", "b", "my-qc-run"]);
    expect(next.activeId).toBe("my-qc-run");
    expect(panels(next, "my-qc-run")).toEqual([]);
  });

  it("creates one from a preset, with the preset's panels", () => {
    const preset = DASHBOARD_PRESETS.find((p) => p.id === "monitoring");
    const next = createDashboard(doc(), { presetId: "monitoring" });
    const created = next.dashboards.find((d) => d.id === next.activeId);
    expect(created?.title).toBe(preset?.label);
    expect(created?.panels.map((p) => p.widget)).toEqual(
      preset?.dashboard.panels.map((p) => p.widget),
    );
  });

  it("refuses a preset name it does not have, rather than making an empty one", () => {
    const base = doc();
    expect(createDashboard(base, { presetId: "not-a-preset" })).toBe(base);
  });

  it("falls back to a usable name when the one given is blank or unsluggable", () => {
    expect(createDashboard(doc(), { title: "   " }).activeId).toBe("new-dashboard");
    const symbols = createDashboard(doc(), { title: "!!!" });
    expect(symbols.dashboards.find((d) => d.id === symbols.activeId)?.title).toBe("!!!");
    expect(symbols.activeId).toBe("dashboard");
  });

  it("never reuses a dashboard id", () => {
    const once = createDashboard(doc(), { title: "A" });
    expect(once.activeId).toBe("a-2");
    const twice = createDashboard(once, { title: "A" });
    expect(twice.activeId).toBe("a-3");
  });

  it("duplicates in place, keeps the panel ids, and selects the copy", () => {
    const next = duplicateDashboard(doc(), "a");
    expect(next.dashboards.map((d) => d.id)).toEqual(["a", "a-copy", "b"]);
    expect(next.activeId).toBe("a-copy");
    expect(next.dashboards[1].title).toBe("A (copy)");
    expect(ids(next, "a-copy")).toEqual(ids(doc(), "a"));
  });

  it("gives the copy its own panels array, so editing one does not change the other", () => {
    const next = duplicateDashboard(doc(), "a");
    expect(next.dashboards[1].panels).not.toBe(next.dashboards[0].panels);
    const edited = removePanel(next, "a-copy", "p1");
    expect(ids(edited, "a")).toEqual(["p1", "p2", "p-future"]);
    expect(ids(edited, "a-copy")).toEqual(["p2", "p-future"]);
  });

  it("renames, and ignores a blank or unchanged name", () => {
    const next = renameDashboard(doc(), "a", "  Sequencing  ");
    expect(next.dashboards[0].title).toBe("Sequencing");
    const base = doc();
    expect(renameDashboard(base, "a", "  ")).toBe(base);
    expect(renameDashboard(base, "a", "A")).toBe(base);
    expect(renameDashboard(base, "nope", "x")).toBe(base);
  });

  it("deletes, moving the selection to a neighbour", () => {
    const next = deleteDashboard(doc(), "a");
    expect(next.dashboards.map((d) => d.id)).toEqual(["b"]);
    expect(next.activeId).toBe("b");
  });

  it("leaves the selection alone when a dashboard other than the active one goes", () => {
    const next = deleteDashboard(doc(), "b");
    expect(next.activeId).toBe("a");
  });

  it("refuses to delete the last dashboard", () => {
    const one = deleteDashboard(doc(), "b");
    expect(deleteDashboard(one, "a")).toBe(one);
  });

  it("refuses to go past the dashboard cap", () => {
    let full = doc();
    while (full.dashboards.length < MAX_DASHBOARDS) full = createDashboard(full, { title: "x" });
    expect(full.dashboards).toHaveLength(MAX_DASHBOARDS);
    expect(createDashboard(full, { title: "one more" })).toBe(full);
    expect(duplicateDashboard(full, "a")).toBe(full);
  });

  it("selects only a dashboard that exists", () => {
    const base = doc();
    expect(selectDashboard(base, "b").activeId).toBe("b");
    expect(selectDashboard(base, "a")).toBe(base);
    expect(selectDashboard(base, "nope")).toBe(base);
  });
});

describe("every operation produces a document the validator accepts unchanged", () => {
  const cases: Array<[string, DashboardDocument]> = [
    ["add", addPanel(doc(), "a", "plan")],
    ["remove", removePanel(doc(), "a", "p1")],
    ["move", movePanel(doc(), "a", "p1", 1)],
    ["resize", resizePanel(doc(), "a", "p1", { span: 1, rows: 6 })],
    ["rename panel", renamePanel(doc(), "a", "p1", "Log")],
    ["configure", configurePanel(doc(), "a", "p1", { follow: false })],
    ["new dashboard", createDashboard(doc(), { presetId: "results" })],
    ["duplicate", duplicateDashboard(doc(), "a")],
    ["rename dashboard", renameDashboard(doc(), "a", "AA")],
    ["delete dashboard", deleteDashboard(doc(), "b")],
    ["select", selectDashboard(doc(), "b")],
    ["reset", resetDocument()],
  ];

  for (const [name, document] of cases) {
    it(`${name} needs no repairs`, () => {
      const result = validateDashboardDocument(document);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.problems).toEqual([]);
        expect(result.document).toEqual(document);
      }
    });
  }
});

describe("id helpers", () => {
  it("slugifies, and falls back when nothing survives", () => {
    expect(slugify("My QC Run!", "x")).toBe("my-qc-run");
    expect(slugify("  ---  ", "fallback")).toBe("fallback");
    expect(slugify("a".repeat(200), "x")).toHaveLength(60);
  });

  it("suffixes until free", () => {
    const base = doc();
    expect(uniqueDashboardId(base, "c")).toBe("c");
    expect(uniqueDashboardId(base, "a")).toBe("a-2");
    expect(uniquePanelId(base.dashboards[0], "p1")).toBe("p1-2");
    expect(uniquePanelId(base.dashboards[0], "p9")).toBe("p9");
  });
});
