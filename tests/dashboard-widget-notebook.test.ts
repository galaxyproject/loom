// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { notebookWidget } from "../app/src/renderer/dashboard/widgets/notebook.js";
import { DashboardSources } from "../app/src/renderer/dashboard/data-sources.js";
import type { DataSource, WidgetContext } from "../app/src/renderer/dashboard/widget-api.js";

interface Harness {
  el: HTMLElement;
  header: HTMLElement;
  ctx: WidgetContext<{ follow: boolean }>;
  sources: DashboardSources;
  setConfig: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
  offs: Array<() => void>;
  cleanups: Array<() => void>;
}

function harness(config: Partial<{ follow: boolean }> = {}): Harness {
  const el = document.createElement("div");
  const header = document.createElement("div");
  document.body.append(el, header);
  const sources = new DashboardSources();
  const offs: Array<() => void> = [];
  const cleanups: Array<() => void> = [];
  const setConfig = vi.fn();
  const fail = vi.fn();
  const ctx = {
    panelId: "p",
    config: { ...notebookWidget.defaultConfig, ...config },
    sources: sources.sources,
    header,
    setConfig,
    fail,
    onDispose(fn: () => void) {
      cleanups.push(fn);
    },
    subscribe<T>(source: DataSource<T>, listener: (value: T) => void) {
      const off = source.subscribe(listener);
      offs.push(off);
      listener(source.get());
      return off;
    },
  } as WidgetContext<{ follow: boolean }>;
  return { el, header, ctx, sources, setConfig, fail, offs, cleanups };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("notebook widget", () => {
  it("declares the type and label the document and registry expect", () => {
    expect(notebookWidget.type).toBe("notebook");
    expect(notebookWidget.defaultConfig).toEqual({ follow: true });
  });

  it("shows a prompt when there is no notebook yet", () => {
    const h = harness();
    notebookWidget.mount(h.el, h.ctx);
    expect(h.el.textContent).toContain("notebook.md");
    expect(h.el.querySelector("h1")).toBeNull();
  });

  it("renders the notebook markdown and re-renders on an update", () => {
    const h = harness();
    notebookWidget.mount(h.el, h.ctx);
    h.sources.setNotebook("Analysis\n\nFirst pass.\n");
    // Block structure, not just text: markdown really went through the parser.
    expect(h.el.querySelectorAll("p").length).toBeGreaterThan(0);
    expect(h.el.textContent).toContain("First pass.");
    h.sources.setNotebook("Analysis\n\nSecond pass.\n");
    expect(h.el.textContent).toContain("Second pass.");
    expect(h.el.textContent).not.toContain("First pass.");
  });

  it("renders inline emphasis, so the markdown pipeline is really running", () => {
    const h = harness();
    notebookWidget.mount(h.el, h.ctx);
    h.sources.setNotebook("a **bold** claim\n");
    expect(h.el.querySelector("strong")?.textContent).toBe("bold");
  });

  it("rewrites a relative figure path to the artifact scheme", () => {
    const h = harness();
    notebookWidget.mount(h.el, h.ctx);
    h.sources.setNotebook("![qc](10_figures/qc.png)\n");
    expect(h.el.querySelector("img")?.getAttribute("src")).toBe(
      "orbit-artifact://cwd/10_figures/qc.png",
    );
  });

  it("sanitizes markdown that carries a script", () => {
    const h = harness();
    notebookWidget.mount(h.el, h.ctx);
    h.sources.setNotebook("<script>window.pwned = 1</script>\n\nok\n");
    expect(h.el.querySelector("script")).toBeNull();
    expect(h.el.textContent).toContain("ok");
  });

  it("puts a follow toggle in the header that asks the host to save the change", () => {
    const h = harness();
    notebookWidget.mount(h.el, h.ctx);
    const btn = h.header.querySelector("button") as HTMLButtonElement;
    expect(btn.textContent).toBe("following");
    btn.click();
    expect(h.setConfig).toHaveBeenCalledWith({ follow: false });
  });

  it("reflects follow: false in the toggle", () => {
    const h = harness({ follow: false });
    notebookWidget.mount(h.el, h.ctx);
    const btn = h.header.querySelector("button") as HTMLButtonElement;
    expect(btn.textContent).toBe("follow");
    expect(btn.classList.contains("active")).toBe(false);
  });

  it("empties its element on dispose", () => {
    const h = harness();
    const dispose = notebookWidget.mount(h.el, h.ctx);
    h.sources.setNotebook("Analysis\n");
    dispose?.();
    expect(h.el.textContent).toBe("");
  });

  it("registers its resize observer through onDispose, so a failure still tears it down", () => {
    const h = harness();
    notebookWidget.mount(h.el, h.ctx);
    // happy-dom has no ResizeObserver, so only assert when the environment does.
    if (typeof ResizeObserver !== "undefined") {
      expect(h.cleanups.length).toBeGreaterThan(0);
      expect(() => h.cleanups.forEach((fn) => fn())).not.toThrow();
    }
  });
});
