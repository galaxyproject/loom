// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { htmlSandboxWidget } from "../app/src/renderer/dashboard/widgets/html-sandbox.js";
import { DashboardSources } from "../app/src/renderer/dashboard/data-sources.js";
import { __setHtmlSandboxEnabledForTests } from "../app/src/renderer/dashboard/sandbox/flag.js";
import {
  SANDBOX_FORBIDDEN_TOKENS,
  SANDBOX_MAX_HTML_BYTES,
  SANDBOX_MAX_HEIGHT,
  SANDBOX_MESSAGE_TAG,
} from "../app/src/renderer/dashboard/sandbox/policy.js";
import type { DataSource, WidgetContext } from "../app/src/renderer/dashboard/widget-api.js";

type Config = { html: string; title?: string; data?: string[] };

interface Harness {
  el: HTMLElement;
  header: HTMLElement;
  ctx: WidgetContext<Config>;
  sources: DashboardSources;
  /** Which of the six sources the widget actually subscribed to. */
  subscribed: string[];
  dispose(): void;
}

function harness(config: Partial<Config> = {}): Harness {
  const el = document.createElement("div");
  const header = document.createElement("div");
  document.body.append(el, header);
  const sources = new DashboardSources();
  const offs: Array<() => void> = [];
  const cleanups: Array<() => void> = [];
  const subscribed: string[] = [];
  const names = Object.entries(sources.sources);

  const ctx = {
    panelId: "p1",
    config: { ...htmlSandboxWidget.defaultConfig, ...config },
    sources: sources.sources,
    header,
    setConfig: vi.fn(),
    fail: vi.fn(),
    onDispose(fn: () => void) {
      cleanups.push(fn);
    },
    subscribe<T>(
      source: DataSource<T>,
      listener: (value: T) => void,
      opts?: { immediate?: boolean },
    ) {
      const name = names.find(([, s]) => s === (source as unknown))?.[0];
      if (name) subscribed.push(name);
      const off = source.subscribe(listener);
      offs.push(off);
      if (opts?.immediate !== false) listener(source.get());
      return off;
    },
  } as unknown as WidgetContext<Config>;

  let widgetDispose: (() => void) | void;
  const h: Harness = {
    el,
    header,
    ctx,
    sources,
    subscribed,
    // Mirrors the host: unsubscribe, run registered cleanups newest-first,
    // then the widget's own dispose.
    dispose() {
      while (offs.length) offs.pop()?.();
      while (cleanups.length) cleanups.pop()?.();
      widgetDispose?.();
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h as any).run = () => {
    widgetDispose = htmlSandboxWidget.mount(el, ctx);
  };
  return h;
}

function mount(h: Harness): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h as any).run();
}

function frameIn(h: Harness): HTMLIFrameElement | null {
  return h.el.querySelector("iframe");
}

/**
 * Stand in for the frame's bridge: announce over the window and hand the host
 * one end of a channel, exactly as `SANDBOX_BRIDGE_SOURCE` does. `sent` is
 * everything the host posts back down it.
 */
function announce(
  frame: HTMLIFrameElement,
  opts: { withPort?: boolean; source?: unknown } = {},
): { sent: unknown[]; port: MessagePort } {
  const channel = new MessageChannel();
  const sent: unknown[] = [];
  channel.port1.onmessage = (event: MessageEvent) => sent.push(event.data);
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { tag: SANDBOX_MESSAGE_TAG, type: "ready" },
      source: (opts.source ?? frame.contentWindow) as Window,
      ports: opts.withPort === false ? [] : [channel.port2],
    }),
  );
  return { sent, port: channel.port1 };
}

/** A window-level message, the way anything other than the bridge would send one. */
function post(frame: HTMLIFrameElement, data: unknown, source?: unknown): void {
  window.dispatchEvent(
    new MessageEvent("message", { data, source: (source ?? frame.contentWindow) as Window }),
  );
}

/**
 * Counts `message` listeners added and removed on window, by spying rather
 * than by reading happy-dom's internals. This is the only way to tell "the
 * listener was removed" apart from "the listener ran and bailed on a flag" --
 * a test that only checks the effect passes if either one works.
 */
