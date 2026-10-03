/**
 * `dashboard_read` / `dashboard_update` -- the brain's handle on the layout the
 * user sees beside the chat.
 *
 * What these pin down, in rough order of how much it matters: the agent cannot
 * touch a panel the user placed or pinned, however it phrases the write; it
 * cannot create a widget this build does not draw, the sandboxed HTML one least
 * of all; the write is a compare-and-swap through a temp file at a path no tool
 * argument can influence; and a refusal writes nothing at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DASHBOARD_FILENAME,
  DASHBOARD_MAX_BYTES,
  createDefaultDashboardDocument,
  serializeDashboardDocument,
} from "../shared/dashboard-contract.js";
import type { DashboardDocument } from "../shared/dashboard-contract.js";
import { resetState, setNotebookPath } from "../extensions/loom/state";
import {
  applyDashboardActions,
  introducedWidgetTypes,
  isProtectedPanel,
  presetLines,
  provenanceViolations,
  commitDashboardChange,
  reassertProvenance,
  registerDashboardTools,
  widgetCatalogLines,
  MAX_READ_CHARS,
} from "../extensions/loom/dashboard-tools";
import {
  getDashboardPath,
  resetDashboardUndo,
  updateDashboardDocument,
} from "../extensions/loom/dashboard-store";

interface ToolDef {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    callId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: () => void,
    ctx: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text: string }[]; details?: unknown }>;
  renderResult?: (result: { details?: unknown }) => unknown;
}

let tmpDir: string;
let dashPath: string;

function tools(): Map<string, ToolDef> {
  const registered: ToolDef[] = [];
  const api = { registerTool: (def: ToolDef) => registered.push(def) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerDashboardTools(api as any);
  return new Map(registered.map((t) => [t.name, t]));
}

async function run(
  name: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const tool = tools().get(name);
  if (!tool) throw new Error(`${name} not registered`);
  const result = await tool.execute("call-1", params, new AbortController().signal, vi.fn(), {});
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function onDisk(): DashboardDocument {
  return JSON.parse(fs.readFileSync(dashPath, "utf-8")) as DashboardDocument;
}

/** A document with one dashboard whose panels are exactly what a test needs. */
function documentWith(panels: DashboardDocument["dashboards"][0]["panels"]): DashboardDocument {
  return {
    version: 1,
    activeId: "current-analysis",
    dashboards: [{ id: "current-analysis", title: "Current analysis", panels }],
  };
}

function seed(document: DashboardDocument): void {
  fs.writeFileSync(dashPath, serializeDashboardDocument(document), "utf-8");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dashboard-agent-"));
  fs.writeFileSync(path.join(tmpDir, "notebook.md"), "# notebook\n", "utf-8");
  dashPath = path.join(tmpDir, DASHBOARD_FILENAME);
  resetState();
  resetDashboardUndo();
  setNotebookPath(path.join(tmpDir, "notebook.md"));
});

