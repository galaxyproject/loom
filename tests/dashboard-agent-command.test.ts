/**
 * `/dashboard` -- the user's own handle on the layout.
 *
 * Deterministic: no model turn, no agent prompt. The interesting part is that
 * it is allowed to do what the tools are not (throw away the user's own
 * panels), because the user is the one typing it -- and that `undo` is real
 * enough to be worth calling undo: it puts back the exact bytes it replaced,
 * and it refuses when the layout has moved on since.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DASHBOARD_FILENAME, serializeDashboardDocument } from "../shared/dashboard-contract.js";
import type { DashboardDocument } from "../shared/dashboard-contract.js";
import { resetState, setNotebookPath } from "../extensions/loom/state";
import { registerDashboardCommands } from "../extensions/loom/dashboard-commands";
import { registerDashboardTools } from "../extensions/loom/dashboard-tools";
import { resetDashboardUndo } from "../extensions/loom/dashboard-store";

type Notify = ReturnType<typeof vi.fn>;

interface CommandDef {
  description: string;
  handler: (args: string | undefined, ctx: { ui: { notify: Notify } }) => Promise<void> | void;
}

let tmpDir: string;
let dashPath: string;
let notify: Notify;

function command(): CommandDef {
  const registered = new Map<string, CommandDef>();
  const api = {
    registerCommand: (name: string, def: CommandDef) => registered.set(name, def),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerDashboardCommands(api as any);
  const def = registered.get("dashboard");
  if (!def) throw new Error("/dashboard not registered");
  return def;
}

async function dash(args?: string): Promise<{ text: string; level: string }> {
  notify = vi.fn();
  await command().handler(args, { ui: { notify } });
  const call = notify.mock.calls.at(-1) ?? ["", ""];
  return { text: String(call[0]), level: String(call[1]) };
}

/** Run the agent's write tool, so undo has something of the agent's to undo. */
async function agentAdds(widget: string, reason: string): Promise<void> {
  const tools: { name: string; execute: (...args: never[]) => Promise<unknown> }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerDashboardTools({ registerTool: (d: never) => tools.push(d) } as any);
  const update = tools.find((t) => t.name === "dashboard_update")!;
  await (
    update.execute as unknown as (id: string, params: Record<string, unknown>) => Promise<unknown>
  )("call-1", { reason, actions: [{ action: "add_panel", widget }] });
}

function onDisk(): DashboardDocument {
  return JSON.parse(fs.readFileSync(dashPath, "utf-8")) as DashboardDocument;
}