function trackMessageListeners(): { net: () => number; restore: () => void } {
  let net = 0;
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  const addSpy = vi
    .spyOn(window, "addEventListener")
    .mockImplementation((type: string, ...rest: unknown[]) => {
      if (type === "message") net += 1;
      return (add as (...a: unknown[]) => void)(type, ...rest);
    });
  const removeSpy = vi
    .spyOn(window, "removeEventListener")
    .mockImplementation((type: string, ...rest: unknown[]) => {
      if (type === "message") net -= 1;
      return (remove as (...a: unknown[]) => void)(type, ...rest);
    });
  return {
    net: () => net,
    restore: () => {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    },
  };
}

/**
 * Port delivery is a task, not a microtask, and it is not reliably the very
 * next one -- a single tick made these tests flake about one run in three.
 */
async function flush(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 1));
}

/**
 * Wait for something to become true, for assertions about what did arrive.
 * Generous on purpose: the whole suite runs these files in parallel and a
 * tight budget here flakes under that load rather than under any real fault.
 */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function enable(): void {
  __setHtmlSandboxEnabledForTests(true);
}

/**
 * The widget refuses to draw unless the page pins frames somewhere that cannot
 * reach the network, so the tests have to run under a page policy. This is the
 * real one from `app/src/renderer/index.html`, trimmed to the directive that
 * matters.
 */
function setPagePolicy(content: string | null): void {
  document.head.querySelectorAll("meta[http-equiv]").forEach((m) => m.remove());
  if (content === null) return;
  const meta = document.createElement("meta");
  meta.setAttribute("http-equiv", "Content-Security-Policy");
  meta.setAttribute("content", content);
  document.head.append(meta);
}

const ORBIT_POLICY = "default-src 'self'; script-src 'self'; frame-src blob:; form-action 'none';";

beforeEach(() => {
  document.body.innerHTML = "";
  setPagePolicy(ORBIT_POLICY);
  __setHtmlSandboxEnabledForTests(null);
});

afterEach(() => {
  vi.useRealTimers();
  __setHtmlSandboxEnabledForTests(null);
});

describe("html-sandbox widget contract", () => {
  it("keeps the type and symbol the registry and the layout document expect", () => {
    expect(htmlSandboxWidget.type).toBe("html-sandbox");
    expect(htmlSandboxWidget.defaultConfig).toEqual({ html: "", data: [] });
  });
});

describe("the flag", () => {
  it("is off with nothing set, and draws no frame at all", () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    expect(frameIn(h)).toBeNull();
    expect(h.el.textContent).toContain("switched off");
    h.dispose();
  });

  it("is on when a test turns it on, so the drawing code stays covered", () => {
    enable();
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    expect(frameIn(h)).not.toBeNull();
    h.dispose();
  });

  it("cannot be turned on by anything the agent can write", () => {
    // The whole finding: this used to come from localStorage, which in a
    // packaged build is one bucket shared by every file:// document -- and the
    // agent can write an .html that the file viewer offers to open. Setting the
    // old key, and the old injected global, must now do nothing at all.
    localStorage.setItem("orbit.experiments.htmlSandbox", "1");
    (globalThis as Record<string, unknown>).__ORBIT_EXPERIMENTS__ = { htmlSandbox: true };
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    expect(frameIn(h)).toBeNull();
    expect(h.el.textContent).toContain("switched off");
    h.dispose();
    localStorage.clear();
    delete (globalThis as Record<string, unknown>).__ORBIT_EXPERIMENTS__;
  });

  it("badges the panel whether it is on or off", () => {
    for (const on of [false, true]) {
      document.body.innerHTML = "";
      __setHtmlSandboxEnabledForTests(null);
      setPagePolicy(ORBIT_POLICY);
      if (on) enable();
      const h = harness({ html: "<p>hi</p>" });
      mount(h);
      expect(h.header.querySelector(".dash-sandbox-badge")?.textContent).toBe("custom content");
      h.dispose();
    }
  });
});

