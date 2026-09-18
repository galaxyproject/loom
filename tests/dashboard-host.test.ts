// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardHost } from "../app/src/renderer/dashboard/host.js";
import { WidgetRegistry } from "../app/src/renderer/dashboard/registry.js";
import { DashboardSources } from "../app/src/renderer/dashboard/data-sources.js";
import type {
  DashboardEditor,
  DashboardEditorContext,
  WidgetDefinition,
} from "../app/src/renderer/dashboard/widget-api.js";
import {
  createDefaultDashboardDocument,
  type DashboardDocument,
} from "../shared/dashboard-contract.js";

function doc(...widgets: string[]): DashboardDocument {
  return {
    version: 1,
    activeId: "d",
    dashboards: [
      {
        id: "d",
        title: "D",
        panels: widgets.map((widget, i) => ({
          id: `p${i}`,
          widget,
          config: {},
          layout: { span: 1 as const, rows: 2 },
        })),
      },
    ],
  };
}

function stubWidget(type: string, mount: WidgetDefinition["mount"]): WidgetDefinition {
  return { type, label: type, defaultConfig: {}, mount };
}

let root: HTMLElement;
let registry: WidgetRegistry;
let sources: DashboardSources;

beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  root = document.getElementById("root")!;
  registry = new WidgetRegistry();
  sources = new DashboardSources();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

let openFile: ReturnType<typeof vi.fn>;

function makeHost(persist?: (d: DashboardDocument) => void): DashboardHost {
  openFile = vi.fn();
  return new DashboardHost(root, { sources: sources.sources, registry, persist, openFile });
}

describe("rendering", () => {
  it("draws the default document's panels on construction", () => {
    registry.register(stubWidget("notebook", () => {}));
    registry.register(stubWidget("jobs", () => {}));
    registry.register(stubWidget("plan", () => {}));
    makeHost();
    expect(root.querySelectorAll(".dash-panel")).toHaveLength(3);
    expect(
      [...root.querySelectorAll(".dash-panel")].map((p) => (p as HTMLElement).dataset.widget),
    ).toEqual(["plan", "jobs", "notebook"]);
  });

  it("expresses both span and rows as grid spans, not a CSS height", () => {
    registry.register(stubWidget("a", () => {}));
    const host = makeHost();
    const next = doc("a");
    next.dashboards[0].panels[0].layout = { span: 2, rows: 4 };
    host.setDocument(next, { persist: false });
    const panel = root.querySelector(".dash-panel") as HTMLElement;
    expect(panel.style.gridColumn).toBe("span 2");
    expect(panel.style.gridRow).toBe("span 4");
    // Still published for the one-column rule, which caps rather than fixes.
    expect(panel.style.getPropertyValue("--dash-panel-rows")).toBe("4");
    expect(panel.style.height).toBe("");
  });

  it("prefers a panel title over the widget label", () => {
    registry.register(stubWidget("a", () => {}));
    const host = makeHost();
    const next = doc("a");
    next.dashboards[0].panels[0].title = "My panel";
    host.setDocument(next, { persist: false });
    expect(root.querySelector(".dash-panel-title")?.textContent).toBe("My panel");
  });

  it("shows an empty state for a dashboard with no panels", () => {
    const host = makeHost();
    host.setDocument(
      { version: 1, activeId: "d", dashboards: [{ id: "d", title: "D", panels: [] }] },
      { persist: false },
    );
    expect(root.querySelector(".empty-state")).not.toBeNull();
    expect(root.querySelectorAll(".dash-panel")).toHaveLength(0);
  });
});

describe("unknown widget types", () => {
  it("draws a placeholder rather than dropping the panel", () => {
    registry.register(stubWidget("known", () => {}));
    const host = makeHost();
    host.setDocument(doc("known", "from-the-future"), { persist: false });
    expect(root.querySelectorAll(".dash-panel")).toHaveLength(2);
    const unknown = root.querySelector(".dash-card-unknown");
    expect(unknown?.textContent).toContain("from-the-future");
  });

  it("puts the type in the DOM as text, never as markup", () => {
    const host = makeHost();
    host.setDocument(doc("<img src=x onerror=alert(1)>"), { persist: false });
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector(".dash-card-unknown")?.textContent).toContain("<img");
  });
});

