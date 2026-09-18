import { describe, expect, it } from "vitest";
import {
  DASHBOARD_FILENAME,
  DASHBOARD_PRESETS,
  DASHBOARD_SCHEMA_VERSION,
  createDefaultDashboardDocument,
  dashboardFromPreset,
  parseDashboardDocument,
  serializeDashboardDocument,
  validateDashboardDocument,
} from "../shared/dashboard-contract.js";
import type { DashboardDocument } from "../shared/dashboard-contract.js";

function expectOk(result: ReturnType<typeof validateDashboardDocument>): DashboardDocument {
  if (!result.ok) throw new Error(`expected ok, got problems: ${JSON.stringify(result.problems)}`);
  return result.document;
}

describe("presets", () => {
  it("names the layout file next to the notebook", () => {
    expect(DASHBOARD_FILENAME).toBe(".loom-dashboard.json");
  });

  it("ships a current-analysis preset of plan + jobs + notebook, in that order", () => {
    // Order is the product decision, not an accident: someone opening the tab
    // asks "where are we", then "what is Galaxy doing", and only then wants the
    // notebook, which is a markdown dump and owns the next tab along anyway.
    const preset = dashboardFromPreset("current-analysis");
    expect(preset?.panels.map((p) => p.widget)).toEqual(["plan", "jobs", "notebook"]);
  });

  it("marks preset panels as coming from a preset", () => {
    const preset = dashboardFromPreset("current-analysis")!;
    expect(preset.panels.every((p) => p.addedBy === "preset")).toBe(true);
  });

  it("hands out copies, so a caller cannot mutate the preset", () => {
    const first = dashboardFromPreset("current-analysis")!;
    first.panels.pop();
    expect(dashboardFromPreset("current-analysis")!.panels).toHaveLength(3);
  });

  it("returns null for a preset that does not exist", () => {
    expect(dashboardFromPreset("nope")).toBeNull();
  });

  it("validates every shipped preset without repairs", () => {
    for (const preset of DASHBOARD_PRESETS) {
      const result = validateDashboardDocument({
        version: DASHBOARD_SCHEMA_VERSION,
        activeId: preset.dashboard.id,
        dashboards: [preset.dashboard],
      });
      expect(result.ok, preset.id).toBe(true);
      expect(result.problems, preset.id).toEqual([]);
    }
  });
});

describe("createDefaultDashboardDocument", () => {
  it("round-trips through serialize + parse unchanged", () => {
    const doc = createDefaultDashboardDocument();
    const parsed = expectOk(parseDashboardDocument(serializeDashboardDocument(doc)));
    expect(parsed).toEqual(doc);
  });

  it("points activeId at a dashboard that exists", () => {
    const doc = createDefaultDashboardDocument();
    expect(doc.dashboards.some((d) => d.id === doc.activeId)).toBe(true);
  });
});