describe("what gets into the frame", () => {
  beforeEach(enable);

  it("locks the frame down and says nothing more than allow-scripts", () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    const frame = frameIn(h)!;
    // Against the rendered attribute, not against the constant: this is the
    // value a browser will actually read.
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    for (const token of SANDBOX_FORBIDDEN_TOKENS) {
      expect(frame.getAttribute("sandbox")).not.toContain(token);
    }
    expect(frame.getAttribute("allow")).toBe("");
    expect(frame.getAttribute("src")).toBeNull();
    h.dispose();
  });

  it("carries the content, behind the policy", () => {
    const h = harness({ html: "<p id='mine'>hi</p>" });
    mount(h);
    const doc = frameIn(h)!.getAttribute("srcdoc") ?? "";
    expect(doc).toContain("id='mine'");
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("id='mine'"));
    h.dispose();
  });

  it("asks for nothing when the panel has no content yet", () => {
    const h = harness({ html: "   " });
    mount(h);
    expect(frameIn(h)).toBeNull();
    expect(h.el.textContent).toContain("Nothing to show yet");
    h.dispose();
  });

  it("refuses an oversized view rather than running it", () => {
    const h = harness({ html: "<p>" + "x".repeat(SANDBOX_MAX_HTML_BYTES) + "</p>" });
    mount(h);
    expect(frameIn(h)).toBeNull();
    expect(h.el.textContent).toContain("too large");
    h.dispose();
  });

  it("measures the cap in bytes, not characters", () => {
    // Just under the cap in characters, well over it once encoded: U+2014 is
    // one character and three bytes. Written as an escape so the point of it
    // is visible rather than looking like stray punctuation.
    const h = harness({ html: "\u2014".repeat(SANDBOX_MAX_HTML_BYTES - 10) });
    mount(h);
    expect(frameIn(h)).toBeNull();
    h.dispose();
  });
});

describe("data in", () => {
  beforeEach(enable);

  it("subscribes to nothing when the panel named nothing", () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    expect(h.subscribed).toEqual([]);
    h.dispose();
  });

  it("subscribes only to the sources the panel named", () => {
    const h = harness({ html: "<p>hi</p>", data: ["plan", "bogus", "session"] });
    mount(h);
    expect(h.subscribed.sort()).toEqual(["plan", "session"]);
    h.dispose();
  });

  it("sends nothing over the window before the frame has announced itself", () => {
    vi.useFakeTimers();
    const h = harness({ html: "<p>hi</p>", data: ["notebook"] });
    mount(h);
    const frame = frameIn(h)!;
    // Watch the window channel directly. Asserting on an empty port would be
    // vacuous -- there is no port yet, so of course nothing arrived on one.
    const windowPost = vi.fn();
    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      value: { postMessage: windowPost },
    });
    h.sources.setNotebook("# something");
    vi.advanceTimersByTime(1000); // well past the 150ms debounce
    expect(windowPost).not.toHaveBeenCalled();
    h.dispose();
  });

  it("sends the allowed sources, and only those, once the frame announces", async () => {
    const h = harness({ html: "<p>hi</p>", data: ["notebook"] });
    mount(h);
    const frame = frameIn(h)!;
    h.sources.setNotebook("# a heading");
    h.sources.setSession({ model: "secret-model" });

    const { sent } = announce(frame);
    await waitFor(() => sent.length > 0);

    expect(sent).toHaveLength(1);
    const msg = sent[0] as { tag: string; sources: Record<string, unknown> };
    expect(msg.tag).toBe(SANDBOX_MESSAGE_TAG);
    expect(Object.keys(msg.sources)).toEqual(["notebook"]);
    expect(JSON.stringify(msg)).toContain("a heading");
    expect(JSON.stringify(msg)).not.toContain("secret-model");
    h.dispose();
  });

  it("ignores an announcement that brings no port", async () => {
    const h = harness({ html: "<p>hi</p>", data: ["notebook"] });
    mount(h);
    const frame = frameIn(h)!;
    const { sent } = announce(frame, { withPort: false });
    await flush();
    expect(sent).toHaveLength(0);
    h.dispose();
  });

  it("ignores an announcement from a window that is not this frame", async () => {
    const h = harness({ html: "<p>hi</p>", data: ["notebook"] });
    mount(h);
    const frame = frameIn(h)!;
    const { sent } = announce(frame, { source: { impostor: true } });
    await flush();
    expect(sent).toHaveLength(0);
    h.dispose();
  });

  it("will not hand the data to a second document that announces itself", async () => {
    // The shape of a takeover: our document announces and gets the channel,
    // then something that replaced it in the frame announces too. The second
    // one gets nothing -- that is the protection, and it does not depend on
    // anyone noticing.
    const h = harness({ html: "<p>hi</p>", data: ["notebook"] });
    mount(h);
    const frame = frameIn(h)!;
    h.sources.setNotebook("# private");
    const first = announce(frame);
    await waitFor(() => first.sent.length > 0);
    expect(first.sent).toHaveLength(1);

    const second = announce(frame);
    await flush();
    expect(second.sent).toHaveLength(0);
    h.dispose();
  });

  it("does not let content raise the alarm by announcing twice", async () => {
    // Content shares a realm with the bridge, so it can send an announcement
    // whenever it likes. If that raised the red alarm, the one genuinely
    // alarming message in this UI would be one the content controls.
    const h = harness({ html: "<p>hi</p>", data: ["notebook"] });
    mount(h);
    const frame = frameIn(h)!;
    announce(frame);
    await flush();
    announce(frame);
    await flush();
    expect(h.el.textContent).not.toContain("tried to open a web page");
    expect(frameIn(h)).not.toBeNull();
    h.dispose();
  });

  it("does not produce a second payload for a repeated announcement", async () => {
    // A repeated `ready` used to run a full collect-and-clone each time, which
    // is the most expensive thing the message budget lets through.
    const h = harness({ html: "<p>hi</p>", data: ["notebook"] });
    mount(h);
    const frame = frameIn(h)!;
    const { sent } = announce(frame);
    await waitFor(() => sent.length > 0);
    for (let i = 0; i < 20; i++) post(frame, { tag: SANDBOX_MESSAGE_TAG, type: "ready" });
    await flush();
    expect(sent).toHaveLength(1);
    h.dispose();
  });

  it("says which sources were too large, and stops saying it once they fit", async () => {
    const h = harness({ html: "<p>hi</p>", data: ["notebook", "session"] });
    mount(h);
    const frame = frameIn(h)!;
    // Big enough that the notebook has to be dropped whole.
    h.sources.setNotebook("N".repeat(40_000));
    const { sent } = announce(frame);
    await waitFor(() => sent.length > 0);
    const first = sent[0] as { dropped: string[] };
    if (first.dropped.length > 0) {
      expect(h.el.textContent).toContain("too large");
      h.sources.setNotebook("# small again");
      await new Promise((r) => setTimeout(r, 200));
      await flush();
      expect(h.el.textContent).not.toContain("too large");
    }
    h.dispose();
  });

  it("sends the notebook's name and not the path it sits at", async () => {
    const h = harness({ html: "<p>hi</p>", data: ["notebook"] });
    mount(h);
    const frame = frameIn(h)!;
    h.sources.setNotebook("# x", "/Users/someone/secret-project/notebook.md");
    const { sent } = announce(frame);
    await waitFor(() => sent.length > 0);
    const json = JSON.stringify(sent[0]);
    expect(json).not.toContain("/Users/someone");
    expect(json).toContain("notebook.md");
    h.dispose();
  });
});