describe("failure isolation", () => {
  it("isolates a widget that throws in mount and keeps the others alive", () => {
    let goodMounted = false;
    registry.register(
      stubWidget("bad", () => {
        throw new Error("mount exploded");
      }),
    );
    registry.register(
      stubWidget("good", (el) => {
        goodMounted = true;
        el.textContent = "fine";
      }),
    );
    const host = makeHost();
    host.setDocument(doc("bad", "good"), { persist: false });

    expect(goodMounted).toBe(true);
    const cards = root.querySelectorAll(".dash-card-error");
    expect(cards).toHaveLength(1);
    // Says the panel broke, not the analysis, and keeps the raw message.
    expect(cards[0].textContent).toContain("This panel isn't working");
    expect(cards[0].textContent).toContain("Your analysis is unaffected");
    expect(cards[0].querySelector("details pre")?.textContent).toBe("mount exploded");
    expect(root.textContent).toContain("fine");
  });

  it("offers a retry that re-mounts the widget", () => {
    let attempts = 0;
    registry.register(
      stubWidget("a", (el) => {
        attempts++;
        if (attempts === 1) throw new Error("first time unlucky");
        el.textContent = "recovered";
      }),
    );
    const host = makeHost();
    host.setDocument(doc("a"), { persist: false });
    expect(root.querySelector(".dash-card-error")).not.toBeNull();

    (root.querySelector(".dash-card-retry") as HTMLButtonElement).click();

    expect(root.querySelector(".dash-card-error")).toBeNull();
    expect(root.textContent).toContain("recovered");
  });

  it("isolates a widget whose subscription callback throws on a later update", () => {
    registry.register(
      stubWidget("bad", (_el, ctx) => {
        ctx.subscribe(ctx.sources.notebook, (snap) => {
          if (snap.markdown) throw new Error("update exploded");
        });
      }),
    );
    registry.register(
      stubWidget("good", (el, ctx) => {
        ctx.subscribe(ctx.sources.notebook, (snap) => {
          el.textContent = snap.markdown;
        });
      }),
    );
    const host = makeHost();
    host.setDocument(doc("bad", "good"), { persist: false });
    expect(root.querySelectorAll(".dash-card-error")).toHaveLength(0);

    sources.setNotebook("hello");

    expect(root.querySelectorAll(".dash-card-error")).toHaveLength(1);
    expect(root.textContent).toContain("update exploded");
    // The healthy widget still received the update.
    expect(root.textContent).toContain("hello");
  });

  it("stops delivering updates to a widget that has already failed", () => {
    let calls = 0;
    registry.register(
      stubWidget("bad", (_el, ctx) => {
        ctx.subscribe(ctx.sources.notebook, () => {
          calls++;
          throw new Error("always");
        });
      }),
    );
    const host = makeHost();
    host.setDocument(doc("bad"), { persist: false });
    sources.setNotebook("one");
    sources.setNotebook("two");
    // Once at mount (immediate) and never again.
    expect(calls).toBe(1);
  });

  it("takes a failed widget's header controls down with it", () => {
    registry.register(
      stubWidget("a", (_el, ctx) => {
        ctx.header.append(document.createElement("button"));
        ctx.subscribe(ctx.sources.notebook, (snap) => {
          if (snap.markdown) throw new Error("later");
        });
      }),
    );
    const host = makeHost();
    host.setDocument(doc("a"), { persist: false });
    expect(root.querySelectorAll(".dash-panel-actions button")).toHaveLength(1);
    sources.setNotebook("go");
    expect(root.querySelectorAll(".dash-panel-actions button")).toHaveLength(0);
  });

  it("lets a widget declare its own failure through ctx.fail", () => {
    registry.register(
      stubWidget("self", (_el, ctx) => {
        ctx.fail(new Error("cannot draw this"));
      }),
    );
    const host = makeHost();
    host.setDocument(doc("self"), { persist: false });
    expect(root.querySelector(".dash-card-error")?.textContent).toContain("cannot draw this");
  });

  it("runs a failed widget's onDispose cleanups", () => {
    let cleaned = 0;
    registry.register(
      stubWidget("a", (_el, ctx) => {
        ctx.onDispose(() => {
          cleaned++;
        });
        ctx.subscribe(ctx.sources.notebook, (snap) => {
          if (snap.markdown) throw new Error("later");
        });
      }),
    );
    const host = makeHost();
    host.setDocument(doc("a"), { persist: false });
    expect(cleaned).toBe(0);
    sources.setNotebook("go");
    expect(root.querySelectorAll(".dash-card-error")).toHaveLength(1);
    expect(cleaned).toBe(1);
  });

  it("runs cleanups a widget registered before it threw in mount", () => {
    let cleaned = 0;
    registry.register(
      stubWidget("a", (_el, ctx) => {
        ctx.onDispose(() => {
          cleaned++;
        });
        throw new Error("mount exploded");
      }),
    );
    const host = makeHost();
    host.setDocument(doc("a"), { persist: false });
    expect(cleaned).toBe(1);
  });

  it("runs a cleanup immediately if it is registered after disposal", () => {
    let kept: Parameters<WidgetDefinition["mount"]>[1] | undefined;
    registry.register(
      stubWidget("a", (_el, ctx) => {
        kept = ctx;
      }),
    );
    const host = makeHost();
    host.setDocument(doc("a"), { persist: false });
    host.dispose();
    let cleaned = 0;
    kept!.onDispose(() => {
      cleaned++;
    });
    expect(cleaned).toBe(1);
  });

  it("survives a widget whose dispose throws", () => {
    registry.register(
      stubWidget("a", () => () => {
        throw new Error("dispose exploded");
      }),
    );
    const host = makeHost();
    host.setDocument(doc("a"), { persist: false });
    expect(() => host.setDocument(doc("a"), { persist: false })).not.toThrow();
  });
});

