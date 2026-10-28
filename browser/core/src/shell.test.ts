/**
 * The shell's generic paths, which Olit never takes: no session store, a launch that stops, and
 * a host that unmounts. Every e2e drive mounts Olit, so these are only held here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveCredentials } from "./credentials";
import { cannotStart, currentHistoryLaunch, mountOrbitBrowser } from "./shell";
import type { Galaxy } from "./agent/galaxy";
import type { WorkerMessage } from "./agent/worker";

const base = { galaxyRoot: "/", galaxyChatUrl: "/api/plugins/test", pyodideURL: "/pyodide/" };

/** Enough of a Worker for AgentClient: what it was sent, and a way to answer. */
function fakeWorker() {
  const worker = {
    sent: [] as any[],
    onmessage: null as ((e: MessageEvent) => void) | null,
    onerror: null as ((e: ErrorEvent) => void) | null,
    postMessage: vi.fn((m: unknown) => worker.sent.push(m)),
    terminate: vi.fn(),
    say: (data: WorkerMessage) => worker.onmessage?.({ data } as MessageEvent),
  };
  return worker;
}

let container: HTMLElement;

beforeEach(() => {
  // A provider that needs no key, so the picker doesn't open.
  saveCredentials({ provider: "galaxy" });
  container = document.body.appendChild(document.createElement("div"));
});

afterEach(() => {
  container.remove();
  sessionStorage.clear();
});

describe("a launch that stops", () => {
  it("says why, starts no worker, and still hands back a handle", async () => {
    const createWorker = vi.fn();
    const handle = await mountOrbitBrowser(container, {
      ...base,
      createWorker,
      launch: async () => ({ stop: cannotStart("the current history") }),
    });
    expect(createWorker).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Could not read the current history from Galaxy");
    expect(container.querySelector<HTMLTextAreaElement>("#input")?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>("#send-btn")?.disabled).toBe(true);
    handle.dispose();
    expect(container.childElementCount).toBe(0);
  });
});

describe("a flavor with no session store", () => {
  it("offers no Save, and its messages don't send the user looking for one", async () => {
    const worker = fakeWorker();
    await mountOrbitBrowser(container, {
      ...base,
      createWorker: () => worker as unknown as Worker,
      launch: async () => ({ historyId: "h1" }),
    });
    expect(container.querySelector("#save-btn")).toBeNull();
    worker.say({ type: "ready", unkept: "no private file system" } as WorkerMessage);
    worker.say({ type: "recoverable", records: [] } as unknown as WorkerMessage);
    expect(container.textContent).toContain("so this one ends when the page closes.");
    expect(container.textContent).toContain("starts a fresh chat without its earlier transcript.");
    expect(container.textContent).not.toMatch(/\bSave\b/);
  });

  it("does offer Save once a store is given", async () => {
    await mountOrbitBrowser(container, {
      ...base,
      createWorker: vi.fn(),
      launch: async () => ({ stop: "stopped" }),
      sessions: { save: async () => "id", savedState: () => {}, savedNote: "Saved." },
    });
    expect(container.querySelector("#save-btn")).not.toBeNull();
  });
});

describe("dispose", () => {
  // Orbit's ChatPanel adds document listeners of its own that only the renderer could detach.
  it("ends the worker and detaches the pane's document listeners", async () => {
    const worker = fakeWorker();
    const listening = vi.spyOn(document, "addEventListener");
    const handle = await mountOrbitBrowser(container, {
      ...base,
      createWorker: () => worker as unknown as Worker,
      launch: async () => ({ historyId: "h1" }),
    });
    expect(worker.sent[0]?.type).toBe("open");
    const signals = listening.mock.calls
      .filter(([type]) => type === "mousemove" || type === "mouseup")
      .map(([, , options]) => (options as AddEventListenerOptions | undefined)?.signal)
      .filter(Boolean);
    expect(signals).toHaveLength(2);
    handle.dispose();
    for (const signal of signals) {
      expect(signal?.aborted).toBe(true);
    }
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(container.childElementCount).toBe(0);
    listening.mockRestore();
  });

  it("leaves nothing on the container that answers a second mount's shortcut", async () => {
    const mount = () =>
      mountOrbitBrowser(container, {
        ...base,
        createWorker: () => fakeWorker() as unknown as Worker,
        launch: async () => ({ historyId: "h1" }),
      });
    const showSomething = () =>
      container.querySelector("#artifact-content")!.appendChild(document.createElement("div"));
    const first = await mount();
    showSomething();
    first!.dispose();
    await mount();
    showSomething();
    const before = document.body.classList.contains("artifact-collapsed");
    container.dispatchEvent(
      new KeyboardEvent("keydown", { key: "\\", ctrlKey: true, bubbles: true }),
    );
    expect(document.body.classList.contains("artifact-collapsed")).toBe(!before);
  });
});

describe("currentHistoryLaunch", () => {
  const galaxy = (get: () => Promise<unknown>) => ({ get }) as unknown as Galaxy;

  it("starts in the history Galaxy names", async () => {
    expect(await currentHistoryLaunch(galaxy(async () => ({ id: "h9" })))).toEqual({
      historyId: "h9",
    });
  });

  it("stops when Galaxy names none", async () => {
    expect((await currentHistoryLaunch(galaxy(async () => ({})))).stop).toContain(
      "it named no history",
    );
  });

  it("stops with Galaxy's own problem when the request fails", async () => {
    const launch = await currentHistoryLaunch(
      galaxy(async () => {
        throw new Error("502 Bad Gateway");
      }),
    );
    expect(launch.stop).toContain("502 Bad Gateway");
  });
});