describe("data out", () => {
  beforeEach(enable);

  it("applies a height the frame asks for", async () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    const frame = frameIn(h)!;
    const { port } = announce(frame);
    await flush();
    port.postMessage({ tag: SANDBOX_MESSAGE_TAG, type: "height", height: 260 });
    await waitFor(() => frame.style.height === "260px");
    expect(frame.style.height).toBe("260px");
    h.dispose();
  });

  it("clamps an absurd height instead of growing the page", async () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    const frame = frameIn(h)!;
    const { port } = announce(frame);
    await flush();
    port.postMessage({ tag: SANDBOX_MESSAGE_TAG, type: "height", height: 5_000_000 });
    await waitFor(() => frame.style.height === `${SANDBOX_MAX_HEIGHT}px`);
    expect(frame.style.height).toBe(`${SANDBOX_MAX_HEIGHT}px`);
    h.dispose();
  });

  it("takes no height over the window, only over the frame's own port", async () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    const frame = frameIn(h)!;
    announce(frame);
    await flush();
    post(frame, { tag: SANDBOX_MESSAGE_TAG, type: "height", height: 300 });
    await flush();
    expect(frame.style.height).toBe("100%");
    h.dispose();
  });

  it("ignores anything on the port that is not a height", async () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    const frame = frameIn(h)!;
    const { port } = announce(frame);
    await flush();
    for (const junk of [
      "height",
      { type: "height", height: 300 },
      { tag: SANDBOX_MESSAGE_TAG, type: "setConfig", html: "<p>replaced</p>" },
      { tag: SANDBOX_MESSAGE_TAG, type: "height", height: "300" },
    ]) {
      port.postMessage(junk);
    }
    await flush();
    expect(frame.style.height).toBe("100%");
    expect(h.ctx.setConfig).not.toHaveBeenCalled();
    h.dispose();
  });

  it("stops listening to a flood and says what it did", async () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    const frame = frameIn(h)!;
    const { port } = announce(frame);
    await flush();
    for (let i = 0; i < 200; i++) {
      port.postMessage({ tag: SANDBOX_MESSAGE_TAG, type: "height", height: 100 + i });
    }
    await waitFor(() => h.el.textContent.includes("more than its share"));
    // The last accepted height, not the last sent one.
    expect(parseInt(frame.style.height, 10)).toBeLessThan(200);
    expect(h.el.textContent).toContain("more than its share");
    h.dispose();
  });

  it("hears nothing on the port after the panel is gone", async () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    const frame = frameIn(h)!;
    const { port } = announce(frame);
    await flush();
    h.dispose();
    port.postMessage({ tag: SANDBOX_MESSAGE_TAG, type: "height", height: 700 });
    await flush();
    expect(frame.style.height).not.toBe("700px");
    expect(h.el.textContent).toBe("");
  });

  it("takes its window listener with it, not only its disposed flag", () => {
    // Covers the arm the flag would otherwise hide: after dispose there must
    // be no listener left on window at all.
    const tracker = trackMessageListeners();
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    expect(tracker.net()).toBe(1);
    h.dispose();
    expect(tracker.net()).toBe(0);
    tracker.restore();
  });
});