function documentWith(panels: DashboardDocument["dashboards"][0]["panels"]): DashboardDocument {
  return {
    version: 1,
    activeId: "current-analysis",
    dashboards: [{ id: "current-analysis", title: "Current analysis", panels }],
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dashboard-command-"));
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

describe("/dashboard", () => {
  it("is registered with its subcommands in the description", () => {
    expect(command().description).toContain("preset");
    expect(command().description).toContain("reset");
    expect(command().description).toContain("undo");
  });

  it("shows the default layout without writing a file", async () => {
    const { text } = await dash();
    expect(text).toContain("No layout file yet");
    expect(text).toContain("current-analysis");
    expect(text).toContain("p-notebook [notebook]");
    expect(fs.existsSync(dashPath)).toBe(false);
  });

  it("marks who placed each panel", async () => {
    fs.writeFileSync(
      dashPath,
      serializeDashboardDocument(
        documentWith([
          {
            id: "p-mine",
            widget: "notebook",
            config: {},
            layout: { span: 1, rows: 2 },
            addedBy: "user",
            pinned: true,
          },
        ]),
      ),
      "utf-8",
    );
    const { text } = await dash();
    expect(text).toContain("p-mine [notebook] (pinned, added by user)");
  });

  it("says so when the file on disk could not be read, and leaves it there", async () => {
    fs.writeFileSync(dashPath, "{ not json", "utf-8");
    const { text } = await dash();
    expect(text).toContain("left alone");
    expect(fs.readFileSync(dashPath, "utf-8")).toBe("{ not json");
  });

  it("applies a preset and switches to it", async () => {
    const { text } = await dash("preset monitoring");
    expect(text).toContain("monitoring preset");
    expect(onDisk().activeId).toBe("monitoring");
    const installed = onDisk().dashboards.find((d) => d.id === "monitoring");
    expect(installed).toBeTruthy();
    // The user installed it by name, so its panels stay the preset's -- unlike
    // the same preset built by the agent, which becomes the agent's.
    expect(installed!.panels.every((p) => p.addedBy === "preset")).toBe(true);
  });

  it("lists the presets rather than guessing at an unknown one", async () => {
    const { text, level } = await dash("preset nope");
    expect(level).toBe("error");
    expect(text).toContain("current-analysis");
    expect(fs.existsSync(dashPath)).toBe(false);
  });

  it("resets to the default layout, which the tools could not have done", async () => {
    fs.writeFileSync(
      dashPath,
      serializeDashboardDocument(
        documentWith([
          {
            id: "p-mine",
            widget: "jobs",
            config: {},
            layout: { span: 1, rows: 2 },
            addedBy: "user",
          },
        ]),
      ),
      "utf-8",
    );
    const { text } = await dash("reset");
    expect(text).toContain("reset to the default layout");
    // The user is allowed to discard their own panels -- but is told.
    expect(text).toContain("replaced 1 panel(s) you had placed");
    expect(onDisk().dashboards[0].panels.map((p) => p.id)).toEqual([
      "p-plan",
      "p-jobs",
      "p-notebook",
    ]);
  });

  it("refuses a subcommand it does not know", async () => {
    const { text, level } = await dash("explode");
    expect(level).toBe("warning");
    expect(text).toContain("Unknown /dashboard subcommand");
    expect(fs.existsSync(dashPath)).toBe(false);
  });
});

describe("/dashboard undo", () => {
  it("has nothing to undo before anything changed", async () => {
    const { text, level } = await dash("undo");
    expect(level).toBe("warning");
    expect(text).toContain("Nothing to undo");
  });

  it("puts back exactly what an agent change replaced", async () => {
    const original = serializeDashboardDocument(
      documentWith([{ id: "p-plan", widget: "plan", config: {}, layout: { span: 1, rows: 2 } }]),
    );
    fs.writeFileSync(dashPath, original, "utf-8");

    await agentAdds("jobs", "you asked to watch the run");
    expect(onDisk().dashboards[0].panels).toHaveLength(2);

    const { text } = await dash("undo");
    expect(text).toContain("previous dashboard layout is back");
    expect(fs.readFileSync(dashPath, "utf-8")).toBe(original);
  });

  it("removes the file again when the change created it", async () => {
    await agentAdds("jobs", "you asked to watch the run");
    expect(fs.existsSync(dashPath)).toBe(true);
    const { text } = await dash("undo");
    expect(text).toContain("default layout");
    expect(fs.existsSync(dashPath)).toBe(false);
  });

  it("undoes /dashboard reset too", async () => {
    const original = serializeDashboardDocument(
      documentWith([
        {
          id: "p-mine",
          widget: "jobs",
          config: {},
          layout: { span: 1, rows: 2 },
          addedBy: "user",
        },
      ]),
    );
    fs.writeFileSync(dashPath, original, "utf-8");
    await dash("reset");
    await dash("undo");
    expect(fs.readFileSync(dashPath, "utf-8")).toBe(original);
  });

  it("refuses when the layout moved on afterwards", async () => {
    await agentAdds("jobs", "you asked to watch the run");
    // The user rearranges the pane after the agent's change.
    const theirs = serializeDashboardDocument(
      documentWith([
        {
          id: "p-theirs",
          widget: "plan",
          config: {},
          layout: { span: 2, rows: 3 },
          addedBy: "user",
        },
      ]),
    );
    fs.writeFileSync(dashPath, theirs, "utf-8");

    const { text, level } = await dash("undo");
    expect(level).toBe("warning");
    expect(text).toContain("changed since");
    expect(fs.readFileSync(dashPath, "utf-8")).toBe(theirs);
  });

  it("walks back one change at a time", async () => {
    await agentAdds("jobs", "first");
    const afterFirst = fs.readFileSync(dashPath, "utf-8");
    await agentAdds("activity", "second");
    await dash("undo");
    expect(fs.readFileSync(dashPath, "utf-8")).toBe(afterFirst);
    await dash("undo");
    expect(fs.existsSync(dashPath)).toBe(false);
    const { text } = await dash("undo");
    expect(text).toContain("Nothing to undo");
  });
});

describe("/dashboard in the terminal", () => {
  it("says there is no pane rather than promising one", async () => {
    delete process.env.LOOM_SHELL_KIND;
    const { text } = await dash("reset");
    expect(text).toContain("no dashboard pane in the terminal");
    expect(fs.existsSync(dashPath)).toBe(true);
  });

  it("points at the tab when a shell is attached", async () => {
    process.env.LOOM_SHELL_KIND = "orbit";
    const { text } = await dash("reset");
    expect(text).toContain("Dashboard tab");
  });

  it("refuses when there is no analysis directory", async () => {
    setNotebookPath(null);
    const { text } = await dash();
    expect(text).toContain("no notebook");
  });
});

describe("/dashboard reset is the escape hatch, so it must not need the old file", () => {
  function oversize(): void {
    fs.writeFileSync(
      dashPath,
      JSON.stringify({ version: 1, activeId: "d", dashboards: [], pad: "z".repeat(300_000) }),
      "utf-8",
    );
  }

  it("replaces a layout too large for anything else to read", async () => {
    oversize();
    const { text } = await dash();
    expect(text).toContain("larger than");

    const reset = await dash("reset");
    expect(reset.level).toBe("info");
    expect(reset.text).toContain("reset to the default layout");
    expect(onDisk().dashboards[0].panels.map((p) => p.id)).toEqual([
      "p-plan",
      "p-jobs",
      "p-notebook",
    ]);
  });

  it("can still put the oversized one back", async () => {
    oversize();
    const before = fs.readFileSync(dashPath, "utf-8");
    await dash("reset");
    await dash("undo");
    expect(fs.readFileSync(dashPath, "utf-8")).toBe(before);
  });

  it("still refuses a symlink, because the user did not ask for a file of theirs", async () => {
    fs.writeFileSync(path.join(tmpDir, "secret.json"), "untouched", "utf-8");
    fs.symlinkSync(path.join(tmpDir, "secret.json"), dashPath);
    const { text, level } = await dash("reset");
    expect(level).toBe("error");
    expect(text).toContain("symbolic link");
    expect(fs.readFileSync(path.join(tmpDir, "secret.json"), "utf-8")).toBe("untouched");
  });
});

describe("undo after the analysis directory changes", () => {
  it("undoes this analysis's change, not a leftover from the last one", async () => {
    await agentAdds("jobs", "in the first analysis");
    const firstDir = tmpDir;

    const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dashboard-command-2-"));
    try {
      fs.writeFileSync(path.join(secondDir, "notebook.md"), "# notebook\n", "utf-8");
      setNotebookPath(path.join(secondDir, "notebook.md"));
      const secondDash = path.join(secondDir, DASHBOARD_FILENAME);

      await agentAdds("plan", "in the second analysis");
      expect(fs.existsSync(secondDash)).toBe(true);

      // The first undo here must undo THIS analysis, not report a change the
      // user never made in it.
      const { text } = await dash("undo");
      expect(text).toContain("default layout");
      expect(fs.existsSync(secondDash)).toBe(false);

      const again = await dash("undo");
      expect(again.text).toContain("Nothing to undo");
      // And the other analysis was never touched.
      expect(fs.existsSync(path.join(firstDir, DASHBOARD_FILENAME))).toBe(true);
    } finally {
      fs.rmSync(secondDir, { recursive: true, force: true });
    }
  });
});