describe("lifecycle", () => {
  it("unsubscribes a widget's sources when the panel goes away", () => {
    let updates = 0;
    registry.register(
      stubWidget("a", (_el, ctx) => {
        ctx.subscribe(ctx.sources.notebook, () => {
          updates++;
        });
      }),
    );
    const host = makeHost();
    host.setDocument(doc("a"), { persist: false });
    expect(updates).toBe(1);

    host.setDocument(
      { version: 1, activeId: "d", dashboards: [{ id: "d", title: "D", panels: [] }] },
      { persist: false },
    );
    sources.setNotebook("after removal");
    expect(updates).toBe(1);
  });

  it("neutralizes a context a widget kept past its own dispose", () => {
    let kept: Parameters<WidgetDefinition["mount"]>[1] | undefined;
    let late = 0;
    registry.register(
      stubWidget("a", (_el, ctx) => {
        kept = ctx;
      }),
    );
    const host = makeHost();
    host.setDocument(doc("a"), { persist: false });
    const before = host.getDocument();
    host.dispose();

    // Everything the stale context can reach must now be inert.
    kept!.subscribe(kept!.sources.notebook, () => {
      late++;
    });
    sources.setNotebook("after dispose");
    kept!.setConfig({ sneaky: true });
    kept!.openFile?.("figures/plot.png");
    kept!.fail(new Error("too late"));

    expect(late).toBe(0);
    expect(openFile).not.toHaveBeenCalled();
    expect(host.getDocument()).toEqual(before);
  });

  it("passes openFile straight through while the panel is alive", () => {
    let kept: Parameters<WidgetDefinition["mount"]>[1] | undefined;
    registry.register(
      stubWidget("a", (_el, ctx) => {
        kept = ctx;
      }),
    );
    const host = makeHost();
    host.setDocument(doc("a"), { persist: false });
    kept!.openFile?.("figures/plot.png");
    expect(openFile).toHaveBeenCalledWith("figures/plot.png");
    host.dispose();
  });

  it("leaves openFile undefined where the shell has no viewer, rather than a no-op", () => {
    let kept: Parameters<WidgetDefinition["mount"]>[1] | undefined;
    registry.register(
      stubWidget("a", (_el, ctx) => {
        kept = ctx;
      }),
    );
    // A widget feature-detects on this, so "absent" has to mean absent.
    const host = new DashboardHost(root, { sources: sources.sources, registry });
    host.setDocument(doc("a"), { persist: false });
    expect(kept!.openFile).toBeUndefined();
    host.dispose();
  });

  it("clears the container and stops updates on dispose", () => {
    let updates = 0;
    registry.register(
      stubWidget("a", (_el, ctx) => {
        ctx.subscribe(ctx.sources.notebook, () => {
          updates++;
        });
      }),
    );
    const host = makeHost();
    host.setDocument(doc("a"), { persist: false });
    host.dispose();
    sources.setNotebook("after dispose");
    expect(updates).toBe(1);
    expect(root.textContent).toBe("");
  });
});