describe("validateDashboardDocument -- fatal input", () => {
  it.each([
    ["null", null],
    ["a string", "hello"],
    ["an array", []],
    ["a number", 7],
    ["undefined", undefined],
  ])("rejects %s without throwing", (_label, input) => {
    const result = validateDashboardDocument(input);
    expect(result.ok).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it("rejects a missing version rather than assuming v1", () => {
    const result = validateDashboardDocument({ dashboards: [] });
    expect(result.ok).toBe(false);
    expect(result.problems[0].path).toBe("version");
  });

  it("refuses a document from a newer build and says so", () => {
    const result = validateDashboardDocument({
      version: DASHBOARD_SCHEMA_VERSION + 1,
      activeId: "a",
      dashboards: [],
    });
    expect(result.ok).toBe(false);
    expect(result.problems[0].message).toContain("newer than this build");
  });
});

describe("validateDashboardDocument -- repairs", () => {
  it("keeps an unknown widget type instead of dropping the panel", () => {
    const doc = expectOk(
      validateDashboardDocument({
        version: 1,
        activeId: "d",
        dashboards: [
          {
            id: "d",
            title: "D",
            panels: [{ id: "p", widget: "widget-from-the-future", config: {} }],
          },
        ],
      }),
    );
    expect(doc.dashboards[0].panels[0].widget).toBe("widget-from-the-future");
  });

  it("drops a panel with no widget type and reports it", () => {
    const result = validateDashboardDocument({
      version: 1,
      activeId: "d",
      dashboards: [{ id: "d", title: "D", panels: [{ id: "p" }, { id: "q", widget: "jobs" }] }],
    });
    const doc = expectOk(result);
    expect(doc.dashboards[0].panels.map((p) => p.id)).toEqual(["q"]);
    expect(result.problems.some((p) => p.path === "dashboards[0].panels[0].widget")).toBe(true);
  });

  it("renames duplicate panel ids rather than losing one", () => {
    const doc = expectOk(
      validateDashboardDocument({
        version: 1,
        activeId: "d",
        dashboards: [
          {
            id: "d",
            title: "D",
            panels: [
              { id: "p", widget: "jobs" },
              { id: "p", widget: "plan" },
            ],
          },
        ],
      }),
    );
    expect(doc.dashboards[0].panels.map((p) => p.id)).toEqual(["p", "p-2"]);
  });

  it("clamps an out-of-range row count and a bad span", () => {
    const doc = expectOk(
      validateDashboardDocument({
        version: 1,
        activeId: "d",
        dashboards: [
          {
            id: "d",
            title: "D",
            panels: [{ id: "p", widget: "jobs", layout: { span: 9, rows: 99 } }],
          },
        ],
      }),
    );
    expect(doc.dashboards[0].panels[0].layout).toEqual({ span: 1, rows: 6 });
  });

  it("replaces a non-object config with an empty one", () => {
    const doc = expectOk(
      validateDashboardDocument({
        version: 1,
        activeId: "d",
        dashboards: [{ id: "d", title: "D", panels: [{ id: "p", widget: "jobs", config: 5 }] }],
      }),
    );
    expect(doc.dashboards[0].panels[0].config).toEqual({});
  });

  it("falls back to the default dashboard when none survive", () => {
    const result = validateDashboardDocument({ version: 1, activeId: "x", dashboards: ["junk"] });
    const doc = expectOk(result);
    expect(doc.dashboards).toHaveLength(1);
    expect(doc.dashboards[0].id).toBe("current-analysis");
    expect(doc.activeId).toBe("current-analysis");
  });

  it("re-points an activeId that names no dashboard", () => {
    const result = validateDashboardDocument({
      version: 1,
      activeId: "gone",
      dashboards: [{ id: "here", title: "Here", panels: [] }],
    });
    const doc = expectOk(result);
    expect(doc.activeId).toBe("here");
    expect(result.problems.some((p) => p.path === "activeId")).toBe(true);
  });

  it("does not mutate the caller's input", () => {
    const input = {
      version: 1,
      activeId: "d",
      dashboards: [
        { id: "d", title: "D", panels: [{ id: "p", widget: "jobs", config: { a: 1 } }] },
      ],
    };
    const before = JSON.stringify(input);
    const doc = expectOk(validateDashboardDocument(input));
    doc.dashboards[0].panels[0].config.a = 2;
    expect(JSON.stringify(input)).toBe(before);
  });

  it("preserves panel provenance so agent curation needs no migration later", () => {
    const doc = expectOk(
      validateDashboardDocument({
        version: 1,
        activeId: "d",
        dashboards: [
          {
            id: "d",
            title: "D",
            panels: [
              {
                id: "p",
                widget: "jobs",
                addedBy: "agent",
                reason: "you asked about the bwa run",
                pinned: true,
              },
            ],
          },
        ],
      }),
    );
    expect(doc.dashboards[0].panels[0]).toMatchObject({
      addedBy: "agent",
      reason: "you asked about the bwa run",
      pinned: true,
    });
  });

  it("drops provenance it cannot trust rather than passing it through", () => {
    const result = validateDashboardDocument({
      version: 1,
      activeId: "d",
      dashboards: [
        {
          id: "d",
          title: "D",
          panels: [{ id: "p", widget: "jobs", addedBy: "root", pinned: "yes", reason: 3 }],
        },
      ],
    });
    const panel = expectOk(result).dashboards[0].panels[0];
    expect(panel.addedBy).toBeUndefined();
    expect(panel.pinned).toBeUndefined();
    expect(panel.reason).toBeUndefined();
    expect(result.problems.map((p) => p.path)).toEqual(
      expect.arrayContaining([
        "dashboards[0].panels[0].addedBy",
        "dashboards[0].panels[0].reason",
        "dashboards[0].panels[0].pinned",
      ]),
    );
  });

  it("caps an over-long provenance reason", () => {
    const doc = expectOk(
      validateDashboardDocument({
        version: 1,
        activeId: "d",
        dashboards: [
          {
            id: "d",
            title: "D",
            panels: [{ id: "p", widget: "jobs", reason: "z".repeat(1000) }],
          },
        ],
      }),
    );
    expect(doc.dashboards[0].panels[0].reason).toHaveLength(280);
  });

  it("caps a pathological panel count", () => {
    const panels = Array.from({ length: 100 }, (_, i) => ({ id: `p${i}`, widget: "jobs" }));
    const doc = expectOk(
      validateDashboardDocument({
        version: 1,
        activeId: "d",
        dashboards: [{ id: "d", title: "D", panels }],
      }),
    );
    expect(doc.dashboards[0].panels).toHaveLength(40);
  });
});

describe("validateDashboardDocument -- input designed to break it", () => {
  function withConfig(config: unknown) {
    return {
      version: 1,
      activeId: "d",
      dashboards: [{ id: "d", title: "D", panels: [{ id: "p", widget: "a", config }] }],
    };
  }

  it("survives a config nested thousands deep, well inside the file size cap", () => {
    // Built as text, the way it arrives: a file this deep parses fine and then
    // takes a recursive copy off the stack.
    const depth = 8000;
    const raw =
      '{"version":1,"activeId":"d","dashboards":[{"id":"d","title":"D","panels":' +
      '[{"id":"p","widget":"a","config":{"x":' +
      "[".repeat(depth) +
      "1" +
      "]".repeat(depth) +
      "}}]}]}";
    expect(raw.length).toBeLessThan(64 * 1024);

    const result = parseDashboardDocument(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.dashboards[0].panels[0].config).toEqual({});
      expect(result.problems.some((p) => p.path.endsWith(".config"))).toBe(true);
    }
  });

  it("survives a circular config", () => {
    const config: Record<string, unknown> = { a: 1 };
    config.self = config;
    const doc = expectOk(validateDashboardDocument(withConfig(config)));
    expect(doc.dashboards[0].panels[0].config).toEqual({ a: 1 });
  });

  it("drops values JSON cannot carry instead of throwing on them", () => {
    const doc = expectOk(
      validateDashboardDocument(
        withConfig({
          keep: "yes",
          big: BigInt(1),
          fn: () => 1,
          nope: undefined,
          nan: NaN,
          nested: { ok: true },
        }),
      ),
    );
    expect(doc.dashboards[0].panels[0].config).toEqual({
      keep: "yes",
      nested: { ok: true },
    });
  });

  it("skips a config property whose getter throws", () => {
    const config = { good: 1 };
    Object.defineProperty(config, "bad", {
      enumerable: true,
      get() {
        throw new Error("no");
      },
    });
    const doc = expectOk(validateDashboardDocument(withConfig(config)));
    expect(doc.dashboards[0].panels[0].config).toEqual({ good: 1 });
  });

  it("truncates absurd ids, titles and widget types rather than carrying them", () => {
    const result = validateDashboardDocument({
      version: 1,
      activeId: "d",
      dashboards: [
        {
          id: "d",
          title: "t".repeat(5000),
          panels: [{ id: "i".repeat(5000), widget: "w".repeat(5000), title: "p".repeat(5000) }],
        },
      ],
    });
    const doc = expectOk(result);
    expect(doc.dashboards[0].title).toHaveLength(200);
    const panel = doc.dashboards[0].panels[0];
    expect(panel.id).toHaveLength(200);
    expect(panel.title).toHaveLength(200);
    expect(panel.widget).toHaveLength(100);
  });

  it("does not let a generated id displace one a later panel declared", () => {
    const doc = expectOk(
      validateDashboardDocument({
        version: 1,
        activeId: "d",
        dashboards: [
          {
            id: "d",
            title: "D",
            panels: [{ widget: "a" }, { id: "panel-1", widget: "b" }],
          },
        ],
      }),
    );
    // The explicitly named panel keeps its name; the anonymous one moves.
    expect(doc.dashboards[0].panels.map((p) => p.id)).toEqual(["panel-2", "panel-1"]);
  });

  it("reports a non-string activeId, not just a wrong one", () => {
    const result = validateDashboardDocument({
      version: 1,
      activeId: 42,
      dashboards: [{ id: "d", title: "D", panels: [] }],
    });
    expect(expectOk(result).activeId).toBe("d");
    expect(result.problems.some((p) => p.path === "activeId")).toBe(true);
  });
});

describe("parseDashboardDocument", () => {
  it("reports malformed JSON instead of throwing", () => {
    const result = parseDashboardDocument("{ not json");
    expect(result.ok).toBe(false);
    expect(result.problems[0].message).toContain("not valid JSON");
  });

  it("treats an empty file as empty, not as corruption", () => {
    const result = parseDashboardDocument("   ");
    expect(result.ok).toBe(false);
    expect(result.problems[0].message).toBe("empty");
  });

  it("rejects a non-string without throwing", () => {
    expect(parseDashboardDocument(null).ok).toBe(false);
    expect(parseDashboardDocument({ version: 1 }).ok).toBe(false);
  });
});

describe("a config that tries to reach the prototype", () => {
  it("drops __proto__ instead of setting the object's prototype", () => {
    const doc = expectOk(
      validateDashboardDocument({
        version: 1,
        activeId: "d",
        dashboards: [
          {
            id: "d",
            title: "D",
            panels: [
              {
                id: "p",
                widget: "plan",
                config: JSON.parse('{"__proto__":{"polluted":"yes"},"keep":1}'),
              },
            ],
          },
        ],
      }),
    );
    const config = doc.dashboards[0].panels[0].config as Record<string, unknown>;
    expect(config.keep).toBe(1);
    // The widget must not see a key the layout never declared.
    expect(config.polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("drops constructor and prototype for the same reason", () => {
    const doc = expectOk(
      validateDashboardDocument({
        version: 1,
        activeId: "d",
        dashboards: [
          {
            id: "d",
            title: "D",
            panels: [{ id: "p", widget: "plan", config: { constructor: 1, prototype: 2, ok: 3 } }],
          },
        ],
      }),
    );
    expect(doc.dashboards[0].panels[0].config).toEqual({ ok: 3 });
  });
});