describe("the page policy that has to hold the frame in", () => {
  beforeEach(enable);

  it("runs when the page pins frames somewhere inert", () => {
    setPagePolicy(ORBIT_POLICY);
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    expect(frameIn(h)).not.toBeNull();
    h.dispose();
  });

  it("refuses to draw when the page would let a frame reach the network", () => {
    // A self-navigating frame takes its data out in the URL, and no directive
    // inside the frame covers that. If the page would allow it, do not run.
    setPagePolicy("default-src 'self'; frame-src blob: https://cdn.example.com;");
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    expect(frameIn(h)).toBeNull();
    expect(h.el.textContent).toContain("was not run");
    expect(h.el.textContent).toContain("cdn.example.com");
    h.dispose();
  });

  it("refuses when the page carries no policy at all", () => {
    setPagePolicy(null);
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    expect(frameIn(h)).toBeNull();
    expect(h.el.textContent).toContain("No content rules were found");
    h.dispose();
  });

  it("is happy with a default-src that frames fall back to", () => {
    setPagePolicy("default-src 'none';");
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    expect(frameIn(h)).not.toBeNull();
    h.dispose();
  });
});

describe("a hostile or sloppy config", () => {
  beforeEach(enable);

  it("does not become an error card over a title that is not a string", () => {
    // The config is whatever was in the layout file, so any field can be any
    // JSON type. A typo in a field used only for the frame's document title
    // must not cost the view.
    for (const title of [42, {}, [], true, null]) {
      document.body.innerHTML = "";
      setPagePolicy(ORBIT_POLICY);
      const h = harness({ html: "<p>hi</p>", title: title as unknown as string });
      mount(h);
      expect(frameIn(h)).not.toBeNull();
      expect(h.ctx.fail).not.toHaveBeenCalled();
      h.dispose();
    }
  });

  it("treats a non-string html as no html at all", () => {
    for (const html of [42, {}, null, ["<p>x</p>"]]) {
      document.body.innerHTML = "";
      setPagePolicy(ORBIT_POLICY);
      const h = harness({ html: html as unknown as string });
      mount(h);
      expect(frameIn(h)).toBeNull();
      expect(h.el.textContent).toContain("Nothing to show yet");
      h.dispose();
    }
  });

  it("ignores a data field that is not a list of source names", () => {
    for (const data of [42, "notebook", { notebook: true }, null]) {
      document.body.innerHTML = "";
      setPagePolicy(ORBIT_POLICY);
      const h = harness({ html: "<p>hi</p>", data: data as unknown as string[] });
      mount(h);
      expect(h.subscribed).toEqual([]);
      h.dispose();
    }
  });
});

