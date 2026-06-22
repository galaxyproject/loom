/**
 * Phase 2.2 emission wiring: the UI bridge derives the NotebookEmbed widget
 * from the notebook's `loom-galaxy-page` block and emits it alongside the
 * Notebook markdown widget — on every distinct notebook write, independent of
 * the Notebook pane's hidden state, deduped on the encoded payload.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { captured, setNotebookWidgetMode, widgetMode, currentNotebook } = vi.hoisted(() => ({
  captured: { listener: null as null | ((content: string) => void) },
  setNotebookWidgetMode: vi.fn(),
  widgetMode: { value: "open" as "auto" | "open" | "hidden" },
  currentNotebook: { value: null as string | null },
}));

vi.mock("../extensions/loom/state.js", () => ({
  onNotebookChange: (listener: (content: string) => void) => {
    captured.listener = listener;
    return () => {};
  },
  getNotebookPath: () => "/work/notebook.md",
  getNotebookWidgetMode: () => widgetMode.value,
  setNotebookWidgetMode,
  readCurrentNotebook: () => currentNotebook.value,
}));

import { setupUIBridge } from "../extensions/loom/ui-bridge";
import { renderGalaxyPageBlock } from "../extensions/loom/galaxy-page-binding";
import { decodeNotebookEmbed } from "../shared/loom-shell-contract.js";

function fakePi() {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const pi = {
    on: (evt: string, handler: (...args: any[]) => any) => {
      handlers[evt] = handler;
    },
  } as any;
  return { pi, handlers };
}

function bindingBlock(overrides: Record<string, unknown> = {}): string {
  return renderGalaxyPageBlock({
    pageId: "adb5f5c93f827949",
    pageSlug: "my-analysis",
    galaxyServerUrl: "https://usegalaxy.org",
    historyId: "hist-1",
    lastSyncedRevision: "rev-3",
    boundAt: "2026-06-20T11:00:00Z",
    ...(overrides as any),
  });
}

/** Last payload pushed under a given widget key, decoded. */
function embedOf(setWidget: ReturnType<typeof vi.fn>) {
  const call = [...setWidget.mock.calls].reverse().find((c) => c[0] === "notebook-embed");
  return call ? decodeNotebookEmbed(call[1]) : null;
}

function start() {
  const { pi, handlers } = fakePi();
  setupUIBridge(pi);
  const setWidget = vi.fn();
  handlers["before_agent_start"]({}, { ui: { setWidget } });
  return setWidget;
}

describe("ui-bridge embed emission", () => {
  beforeEach(() => {
    captured.listener = null;
    currentNotebook.value = null;
    setNotebookWidgetMode.mockClear();
    widgetMode.value = "open";
  });

  it("emits an unbound payload when the notebook has no binding block", () => {
    const setWidget = start();
    captured.listener!("# just prose, no binding\n");

    expect(embedOf(setWidget)).toEqual({
      bound: false,
      pageId: null,
      historyId: null,
      galaxyUrl: null,
      embedUrl: null,
      lastSyncedRevision: null,
    });
  });

  it("projects the loom-galaxy-page block into a bound embed payload", () => {
    const setWidget = start();
    captured.listener!(`# Analysis\n\n${bindingBlock()}`);

    expect(embedOf(setWidget)).toEqual({
      bound: true,
      pageId: "adb5f5c93f827949",
      historyId: "hist-1",
      galaxyUrl: "https://usegalaxy.org",
      embedUrl: "https://usegalaxy.org/published/page?id=adb5f5c93f827949&embed=true&rev=rev-3",
      lastSyncedRevision: "rev-3",
    });
  });

  it("does not bake embed_origin into the brain-emitted URL (shell appends it)", () => {
    const setWidget = start();
    captured.listener!(bindingBlock());
    expect(embedOf(setWidget)!.embedUrl).not.toContain("embed_origin");
  });

  it("re-emits when the binding changes (rev bump)", () => {
    const setWidget = start();
    captured.listener!(`# a\n\n${bindingBlock({ lastSyncedRevision: "rev-3" })}`);
    captured.listener!(`# b\n\n${bindingBlock({ lastSyncedRevision: "rev-9" })}`);

    const embedCalls = setWidget.mock.calls.filter((c) => c[0] === "notebook-embed");
    expect(embedCalls).toHaveLength(2);
    expect(embedOf(setWidget)!.lastSyncedRevision).toBe("rev-9");
  });

  it("dedups the embed when only surrounding prose changes (binding stable)", () => {
    const setWidget = start();
    captured.listener!(`# first\n\n${bindingBlock()}`);
    captured.listener!(`# second, edited prose\n\n${bindingBlock()}`);

    // Notebook markdown re-emits both times; the embed only once.
    expect(setWidget.mock.calls.filter((c) => c[0] === "notebook-embed")).toHaveLength(1);
    expect(setWidget.mock.calls.filter((c) => c[0] === "notebook")).toHaveLength(2);
  });

  it("emits the embed on session_start for an already-bound notebook (resume — Bug 3)", () => {
    // A --continue resume fires no notebook change; the bridge must replay the
    // current notebook content when it captures ctx on session_start.
    currentNotebook.value = `# Resumed\n\n${bindingBlock()}`;
    const { pi, handlers } = fakePi();
    setupUIBridge(pi);
    const setWidget = vi.fn();
    handlers["session_start"]({}, { ui: { setWidget } });

    expect(embedOf(setWidget)).toMatchObject({ bound: true, pageId: "adb5f5c93f827949" });
  });

  it("emits the embed even when the Notebook pane is hidden (separate panes)", () => {
    widgetMode.value = "hidden";
    const setWidget = start();
    captured.listener!(bindingBlock());

    const keys = setWidget.mock.calls.map((c) => c[0]);
    expect(keys).toContain("notebook-embed");
    expect(keys).not.toContain("notebook"); // notebook pane stays closed
    expect(setNotebookWidgetMode).not.toHaveBeenCalled();
  });
});