afterEach(() => {
  resetState();
  resetDashboardUndo();
  delete process.env.LOOM_SHELL_KIND;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("registration", () => {
  it("registers exactly the two dashboard tools", () => {
    expect([...tools().keys()].sort()).toEqual(["dashboard_read", "dashboard_update"]);
  });

  it("tells the model in the write tool's description that it acts only when asked", () => {
    // Weak on purpose: "only when asked" has no code path to test, because the
    // whole mechanism IS the sentence in the description. This guards against
    // someone tidying it away, nothing more -- the tests below carry the
    // enforcement that does exist.
    const description = tools().get("dashboard_update")!.description;
    expect(description).toContain("Only when the user asks");
    expect(description).toContain("on your own");
    expect(description).toContain("pinned");
  });

  it("takes no filesystem path from the model", () => {
    for (const tool of tools().values()) {
      const keys = Object.keys(
        (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {},
      );
      expect(keys.filter((k) => /path|file|dir/i.test(k))).toEqual([]);
    }
  });

  it("derives the advertised widget vocabulary from the shared contract", () => {
    // Not a second hand-written list: the notebook widget's example config is
    // the one the shipped preset uses.
    expect(widgetCatalogLines()).toContain('notebook (config {"follow":true})');
    expect(widgetCatalogLines()).toContain("jobs (config {})");
    expect(widgetCatalogLines().some((line) => line.startsWith("html-sandbox"))).toBe(false);
    expect(presetLines().some((line) => line.startsWith("current-analysis --"))).toBe(true);
  });
});

describe("dashboard_read", () => {
  it("reports the default layout when nothing is on disk", async () => {
    const result = await run("dashboard_read");
    expect(result.success).toBe(true);
    expect(result.exists).toBe(false);
    expect(result.note).toContain("No layout file yet");
    expect((result.document as DashboardDocument).dashboards[0].id).toBe("current-analysis");
    expect(fs.existsSync(dashPath)).toBe(false);
  });

  it("reads what is on disk, with provenance in the summary", async () => {
    seed(
      documentWith([
        {
          id: "p-notes",
          widget: "notebook",
          config: {},
          layout: { span: 2, rows: 2 },
          addedBy: "user",
          pinned: true,
        },
      ]),
    );
    const result = await run("dashboard_read");
    expect(result.exists).toBe(true);
    expect((result.summary as string[])[0]).toContain("p-notes [notebook]");
    expect((result.summary as string[])[0]).toContain("pinned");
  });

  it("falls back to the default for an unreadable file and leaves it alone", async () => {
    fs.writeFileSync(dashPath, "{ not json", "utf-8");
    const result = await run("dashboard_read");
    expect(result.success).toBe(true);
    expect(result.exists).toBe(true);
    expect((result.problems as unknown[]).length).toBeGreaterThan(0);
    expect(fs.readFileSync(dashPath, "utf-8")).toBe("{ not json");
  });

  it("refuses when there is no analysis directory", async () => {
    setNotebookPath(null);
    const result = await run("dashboard_read");
    expect(result.success).toBe(false);
    expect(result.error).toContain("no notebook");
  });

  it("summarizes rather than pasting a huge layout into the model's context", async () => {
    seed(
      documentWith([
        {
          id: "p-fat",
          widget: "notebook",
          config: { blob: "x".repeat(30_000) },
          layout: { span: 2, rows: 3 },
          addedBy: "preset",
        },
      ]),
    );
    const result = await run("dashboard_read");
    expect(result.success).toBe(true);
    expect(result.document).toBeUndefined();
    expect(result.documentOmitted).toContain("too large");
    // The panel ids a write needs are still there.
    expect((result.summary as string[])[0]).toContain("p-fat");
  });

  it("caps the summary too, not just the document it stands in for", async () => {
    // Omitting the document bounds nothing on its own: the summary is built
    // from ids the agent writes into the file and nothing caps their length,
    // so a layout well under the store's byte cap used to come back as a
    // ~170,000-character tool result made almost entirely of summary.
    seed({
      version: 1,
      activeId: "d0",
      dashboards: Array.from({ length: 10 }, (_, d) => ({
        id: `d${d}`,
        title: `Dashboard ${d}`,
        panels: Array.from({ length: 40 }, (_, i) => ({
          id: `p-${d}-${i}-${"y".repeat(200)}`,
          widget: "notebook" as const,
          config: {},
          layout: { span: 2 as const, rows: 3 as const },
          addedBy: "preset" as const,
        })),
      })),
    });
    const tool = tools().get("dashboard_read");
    const raw = (await tool!.execute("call-1", {}, new AbortController().signal, vi.fn(), {}))
      .content[0].text;
    const result = JSON.parse(raw) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(raw.length).toBeLessThan(MAX_READ_CHARS);
    // Still useful, and this is the part that matters: EVERY dashboard is
    // named, each losing its own tail. Spending one budget head-first instead
    // let the first crowded dashboard eat all of it and collapsed the rest into
    // "9 more not shown" -- and since the document was omitted too, the
    // response was telling the model to work from a summary that no longer
    // mentioned seven of its dashboards, through a tool that takes no argument
    // to ask again with.
    const summary = result.summary as string[];
    expect(summary).toHaveLength(10);
    for (let d = 0; d < 10; d++) expect(summary[d]).toContain(`p-${d}-0-`);
  });

  it("spends one budget across all the problems, not one per problem", () => {
    // Twenty problems at a thousand characters each is the cap over again.
    // Every panel below is malformed in a way the validator reports, and every
    // one of those reports quotes a long id back.
    fs.writeFileSync(
      dashPath,
      JSON.stringify({
        version: 1,
        activeId: "current-analysis",
        dashboards: [
          {
            id: "current-analysis",
            title: "Current analysis",
            panels: Array.from({ length: 30 }, (_, i) => ({
              id: `p-${"q".repeat(300)}-${i}`,
              widget: "no-such-widget",
              config: {},
              layout: { span: 2, rows: 3 },
            })),
          },
        ],
      }),
      "utf-8",
    );
    return run("dashboard_read").then((result) => {
      const problems = result.problems as { path: string; message: string }[];
      const spent = problems.reduce((n, p) => n + p.path.length + p.message.length, 0);
      // The trailing "N more" line rides on top of the budget, so allow for it.
      expect(spent).toBeLessThan(2_500);
      expect(problems.at(-1)?.message).toContain("more problem(s)");
    });
  });

  it("omits a document that fits only before it is indented", () => {
    // The cap has to be measured the way the response is written. The payload
    // is serialized with two-space indentation, which roughly doubles it, so
    // comparing the compact form let a document land in front of the model at
    // about twice the advertised limit. This one is under the cap compact and
    // over it indented -- which is the whole range the old measure got wrong.
    // Structure rather than long values, because indentation is what inflates:
    // three full dashboards are 11,669 characters compact and 25,848 indented.
    const doc = {
      version: 1,
      activeId: "d0",
      dashboards: Array.from({ length: 3 }, (_, d) => ({
        id: `d${d}`,
        title: `Dashboard ${d}`,
        panels: Array.from({ length: 40 }, (_, i) => ({
          id: `p-${d}-${i}`,
          widget: "notebook" as const,
          config: {},
          layout: { span: 2 as const, rows: 3 as const },
          addedBy: "preset" as const,
        })),
      })),
    };
    expect(JSON.stringify(doc).length).toBeLessThan(MAX_READ_CHARS);
    expect(JSON.stringify(doc, null, 2).length).toBeGreaterThan(MAX_READ_CHARS);

    seed(doc);
    return run("dashboard_read").then((result) => {
      expect(result.document).toBeUndefined();
      expect(result.documentOmitted).toContain("too large");
    });
  });

  it("emits a document that only just fits, and stays under the cap doing it", () => {
    // The cap is measured against the indented form because that is the form
    // the response is written in -- comparing the compact one let a document
    // that just squeaked under arrive at roughly twice the advertised size.
    const doc = documentWith(
      Array.from({ length: 12 }, (_, i) => ({
        id: `p-${i}`,
        widget: "notebook" as const,
        config: { note: "n".repeat(60) },
        layout: { span: 2 as const, rows: 3 as const },
        addedBy: "preset" as const,
      })),
    );
    const indented = JSON.stringify(doc, null, 2).length;
    expect(indented).toBeLessThan(MAX_READ_CHARS);
    expect(JSON.stringify(doc).length).toBeLessThan(indented);

    seed(doc);
    return run("dashboard_read").then((result) => {
      // Small enough to be shown in full, and the whole response still fits.
      expect(result.document).toBeDefined();
      expect(result.documentOmitted).toBeUndefined();
      expect(JSON.stringify(result).length).toBeLessThan(MAX_READ_CHARS * 2);
    });
  });

  it("does not quote a 240,000-character activeId back in the diagnostics", async () => {
    fs.writeFileSync(
      dashPath,
      JSON.stringify({
        version: 1,
        activeId: "z".repeat(240_000),
        dashboards: [{ id: "current-analysis", title: "Current analysis", panels: [] }],
      }),
      "utf-8",
    );
    const tool = tools().get("dashboard_read");
    const raw = (await tool!.execute("call-1", {}, new AbortController().signal, vi.fn(), {}))
      .content[0].text;

    expect(raw.length).toBeLessThan(MAX_READ_CHARS);
    expect((JSON.parse(raw) as { problems: { message: string }[] }).problems[0].message).toContain(
      "more characters",
    );
  });
});

describe("dashboard_update -- the happy paths", () => {
  it("adds a panel, stamps it as the agent's, and records why", async () => {
    const result = await run("dashboard_update", {
      reason: "you asked to watch the alignment run",
      actions: [{ action: "add_panel", widget: "jobs", span: 1, rows: 2 }],
    });
    expect(result.success).toBe(true);

    const panels = onDisk().dashboards[0].panels;
    const added = panels.find((p) => p.widget === "jobs" && p.addedBy === "agent");
    expect(added).toBeTruthy();
    expect(added!.reason).toBe("you asked to watch the alignment run");
    // The preset already ships a p-jobs, and the new panel must not land on it.
    expect(added!.id).not.toBe("p-jobs");
    expect(new Set(panels.map((p) => p.id)).size).toBe(panels.length);
  });

  it("honours position, so 'next to the plan' means next to the plan", async () => {
    seed(
      documentWith([{ id: "p-plan", widget: "plan", config: {}, layout: { span: 1, rows: 2 } }]),
    );
    await run("dashboard_update", {
      reason: "beside the plan, as asked",
      actions: [{ action: "add_panel", widget: "jobs", position: 0 }],
    });
    expect(onDisk().dashboards[0].panels.map((p) => p.widget)).toEqual(["jobs", "plan"]);
  });

  it("merges a config change rather than replacing the config", async () => {
    seed(
      documentWith([
        {
          id: "p-notebook",
          widget: "notebook",
          config: { follow: true, density: "compact" },
          layout: { span: 2, rows: 3 },
          addedBy: "preset",
        },
      ]),
    );
    await run("dashboard_update", {
      reason: "you asked it to stop scrolling",
      actions: [{ action: "update_panel", panelId: "p-notebook", config: '{"follow":false}' }],
    });
    expect(onDisk().dashboards[0].panels[0].config).toEqual({
      follow: false,
      density: "compact",
    });
  });

  it("creates a dashboard from a preset and switches to it", async () => {
    const result = await run("dashboard_update", {
      reason: "you asked for a monitoring view",
      actions: [
        { action: "create_dashboard", preset: "monitoring", title: "Long run" },
        { action: "switch_dashboard", dashboardId: "monitoring" },
      ],
    });
    expect(result.success).toBe(true);
    const document = onDisk();
    expect(document.activeId).toBe("monitoring");
    expect(document.dashboards.map((d) => d.id)).toEqual(["current-analysis", "monitoring"]);
    // A dashboard the agent built is the agent's, preset panels and all, so it
    // can tidy it away later. One the user installs with /dashboard preset
    // keeps "preset", because that path does not go through the guard.
    const panels = document.dashboards.find((d) => d.id === "monitoring")!.panels;
    expect(panels.every((p) => p.addedBy === "agent")).toBe(true);
    expect(panels.every((p) => p.reason === "you asked for a monitoring view")).toBe(true);
  });

  it("replaces the whole layout when handed a document", async () => {
    const replacement = documentWith([
      { id: "p-jobs", widget: "jobs", config: {}, layout: { span: 2, rows: 2 } },
    ]);
    const result = await run("dashboard_update", {
      reason: "you asked for just the jobs",
      document: JSON.stringify(replacement),
    });
    expect(result.success).toBe(true);
    expect(onDisk().dashboards[0].panels.map((p) => p.widget)).toEqual(["jobs"]);
  });

  it("removes and moves panels it put there itself", async () => {
    seed(
      documentWith([
        { id: "p-a", widget: "jobs", config: {}, layout: { span: 1, rows: 2 }, addedBy: "agent" },
        { id: "p-b", widget: "plan", config: {}, layout: { span: 1, rows: 2 }, addedBy: "preset" },
        {
          id: "p-c",
          widget: "activity",
          config: {},
          layout: { span: 1, rows: 2 },
          addedBy: "agent",
        },
      ]),
    );
    const result = await run("dashboard_update", {
      reason: "you asked to tidy it up",
      actions: [
        { action: "remove_panel", panelId: "p-c" },
        { action: "move_panel", panelId: "p-a", position: 1 },
      ],
    });
    expect(result.success).toBe(true);
    expect(onDisk().dashboards[0].panels.map((p) => p.id)).toEqual(["p-b", "p-a"]);
  });
});

describe("dashboard_update -- what it refuses", () => {
  it("needs a reason", async () => {
    const result = await run("dashboard_update", {
      reason: "  ",
      actions: [{ action: "add_panel", widget: "jobs" }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("reason is required");
    expect(fs.existsSync(dashPath)).toBe(false);
  });

  it("refuses both actions and document at once, and neither", async () => {
    const both = await run("dashboard_update", {
      reason: "why",
      actions: [{ action: "add_panel", widget: "jobs" }],
      document: "{}",
    });
    expect(both.error).toContain("not both");
    const neither = await run("dashboard_update", { reason: "why" });
    expect(neither.error).toContain("pass actions or document");
    expect(fs.existsSync(dashPath)).toBe(false);
  });

  it("hands back the validator's problems when the document will not parse", async () => {
    const result = await run("dashboard_update", { reason: "why", document: "{ not json" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not valid JSON");
    expect(fs.existsSync(dashPath)).toBe(false);
  });

  it("refuses a document from a newer schema rather than downgrading it", async () => {
    const result = await run("dashboard_update", {
      reason: "why",
      document: JSON.stringify({ version: 99, activeId: "x", dashboards: [] }),
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("newer than this build");
  });

  it("refuses a widget type this build cannot draw, and says what it can", async () => {
    const result = await run("dashboard_update", {
      reason: "why",
      actions: [{ action: "add_panel", widget: "volcano-plot" }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("volcano-plot");
    expect(result.error).toContain("jobs");
    expect(fs.existsSync(dashPath)).toBe(false);
  });

  it("refuses the sandboxed HTML widget while its flag is off", async () => {
    const result = await run("dashboard_update", {
      reason: "why",
      actions: [{ action: "add_panel", widget: "html-sandbox", config: '{"html":"<b>hi</b>"}' }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("feature flag");
    expect(fs.existsSync(dashPath)).toBe(false);
  });

  it("refuses a widget type smuggled in through the whole-document path", async () => {
    const result = await run("dashboard_update", {
      reason: "why",
      document: JSON.stringify(
        documentWith([
          { id: "p-x", widget: "html-sandbox", config: {}, layout: { span: 1, rows: 2 } },
        ]),
      ),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("feature flag");
  });

  it("names the unknown panel rather than guessing", async () => {
    const result = await run("dashboard_update", {
      reason: "why",
      actions: [{ action: "remove_panel", panelId: "p-nope" }],
    });
    expect(result.error).toContain("p-nope");
    expect(result.error).toContain("dashboard_read");
  });

  it("rejects a layout larger than the file cap without writing anything", async () => {
    const big = documentWith([
      {
        id: "p-notebook",
        widget: "notebook",
        config: { blob: "x".repeat(DASHBOARD_MAX_BYTES + 1024) },
        layout: { span: 2, rows: 3 },
      },
    ]);
    const result = await run("dashboard_update", {
      reason: "why",
      document: JSON.stringify(big),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("larger than");
    expect(fs.existsSync(dashPath)).toBe(false);
  });
});

describe("provenance -- the panels that are not the agent's", () => {
  const userPanel = {
    id: "p-mine",
    widget: "notebook" as const,
    config: {},
    layout: { span: 1 as const, rows: 2 },
    addedBy: "user" as const,
  };
  const pinnedPanel = {
    id: "p-pinned",
    widget: "plan" as const,
    config: {},
    layout: { span: 1 as const, rows: 2 },
    addedBy: "preset" as const,
    pinned: true,
  };

  it("counts an unlabelled panel as the user's", () => {
    expect(
      isProtectedPanel({ id: "p", widget: "jobs", config: {}, layout: { span: 1, rows: 2 } }),
    ).toBe(true);
    expect(isProtectedPanel({ ...userPanel })).toBe(true);
    expect(isProtectedPanel({ ...pinnedPanel })).toBe(true);
    expect(isProtectedPanel({ ...userPanel, addedBy: "agent", pinned: false })).toBe(false);
    expect(isProtectedPanel({ ...userPanel, addedBy: "preset", pinned: false })).toBe(false);
  });

  it("will not remove a panel the user placed", async () => {
    seed(documentWith([userPanel]));
    const before = fs.readFileSync(dashPath, "utf-8");
    const result = await run("dashboard_update", {
      reason: "tidying",
      actions: [{ action: "remove_panel", panelId: "p-mine" }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("placed by the user");
    expect(result.error).toContain("dashboard's own controls");
    expect(fs.readFileSync(dashPath, "utf-8")).toBe(before);
  });

  it("will not resize or retitle a pinned panel", async () => {
    seed(documentWith([pinnedPanel]));
    const result = await run("dashboard_update", {
      reason: "making room",
      actions: [{ action: "update_panel", panelId: "p-pinned", rows: 5 }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("is pinned");
  });

  it("will not reorder the user's panels past each other", async () => {
    seed(documentWith([userPanel, { ...pinnedPanel, pinned: true }]));
    const result = await run("dashboard_update", {
      reason: "reshuffling",
      actions: [{ action: "move_panel", panelId: "p-mine", position: 1 }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("reordering");
  });

  it("will not drop a user panel through a whole-document replace either", async () => {
    seed(documentWith([userPanel]));
    const result = await run("dashboard_update", {
      reason: "rebuilding",
      document: JSON.stringify(
        documentWith([{ id: "p-jobs", widget: "jobs", config: {}, layout: { span: 1, rows: 2 } }]),
      ),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot be removed");
  });

  it("will not delete a dashboard that holds one", async () => {
    seed(documentWith([userPanel]));
    const result = await run("dashboard_update", {
      reason: "starting over",
      document: JSON.stringify({
        version: 1,
        activeId: "fresh",
        dashboards: [{ id: "fresh", title: "Fresh", panels: [] }],
      }),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot be removed");
  });

  it("still lets the agent add a panel beside them", async () => {
    seed(documentWith([userPanel]));
    const result = await run("dashboard_update", {
      reason: "you asked to see the jobs too",
      actions: [{ action: "add_panel", widget: "jobs" }],
    });
    expect(result.success).toBe(true);
    expect(onDisk().dashboards[0].panels.map((p) => p.id)).toEqual(["p-mine", "p-jobs"]);
  });

  it("sees no violation when nothing protected moved", () => {
    const before = documentWith([userPanel]);
    const after = documentWith([
      userPanel,
      { id: "p-jobs", widget: "jobs", config: {}, layout: { span: 1, rows: 2 }, addedBy: "agent" },
    ]);
    expect(provenanceViolations(before, after)).toEqual([]);
    expect(introducedWidgetTypes(before, after)).toEqual(["jobs"]);
  });
});

describe("the persisted path", () => {
  it("is the fixed filename beside the notebook", () => {
    expect(getDashboardPath()).toBe(path.join(tmpDir, DASHBOARD_FILENAME));
  });

  it("moves with the notebook and never outside its directory", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dashboard-other-"));
    try {
      setNotebookPath(path.join(other, "notebook.md"));
      expect(getDashboardPath()).toBe(path.join(other, DASHBOARD_FILENAME));
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("refuses to write through a symlink planted at that name", async () => {
    const outside = path.join(tmpDir, "secret.json");
    fs.writeFileSync(outside, "untouched", "utf-8");
    fs.symlinkSync(outside, dashPath);

    const result = await run("dashboard_update", {
      reason: "why",
      actions: [{ action: "add_panel", widget: "jobs" }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("symbolic link");
    expect(fs.readFileSync(outside, "utf-8")).toBe("untouched");
  });

  it("refuses to read through one too", async () => {
    fs.writeFileSync(path.join(tmpDir, "secret.json"), "untouched", "utf-8");
    fs.symlinkSync(path.join(tmpDir, "secret.json"), dashPath);
    const result = await run("dashboard_read");
    expect(result.success).toBe(false);
    expect(result.error).toContain("symbolic link");
  });

  // Mode 000 only sets the read-only bit on Windows: the read succeeds there and
  // it is the write that fails, which is a different refusal.
  it.skipIf(process.platform === "win32")(
    "refuses rather than replacing a layout it could not read",
    async () => {
      fs.writeFileSync(dashPath, '{"version":1,"activeId":"d","dashboards":[]}', "utf-8");
      fs.chmodSync(dashPath, 0o000);
      try {
        const result = await run("dashboard_update", {
          reason: "why",
          actions: [{ action: "add_panel", widget: "jobs" }],
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain("Could not read");
        fs.chmodSync(dashPath, 0o600);
        // The file we could not read is still the file that is there.
        expect(fs.readFileSync(dashPath, "utf-8")).toBe(
          '{"version":1,"activeId":"d","dashboards":[]}',
        );
      } finally {
        fs.chmodSync(dashPath, 0o600);
      }
    },
  );

  it("leaves no scratch files behind", async () => {
    await run("dashboard_update", {
      reason: "why",
      actions: [{ action: "add_panel", widget: "jobs" }],
    });
    expect(fs.readdirSync(tmpDir).filter((f) => f.includes(".tmp."))).toEqual([]);
  });

  it("notes the change in the activity log", async () => {
    await run("dashboard_update", {
      reason: "you asked to watch the run",
      actions: [{ action: "add_panel", widget: "jobs" }],
    });
    const lines = fs
      .readFileSync(path.join(tmpDir, "activity.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; source: string });
    expect(
      lines.some((e) => e.kind === "dashboard.changed" && e.source === "dashboard_update"),
    ).toBe(true);
  });

  it("retries against the file when someone else writes in the middle", async () => {
    seed(createDefaultDashboardDocument());
    let interfered = false;
    const attempts: number[] = [];

    const written = await updateDashboardDocument((current) => {
      attempts.push(current.dashboards[0].panels.length);
      if (!interfered) {
        interfered = true;
        // Another writer lands between our read and our rename.
        fs.writeFileSync(
          dashPath,
          serializeDashboardDocument(
            documentWith([
              {
                id: "p-theirs",
                widget: "plan",
                config: {},
                layout: { span: 1, rows: 2 },
                addedBy: "user",
              },
            ]),
          ),
          "utf-8",
        );
      }
      return { ok: true, document: current };
    });

    expect(written.ok).toBe(true);
    expect(attempts.length).toBe(2);
    // The second attempt saw the other writer's document, not the first read.
    expect(onDisk().dashboards[0].panels.map((p) => p.id)).toEqual(["p-theirs"]);
  });
});

describe("shells", () => {
  it("says the pane will pick it up when a shell is attached", async () => {
    process.env.LOOM_SHELL_KIND = "orbit";
    const result = await run("dashboard_update", {
      reason: "why",
      actions: [{ action: "add_panel", widget: "jobs" }],
    });
    expect(result.where).toContain("Dashboard tab");
  });

  it("writes the file and says there is no pane in the terminal", async () => {
    delete process.env.LOOM_SHELL_KIND;
    const result = await run("dashboard_update", {
      reason: "why",
      actions: [{ action: "add_panel", widget: "jobs" }],
    });
    expect(result.success).toBe(true);
    expect(result.where).toContain("no dashboard pane in the terminal");
    expect(fs.existsSync(dashPath)).toBe(true);
  });
});

describe("applyDashboardActions on its own", () => {
  it("caps how much one call may do", () => {
    const actions = Array.from({ length: 21 }, () => ({ action: "add_panel", widget: "jobs" }));
    const result = applyDashboardActions(createDefaultDashboardDocument(), actions, "why");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("at most 20");
  });

  it("refuses an action it does not know", () => {
    const result = applyDashboardActions(
      createDefaultDashboardDocument(),
      [{ action: "delete_everything" }],
      "why",
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("unknown action");
  });

  it("does not mutate the document it was handed", () => {
    const document = createDefaultDashboardDocument();
    const before = JSON.stringify(document);
    applyDashboardActions(document, [{ action: "add_panel", widget: "jobs" }], "why");
    expect(JSON.stringify(document)).toBe(before);
  });
});

describe("provenance is the host's to assign", () => {
  it("will not let a whole-document replace stamp a panel as the user's", async () => {
    const result = await run("dashboard_update", {
      reason: "you asked for a jobs panel",
      document: JSON.stringify(
        documentWith([
          {
            id: "p-smuggled",
            widget: "jobs",
            config: {},
            layout: { span: 1, rows: 2 },
            addedBy: "user",
            pinned: true,
            reason: "the user definitely wanted this",
          },
        ]),
      ),
    });
    expect(result.success).toBe(true);
    const panel = onDisk().dashboards[0].panels[0];
    expect(panel.addedBy).toBe("agent");
    expect(panel.pinned).toBeUndefined();
    expect(panel.reason).toBe("you asked for a jobs panel");
  });

  it("keeps the provenance a panel already had through a replace", async () => {
    seed(
      documentWith([
        {
          id: "p-mine",
          widget: "notebook",
          config: {},
          layout: { span: 1, rows: 2 },
          addedBy: "user",
          pinned: true,
          reason: "I keep my own notes here",
        },
      ]),
    );
    const result = await run("dashboard_update", {
      reason: "you asked to add the jobs panel",
      document: JSON.stringify(
        documentWith([
          {
            id: "p-mine",
            widget: "notebook",
            config: {},
            layout: { span: 1, rows: 2 },
            addedBy: "agent",
          },
          { id: "p-jobs", widget: "jobs", config: {}, layout: { span: 1, rows: 2 } },
        ]),
      ),
    });
    expect(result.success).toBe(true);
    const [mine, jobs] = onDisk().dashboards[0].panels;
    expect(mine.addedBy).toBe("user");
    expect(mine.pinned).toBe(true);
    expect(mine.reason).toBe("I keep my own notes here");
    expect(jobs.addedBy).toBe("agent");
  });

  it("will not rewrite the reason on a panel the user pinned", async () => {
    seed(
      documentWith([
        {
          id: "p-mine",
          widget: "notebook",
          config: {},
          layout: { span: 1, rows: 2 },
          addedBy: "user",
          pinned: true,
          reason: "I keep my own notes here",
        },
      ]),
    );
    await run("dashboard_update", {
      reason: "the agent's own reason",
      actions: [{ action: "update_panel", panelId: "p-mine", rows: 3 }],
    });
    expect(onDisk().dashboards[0].panels[0].reason).toBe("I keep my own notes here");
    expect(onDisk().dashboards[0].panels[0].layout.rows).toBe(2);
  });

  it("stamps a panel whose widget type changed as the agent's", () => {
    const before = documentWith([
      { id: "p-x", widget: "jobs", config: {}, layout: { span: 1, rows: 2 }, addedBy: "preset" },
    ]);
    const after = reassertProvenance(
      before,
      documentWith([
        { id: "p-x", widget: "plan", config: {}, layout: { span: 1, rows: 2 }, addedBy: "preset" },
      ]),
      "you asked for the plan instead",
    );
    expect(after.dashboards[0].panels[0].addedBy).toBe("agent");
    expect(after.dashboards[0].panels[0].reason).toBe("you asked for the plan instead");
  });
});

describe("which dashboard an action lands on", () => {
  const jobs = (rows: number) => ({
    id: "p-jobs",
    widget: "jobs",
    config: {},
    layout: { span: 1 as const, rows },
    addedBy: "preset" as const,
  });

  it("resolves an unqualified panel id against the dashboard on screen", async () => {
    // The shipped presets reuse "p-jobs" and "p-notebook" across dashboards on
    // purpose, so first-match-wins edits one the user is not looking at.
    seed({
      version: 1,
      activeId: "second",
      dashboards: [
        { id: "first", title: "First", panels: [jobs(2)] },
        { id: "second", title: "Second", panels: [jobs(2)] },
      ],
    });
    await run("dashboard_update", {
      reason: "you asked for a taller jobs panel",
      actions: [{ action: "update_panel", panelId: "p-jobs", rows: 6 }],
    });
    const after = onDisk();
    expect(after.dashboards.find((d) => d.id === "second")!.panels[0].layout.rows).toBe(6);
    expect(after.dashboards.find((d) => d.id === "first")!.panels[0].layout.rows).toBe(2);
  });

  it("still honours an explicit dashboardId", async () => {
    seed({
      version: 1,
      activeId: "second",
      dashboards: [
        { id: "first", title: "First", panels: [jobs(2)] },
        { id: "second", title: "Second", panels: [jobs(2)] },
      ],
    });
    await run("dashboard_update", {
      reason: "you asked to change the other one",
      actions: [{ action: "update_panel", panelId: "p-jobs", dashboardId: "first", rows: 5 }],
    });
    expect(onDisk().dashboards.find((d) => d.id === "first")!.panels[0].layout.rows).toBe(5);
  });
});

describe("what the model is told", () => {
  it("reports what the validator repaired in a document it was handed", async () => {
    const result = await run("dashboard_update", {
      reason: "you asked for a rebuild",
      document: JSON.stringify({
        version: 1,
        activeId: "d",
        dashboards: [
          {
            id: "d",
            title: "D",
            panels: [
              { id: "p-jobs", widget: "jobs", config: {}, layout: { span: 1, rows: 2 } },
              { id: "p-bad", config: {} },
            ],
          },
        ],
      }),
    });
    expect(result.success).toBe(true);
    const repairs = JSON.stringify(result.repairs);
    expect(repairs).toContain("dashboards[0].panels[1].widget");
    expect(repairs).toContain("missing a widget type");
    // The dropped panel really is gone -- the repair is not cosmetic.
    expect(onDisk().dashboards[0].panels.map((p) => p.id)).toEqual(["p-jobs"]);
  });

  it("refuses an update_panel that would change nothing", async () => {
    seed(
      documentWith([
        {
          id: "p-jobs",
          widget: "jobs",
          config: {},
          layout: { span: 1, rows: 2 },
          addedBy: "agent",
        },
      ]),
    );
    const before = fs.readFileSync(dashPath, "utf-8");
    const result = await run("dashboard_update", {
      reason: "why",
      actions: [{ action: "update_panel", panelId: "p-jobs" }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("something to change");
    expect(fs.readFileSync(dashPath, "utf-8")).toBe(before);
  });
});

describe("the caps the validator enforces by truncating", () => {
  const filler = (id: string) => ({
    id,
    widget: "jobs" as const,
    config: {},
    layout: { span: 1 as const, rows: 2 },
    addedBy: "agent" as const,
  });

  it("refuses to add to a full dashboard rather than pushing a panel off the end", async () => {
    // The validator keeps the FIRST 40, so an insert at the top is what
    // destroys something -- and it used to come back as a successful add.
    seed(documentWith(Array.from({ length: 40 }, (_, i) => filler(`p-a${i}`))));
    const before = fs.readFileSync(dashPath, "utf-8");
    const result = await run("dashboard_update", {
      reason: "you asked for the plan too",
      actions: [{ action: "add_panel", widget: "plan", position: 0 }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("full");
    expect(fs.readFileSync(dashPath, "utf-8")).toBe(before);
  });

  it("refuses to announce a dashboard the cap would drop", async () => {
    seed({
      version: 1,
      activeId: "d0",
      dashboards: Array.from({ length: 20 }, (_, i) => ({
        id: `d${i}`,
        title: `D${i}`,
        panels: [],
      })),
    });
    const result = await run("dashboard_update", {
      reason: "you asked for a monitoring view",
      actions: [{ action: "create_dashboard", preset: "monitoring", title: "Long run" }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("dashboards");
    expect(onDisk().dashboards.some((d) => d.id === "monitoring")).toBe(false);
  });
});

describe("input the schema promised but the model did not send", () => {
  it("refuses rather than throwing, whatever arrives", async () => {
    const offSchema: Record<string, unknown>[] = [
      { reason: 42, actions: [{ action: "add_panel", widget: "jobs" }] },
      { reason: "r", actions: "boom" },
      { reason: "r", document: 42 },
      { reason: "r", actions: [null] },
      { reason: "r", actions: [{ action: 7 }] },
    ];
    for (const params of offSchema) {
      const result = await run("dashboard_update", params);
      expect(result.success, JSON.stringify(params)).toBe(false);
      expect(typeof result.error).toBe("string");
    }
    expect(fs.existsSync(dashPath)).toBe(false);
  });

  it("takes a null title as 'clear it' rather than crashing", async () => {
    seed(
      documentWith([
        {
          id: "p-jobs",
          widget: "jobs",
          title: "Old title",
          config: {},
          layout: { span: 1, rows: 2 },
          addedBy: "agent",
        },
      ]),
    );
    const result = await run("dashboard_update", {
      reason: "you asked to make it taller",
      actions: [{ action: "update_panel", panelId: "p-jobs", title: null, rows: 4 }],
    });
    expect(result.success).toBe(true);
    expect(onDisk().dashboards[0].panels[0].layout.rows).toBe(4);
  });

  it("accepts a config sent as an object instead of JSON text", async () => {
    // The schema asks for text because a free-form object is not portable
    // across providers, but a model that sends the object is not wrong.
    const result = await run("dashboard_update", {
      reason: "you asked it to stop scrolling",
      actions: [{ action: "add_panel", widget: "notebook", config: { follow: false } }],
    });
    expect(result.success).toBe(true);
    const added = onDisk().dashboards[0].panels.find((p) => p.addedBy === "agent");
    expect(added!.config).toEqual({ follow: false });
  });
});

describe("panels the user pinned keep their place", () => {
  const pinned = {
    id: "p-pinned",
    widget: "notebook" as const,
    config: {},
    layout: { span: 2 as const, rows: 3 },
    addedBy: "user" as const,
    pinned: true,
  };

  it("will not insert above one, however the model numbers the position", async () => {
    seed(documentWith([pinned]));
    const result = await run("dashboard_update", {
      reason: "you asked to watch the run",
      actions: [{ action: "add_panel", widget: "jobs", position: 0 }],
    });
    expect(result.success).toBe(true);
    expect(onDisk().dashboards[0].panels.map((p) => p.id)).toEqual(["p-pinned", "p-jobs"]);
  });

  it("will not move one of its own above one either", async () => {
    seed(
      documentWith([
        pinned,
        {
          id: "p-jobs",
          widget: "jobs",
          config: {},
          layout: { span: 1, rows: 2 },
          addedBy: "agent",
        },
      ]),
    );
    await run("dashboard_update", {
      reason: "you asked for the jobs on top",
      actions: [{ action: "move_panel", panelId: "p-jobs", position: 0 }],
    });
    expect(onDisk().dashboards[0].panels.map((p) => p.id)).toEqual(["p-pinned", "p-jobs"]);
  });

  it("will not move the pinned panel itself, however far", async () => {
    // The pin held the panel's content and not its place: with one pinned
    // panel and three agent panels, the protected-subsequence check saw the
    // same one-element sequence however far the pinned panel travelled, so
    // move_panel pushed it from the top to the bottom and reported success.
    seed(
      documentWith([
        pinned,
        { id: "x0", widget: "jobs", config: {}, layout: { span: 1, rows: 2 }, addedBy: "agent" },
        { id: "x1", widget: "plan", config: {}, layout: { span: 1, rows: 2 }, addedBy: "agent" },
        { id: "x2", widget: "results", config: {}, layout: { span: 1, rows: 2 }, addedBy: "agent" },
      ]),
    );
    const result = await run("dashboard_update", {
      reason: "tidying up",
      actions: [{ action: "move_panel", panelId: "p-pinned", position: 3 }],
    });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/pinned/);
    expect(onDisk().dashboards[0].panels.map((p) => p.id)).toEqual(["p-pinned", "x0", "x1", "x2"]);
  });

  it("will not push a pinned panel down by moving another panel above it", async () => {
    seed(
      documentWith([
        pinned,
        { id: "x0", widget: "jobs", config: {}, layout: { span: 1, rows: 2 }, addedBy: "agent" },
      ]),
    );
    await run("dashboard_update", {
      reason: "jobs on top",
      actions: [{ action: "move_panel", panelId: "x0", position: 0 }],
    });
    // The existing pinned floor clamps the destination rather than refusing the
    // call, so this reports success having changed nothing. What matters is
    // that the pinned panel kept its place.
    expect(onDisk().dashboards[0].panels.map((p) => p.id)).toEqual(["p-pinned", "x0"]);
  });

  it("still lets the agent reorder above a panel the user merely placed", async () => {
    seed(
      documentWith([
        { ...pinned, id: "p-theirs", pinned: false },
        {
          id: "p-jobs",
          widget: "jobs",
          config: {},
          layout: { span: 1, rows: 2 },
          addedBy: "agent",
        },
      ]),
    );
    const result = await run("dashboard_update", {
      reason: "you asked for the jobs on top",
      actions: [{ action: "move_panel", panelId: "p-jobs", position: 0 }],
    });
    // Reordering a protected panel past another is refused; there is only one
    // here, so displacing it is allowed -- placing is not pinning.
    expect(result.success).toBe(true);
    expect(onDisk().dashboards[0].panels.map((p) => p.id)).toEqual(["p-jobs", "p-theirs"]);
  });
});

describe("what a refusal says", () => {
  it("records the reason on a panel the agent is allowed to change", async () => {
    seed(
      documentWith([
        {
          id: "p-jobs",
          widget: "jobs",
          config: {},
          layout: { span: 1, rows: 2 },
          addedBy: "agent",
          reason: "the original reason",
        },
      ]),
    );
    await run("dashboard_update", {
      reason: "you asked to make it taller",
      actions: [{ action: "update_panel", panelId: "p-jobs", rows: 5 }],
    });
    // The tool description promises this; it has to be true.
    expect(onDisk().dashboards[0].panels[0].reason).toBe("you asked to make it taller");
  });

  it("never hands the model a filesystem path or the scratch filename", async () => {
    fs.mkdirSync(dashPath); // a directory where the file should be: rename will fail
    const result = await run("dashboard_update", {
      reason: "why",
      actions: [{ action: "add_panel", widget: "jobs" }],
    });
    expect(result.success).toBe(false);
    expect(String(result.error)).not.toContain(tmpDir);
    expect(String(result.error)).not.toContain(".tmp.");
    expect(String(result.error)).toContain(".loom-dashboard.json");
  });

  it("checks the widget allowlist even for a change the user typed", async () => {
    // `asUser` relaxes provenance, not what this build can draw -- the day a
    // preset carries a flag-gated widget, the slash command must refuse too.
    const outcome = await commitDashboardChange(
      () => ({
        ok: true,
        document: documentWith([
          { id: "p-x", widget: "html-sandbox", config: {}, layout: { span: 1, rows: 2 } },
        ]),
        notes: ["n"],
      }),
      { asUser: true },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain("feature flag");
    expect(fs.existsSync(dashPath)).toBe(false);
  });
});

describe("a whole-document replace that would not fit", () => {
  const panel = (id: string) => ({
    id,
    widget: "plan" as const,
    config: {},
    layout: { span: 1 as const, rows: 2 },
    addedBy: "agent" as const,
  });

  it("refuses rather than dropping the panels past the cap", async () => {
    // The validator enforces the cap by keeping the first N and calling it a
    // repair, so the document arrived already truncated and the guard that
    // exists for this compared it against itself. Prepending one panel to a
    // full dashboard reported success and deleted the last one.
    seed(documentWith(Array.from({ length: 40 }, (_, i) => panel(`a${i}`))));
    const before = onDisk().dashboards[0].panels.map((p) => p.id);

    const result = await run("dashboard_update", {
      reason: "rebuilding",
      document: JSON.stringify({
        version: 1,
        activeId: "current-analysis",
        dashboards: [
          {
            id: "current-analysis",
            title: "Current analysis",
            panels: [panel("new"), ...Array.from({ length: 40 }, (_, i) => panel(`a${i}`))],
          },
        ],
      }),
    });

    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/at most 40 panels/);
    expect(onDisk().dashboards[0].panels.map((p) => p.id)).toEqual(before);
  });

  it("refuses a document with more dashboards than a layout holds", async () => {
    seed(documentWith([panel("a")]));
    const result = await run("dashboard_update", {
      reason: "rebuilding",
      document: JSON.stringify({
        version: 1,
        activeId: "d0",
        dashboards: Array.from({ length: 21 }, (_, i) => ({
          id: `d${i}`,
          title: `D${i}`,
          panels: [panel(`p${i}`)],
        })),
      }),
    });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/at most 20 dashboards/);
    expect(onDisk().dashboards.map((d) => d.id)).toEqual(["current-analysis"]);
  });

  it("still accepts a document that fits, and still reports ordinary repairs", async () => {
    seed(documentWith([panel("a")]));
    const result = await run("dashboard_update", {
      reason: "rebuilding",
      document: JSON.stringify({
        version: 1,
        activeId: "current-analysis",
        dashboards: [
          {
            id: "current-analysis",
            title: "Current analysis",
            panels: [panel("kept"), { id: "p-bad", config: {} }],
          },
        ],
      }),
    });
    expect(result.success).toBe(true);
    expect(JSON.stringify(result.repairs)).toContain("widget");
    expect(onDisk().dashboards[0].panels.map((p) => p.id)).toEqual(["kept"]);
  });
});