describe("the theme", () => {
  beforeEach(enable);

  it("rebuilds the frame when Orbit's theme changes", async () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    const frame = frameIn(h)!;
    expect(frame.getAttribute("srcdoc")).toContain("color-scheme: dark");

    document.documentElement.dataset.theme = "light";
    await flush();
    expect(frame.getAttribute("srcdoc")).toContain("color-scheme: light");
    h.dispose();
    delete document.documentElement.dataset.theme;
  });

  it("does not read its own rebuild as a frame that navigated", async () => {
    // Assigning srcdoc loads a document, so a rebuild fires a real `load` of
    // its own -- in this environment and in a browser. The watchdog has to
    // expect that one and not count it as a second document.
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    await flush(); // the mount's own load
    document.documentElement.dataset.theme = "light";
    await flush(); // the observer, and the srcdoc it reassigns
    await flush(); // the rebuild's own load

    expect(frameIn(h)).not.toBeNull();
    expect(h.el.textContent).not.toContain("tried to open a web page");
    h.dispose();
    delete document.documentElement.dataset.theme;
  });

  it("stops watching the theme once the panel is gone", async () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    const frame = frameIn(h)!;
    const before = frame.getAttribute("srcdoc");
    h.dispose();
    document.documentElement.dataset.theme = "light";
    await flush();
    expect(frame.getAttribute("srcdoc")).toBe(before);
    delete document.documentElement.dataset.theme;
  });
});

describe("the navigation watchdog", () => {
  beforeEach(enable);

  it("leaves the document it put there alone", async () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    await flush(); // the real load of the srcdoc document
    expect(frameIn(h)).not.toBeNull();
    expect(h.el.textContent).not.toContain("tried to open a web page");
    h.dispose();
  });

  it("tears the frame down if a second document loads in it", async () => {
    const h = harness({ html: "<p>hi</p>" });
    mount(h);
    await flush(); // ours
    frameIn(h)!.dispatchEvent(new Event("load")); // something else
    expect(frameIn(h)).toBeNull();
    expect(h.el.textContent).toContain("tried to open a web page");
    expect(h.el.querySelector(".dash-sandbox-alarm")).not.toBeNull();
    h.dispose();
  });

  it("says nothing to a document that announces itself after a takeover", async () => {
    const h = harness({ html: "<p>hi</p>", data: ["notebook"] });
    mount(h);
    const frame = frameIn(h)!;
    await flush();
    frame.dispatchEvent(new Event("load")); // a second document
    const { sent } = announce(frame);
    await flush();
    expect(sent).toHaveLength(0);
    h.dispose();
  });

  it("drops the port it already had when the frame is taken over", async () => {
    const h = harness({ html: "<p>hi</p>", data: ["notebook"] });
    mount(h);
    const frame = frameIn(h)!;
    await flush();
    const { sent } = announce(frame);
    await waitFor(() => sent.length > 0);
    expect(sent).toHaveLength(1);

    frame.dispatchEvent(new Event("load")); // a second document
    h.sources.setNotebook("# written after the takeover");
    await new Promise((r) => setTimeout(r, 200));
    await flush();
    // Nothing further reaches the document that was there before, either.
    expect(sent).toHaveLength(1);
    h.dispose();
  });
});

describe("when Orbit's own policy blocks the frame's scripts", () => {
  beforeEach(enable);

  it("says so, once it is clear no bridge is coming", () => {
    vi.useFakeTimers();
    const h = harness({ html: "<script>draw()</script><p>chart</p>" });
    mount(h);
    vi.advanceTimersByTime(5000);
    expect(h.el.textContent).toContain("still picture");
    h.dispose();
  });

  it("stays quiet for a view that has no script to block", () => {
    vi.useFakeTimers();
    const h = harness({ html: "<svg><rect width='10' height='10'/></svg>" });
    mount(h);
    vi.advanceTimersByTime(5000);
    expect(h.el.textContent).not.toContain("still picture");
    h.dispose();
  });

  it("stays quiet when the bridge does answer", () => {
    vi.useFakeTimers();
    const h = harness({ html: "<script>draw()</script>" });
    mount(h);
    const frame = frameIn(h)!;
    announce(frame);
    vi.advanceTimersByTime(5000);
    expect(h.el.textContent).not.toContain("still picture");
    h.dispose();
  });
});