describe("document management", () => {
  it("hands out a copy, so a caller cannot mutate host state", () => {
    const host = makeHost();
    const copy = host.getDocument();
    copy.dashboards[0].panels = [];
    expect(host.getDocument().dashboards[0].panels.length).toBeGreaterThan(0);
  });

  it("persists on setDocument and not when persist is false", () => {
    const persist = vi.fn();
    registry.register(stubWidget("a", () => {}));
    const host = makeHost(persist);
    host.setDocument(doc("a"), { persist: false });
    expect(persist).not.toHaveBeenCalled();
    host.setDocument(doc("a"));
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("rejects a fatally malformed document and changes nothing", () => {
    const persist = vi.fn();
    const host = makeHost(persist);
    const before = host.getDocument();
    const problems = host.setDocument({ version: 99 } as unknown as DashboardDocument);
    expect(problems.length).toBeGreaterThan(0);
    expect(persist).not.toHaveBeenCalled();
    expect(host.getDocument()).toEqual(before);
  });

  it("normalizes on the way in, so a repaired document is what renders", () => {
    registry.register(stubWidget("a", () => {}));
    const host = makeHost();
    const problems = host.setDocument(
      {
        version: 1,
        activeId: "d",
        dashboards: [
          { id: "d", title: "D", panels: [{ id: "p", widget: "a", layout: { span: 7, rows: 0 } }] },
        ],
      } as unknown as DashboardDocument,
      { persist: false },
    );
    expect(problems.length).toBeGreaterThan(0);
    expect(host.getDocument().dashboards[0].panels[0].layout).toEqual({ span: 1, rows: 1 });
  });

  it("writes a widget's config change back to the document and persists it", () => {
    const persist = vi.fn();
    registry.register(
      stubWidget("a", (_el, ctx) => {
        ctx.setConfig({ follow: false });
      }),
    );
    const host = makeHost(persist);
    host.setDocument(doc("a"), { persist: false });
    expect(host.getDocument().dashboards[0].panels[0].config).toEqual({ follow: false });
    expect(persist).toHaveBeenCalled();
  });

  it("does not duplicate panels when a widget reconfigures itself during mount", () => {
    let mounts = 0;
    registry.register(
      stubWidget("a", (_el, ctx) => {
        mounts++;
        if (mounts === 1) ctx.setConfig({ ready: true });
      }),
    );
    registry.register(stubWidget("b", () => {}));
    const host = makeHost();
    host.setDocument(doc("a", "b"), { persist: false });

    expect(root.querySelectorAll(".dash-panel")).toHaveLength(2);
    expect(host.getDocument().dashboards[0].panels[0].config).toEqual({ ready: true });
  });

  it("gives up rather than spinning when a widget reconfigures itself every mount", () => {
    let mounts = 0;
    registry.register(
      stubWidget("a", (_el, ctx) => {
        mounts++;
        ctx.setConfig({ n: mounts });
      }),
    );
    const host = makeHost();
    host.setDocument(doc("a"), { persist: false });
    // It really did re-render (so the queue works) and really did stop.
    expect(mounts).toBeGreaterThan(1);
    expect(mounts).toBeLessThanOrEqual(4);
    expect(root.querySelectorAll(".dash-panel")).toHaveLength(1);
  });

  it("merges the panel config over the widget's defaults", () => {
    let seen: Record<string, unknown> = {};
    registry.register({
      type: "a",
      label: "A",
      defaultConfig: { follow: true, depth: 3 },
      mount: (_el, ctx) => {
        seen = ctx.config;
      },
    });
    const host = makeHost();
    const next = doc("a");
    next.dashboards[0].panels[0].config = { depth: 9 };
    host.setDocument(next, { persist: false });
    expect(seen).toEqual({ follow: true, depth: 9 });
  });

  it("writes a late config change to the dashboard the widget was mounted from", () => {
    // Panel ids are unique per dashboard, and the shipped presets reuse them.
    let kept: Parameters<WidgetDefinition["mount"]>[1] | undefined;
    registry.register(
      stubWidget("a", (_el, ctx) => {
        kept ??= ctx;
      }),
    );
    const host = makeHost();
    host.setDocument(
      {
        version: 1,
        activeId: "one",
        dashboards: [
          {
            id: "one",
            title: "One",
            panels: [{ id: "shared", widget: "a", config: {}, layout: { span: 1, rows: 2 } }],
          },
          {
            id: "two",
            title: "Two",
            panels: [{ id: "shared", widget: "a", config: {}, layout: { span: 1, rows: 2 } }],
          },
        ],
      },
      { persist: false },
    );

    const fromDashboardOne = kept!;
    host.setActiveDashboardId("two");
    fromDashboardOne.setConfig({ late: true });

    const doc = host.getDocument();
    // Disposed with its panel, so it writes nowhere -- and certainly not onto
    // the same-named panel of the dashboard the user switched to.
    expect(doc.dashboards[1].panels[0].config).toEqual({});
    expect(doc.dashboards[0].panels[0].config).toEqual({});
  });

  it("switches the active dashboard and ignores an id that does not exist", () => {
    registry.register(stubWidget("a", () => {}));
    const host = makeHost();
    host.setDocument(
      {
        version: 1,
        activeId: "one",
        dashboards: [
          {
            id: "one",
            title: "One",
            panels: [{ id: "p", widget: "a", config: {}, layout: { span: 1, rows: 2 } }],
          },
          { id: "two", title: "Two", panels: [] },
        ],
      },
      { persist: false },
    );
    host.setActiveDashboardId("two");
    expect(host.getActiveDashboard()?.id).toBe("two");
    host.setActiveDashboardId("nope");
    expect(host.getActiveDashboard()?.id).toBe("two");
  });

  it("lists the registered widgets for the editor", () => {
    registry.register(stubWidget("a", () => {}));
    registry.register(stubWidget("b", () => {}));
    expect(
      makeHost()
        .listWidgets()
        .map((w) => w.type),
    ).toEqual(["a", "b"]);
  });
});

describe("the editor extension point", () => {
  function makeHostWithEditor(editor: DashboardEditor | null): DashboardHost {
    return new DashboardHost(root, { sources: sources.sources, registry, editor });
  }

  it("attaches once, with a toolbar of its own and the host api", () => {
    const attach = vi.fn();
    const host = makeHostWithEditor({ attach });
    expect(attach).toHaveBeenCalledTimes(1);
    const ctx = attach.mock.calls[0][0] as DashboardEditorContext;
    expect(ctx.host).toBe(host);
    expect(ctx.toolbar.classList.contains("dash-toolbar")).toBe(true);
  });

  it("decorates every panel with its own header slot", () => {
    registry.register(stubWidget("a", () => {}));
    const decoratePanel = vi.fn();
    const host = makeHostWithEditor({ attach: () => {}, decoratePanel });
    // The constructor already drew the default document; count this render only.
    decoratePanel.mockClear();
    host.setDocument(doc("a", "a"), { persist: false });
    expect(decoratePanel).toHaveBeenCalledTimes(2);
    const tools = decoratePanel.mock.calls[0][1] as HTMLElement;
    expect(tools.classList.contains("dash-panel-tools")).toBe(true);
  });

  it("disposes what decoratePanel returned when the panel is re-rendered", () => {
    registry.register(stubWidget("a", () => {}));
    let disposed = 0;
    const host = makeHostWithEditor({
      attach: () => {},
      decoratePanel: () => () => {
        disposed++;
      },
    });
    host.setDocument(doc("a"), { persist: false });
    disposed = 0;
    host.refresh();
    expect(disposed).toBe(1);
  });

  it("re-renders on refresh without touching or persisting the document", () => {
    const persist = vi.fn();
    let mounts = 0;
    registry.register(
      stubWidget("a", () => {
        mounts++;
      }),
    );
    const host = new DashboardHost(root, {
      sources: sources.sources,
      registry,
      persist,
      editor: null,
    });
    host.setDocument(doc("a"), { persist: false });
    const before = host.getDocument();
    host.refresh();
    expect(mounts).toBe(2);
    expect(host.getDocument()).toEqual(before);
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps rendering when the editor throws on attach or decorate", () => {
    registry.register(stubWidget("a", () => {}));
    const host = makeHostWithEditor({
      attach: () => {
        throw new Error("attach exploded");
      },
      decoratePanel: () => {
        throw new Error("decorate exploded");
      },
    });
    host.setDocument(doc("a"), { persist: false });
    expect(root.querySelectorAll(".dash-panel")).toHaveLength(1);
  });
});

describe("banner", () => {
  it("shows and hides the note above the grid", () => {
    const host = makeHost();
    const banner = root.querySelector(".dash-banner") as HTMLElement;
    expect(banner.classList.contains("hidden")).toBe(true);
    host.setBanner("could not read the saved layout");
    expect(banner.classList.contains("hidden")).toBe(false);
    expect(banner.textContent).toBe("could not read the saved layout");
    host.setBanner("");
    expect(banner.classList.contains("hidden")).toBe(true);
  });
});

describe("registry", () => {
  it("keeps the first of two widgets claiming the same type, without throwing", () => {
    // Registration happens on the import chain the whole renderer boots
    // through, so a duplicate type must not be able to blank the window.
    const first = stubWidget("a", () => {});
    expect(registry.register(first)).toBe(true);
    expect(registry.register(stubWidget("a", () => {}))).toBe(false);
    expect(registry.get("a")).toBe(first);
    expect(registry.list()).toHaveLength(1);
  });

  it("registers every built-in widget under a distinct type", async () => {
    const { BUILT_IN_WIDGETS } = await import("../app/src/renderer/dashboard/widgets/index.js");
    const types = BUILT_IN_WIDGETS.map((w) => w.type);
    expect(new Set(types).size).toBe(types.length);
    expect(types).toContain("notebook");
  });

  it("gives the default document a widget for every panel it ships", async () => {
    const { BUILT_IN_WIDGETS } = await import("../app/src/renderer/dashboard/widgets/index.js");
    const known = new Set(BUILT_IN_WIDGETS.map((w) => w.type));
    for (const panel of createDefaultDashboardDocument().dashboards[0].panels) {
      expect(known.has(panel.widget), panel.widget).toBe(true);
    }
  });
});
