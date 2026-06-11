import { beforeEach, describe, expect, it, vi } from "vitest";

// #271: a notebook write that lands after session teardown fires the watcher
// callback with a captured ctx that pi has since invalidated. Touching
// ctx.ui throws "ctx is stale after session replacement or reload". The
// listener must no-op instead of throwing (which otherwise spams stderr and
// signals the dangling-watcher defect).
const { captured, setNotebookWidgetMode } = vi.hoisted(() => ({
  captured: { listener: null as null | ((content: string) => void) },
  setNotebookWidgetMode: vi.fn(),
}));

vi.mock("../extensions/loom/state.js", () => ({
  onNotebookChange: (listener: (content: string) => void) => {
    captured.listener = listener;
    return () => {};
  },
  getNotebookPath: () => "/work/notebook.md",
  getNotebookWidgetMode: () => "open",
  setNotebookWidgetMode,
}));

import { setupUIBridge } from "../extensions/loom/ui-bridge";

function fakePi() {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const pi = {
    on: (evt: string, handler: (...args: any[]) => any) => {
      handlers[evt] = handler;
    },
  } as any;
  return { pi, handlers };
}

function staleCtx() {
  return {
    get ui(): never {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    },
  };
}

describe("ui-bridge notebook widget (#271 stale-ctx guard)", () => {
  beforeEach(() => {
    captured.listener = null;
    setNotebookWidgetMode.mockClear();
  });

  it("renders the widget on an active ctx", () => {
    const { pi, handlers } = fakePi();
    setupUIBridge(pi);
    const setWidget = vi.fn();
    handlers["before_agent_start"]({}, { ui: { setWidget } });

    captured.listener!("fresh notebook content");

    expect(setWidget).toHaveBeenCalledTimes(1);
    expect(setNotebookWidgetMode).toHaveBeenCalledWith("open");
  });

  it("no-ops instead of throwing when the captured ctx is stale", () => {
    const { pi, handlers } = fakePi();
    setupUIBridge(pi);
    handlers["before_agent_start"]({}, staleCtx());

    expect(() => captured.listener!("content after teardown")).not.toThrow();
    expect(setNotebookWidgetMode).not.toHaveBeenCalled();
  });

  it("drops the stale ctx so later notebook changes also no-op", () => {
    const { pi, handlers } = fakePi();
    setupUIBridge(pi);
    handlers["before_agent_start"]({}, staleCtx());

    captured.listener!("first");
    expect(() => captured.listener!("second")).not.toThrow();
    expect(setNotebookWidgetMode).not.toHaveBeenCalled();
  });

  it("surfaces an unexpected setWidget failure instead of silently masking it", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { pi, handlers } = fakePi();
      setupUIBridge(pi);
      const setWidget = vi.fn(() => {
        throw new Error("renderer RPC blew up");
      });
      handlers["before_agent_start"]({}, { ui: { setWidget } });

      // Unrelated failure must not throw out of the listener, but unlike the
      // stale-ctx case it must be logged so a real regression stays visible.
      expect(() => captured.listener!("content")).not.toThrow();
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(setNotebookWidgetMode).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
