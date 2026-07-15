// @vitest-environment happy-dom
//
// #377 regression tests for the floating selection-Copy button's dismissal
// wiring: these drive a real ChatPanel through document-level mousedown /
// mouseup / selectionchange events and the button's own click flow. The
// document selection and client rects are stubbed (happy-dom has no layout),
// which is exactly the seam the production code reads through.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../app/src/renderer/chat/chat-panel.js";

interface FakeSelection {
  isCollapsed: boolean;
  rangeCount: number;
  anchorNode: Node | null;
  anchorOffset: number;
  focusNode: Node | null;
  focusOffset: number;
  getRangeAt: (i: number) => unknown;
  removeAllRanges: () => void;
}

const COLLAPSED: FakeSelection = {
  isCollapsed: true,
  rangeCount: 0,
  anchorNode: null,
  anchorOffset: 0,
  focusNode: null,
  focusOffset: 0,
  getRangeAt: () => {
    throw new Error("no range");
  },
  removeAllRanges: () => {},
};

let currentSelection: FakeSelection = COLLAPSED;

function makeSelection(container: HTMLElement, text: string): FakeSelection {
  const node = document.createTextNode(text);
  container.appendChild(node);
  const range = {
    commonAncestorContainer: node,
    getBoundingClientRect: () => ({
      top: 100,
      bottom: 120,
      left: 100,
      right: 300,
      width: 200,
      height: 20,
    }),
    cloneContents: () => {
      const frag = document.createDocumentFragment();
      frag.appendChild(document.createTextNode(text));
      return frag;
    },
  };
  return {
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: node,
    anchorOffset: 0,
    focusNode: node,
    focusOffset: text.length,
    getRangeAt: () => range,
    removeAllRanges: vi.fn(),
  };
}

function setup(): { container: HTMLElement; btn: HTMLButtonElement } {
  const container = document.createElement("div");
  // happy-dom has no layout: give the chat scrollport a real viewport band so
  // computeCopyButtonPlacement sees the selection as visible inside it.
  container.getBoundingClientRect = () =>
    ({ top: 0, bottom: 700, left: 0, right: 900 }) as DOMRect;
  document.body.appendChild(container);
  new ChatPanel(container);
  const btn = document.querySelector<HTMLButtonElement>(".chat-copy-btn")!;
  expect(btn).not.toBeNull();
  return { container, btn };
}

function fire(target: EventTarget, type: string): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true }));
}

function selectionchange(): void {
  document.dispatchEvent(new Event("selectionchange"));
}

beforeEach(() => {
  document.body.innerHTML = "";
  currentSelection = COLLAPSED;
  vi.spyOn(window, "getSelection").mockImplementation(
    () => currentSelection as unknown as Selection,
  );
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("copy button dismissal on click-elsewhere (#377)", () => {
  it("stays dismissed after a click that leaves the selection intact (chrome / input / scrollbar)", () => {
    const { container, btn } = setup();
    currentSelection = makeSelection(container, "hello world");
    selectionchange();
    expect(btn.hidden).toBe(false);

    // Click on something non-selectable: mousedown hides, no selectionchange
    // fires, and the mouseup re-validation used to bring the button back.
    fire(document.body, "mousedown");
    expect(btn.hidden).toBe(true);
    fire(document.body, "mouseup");
    expect(btn.hidden).toBe(true);

    // Later re-validations (scroll, textarea-internal selectionchange) must
    // not resurrect it either while the selection is unchanged.
    selectionchange();
    expect(btn.hidden).toBe(true);
  });

  it("re-shows for a genuinely new selection after a dismissal", () => {
    const { container, btn } = setup();
    currentSelection = makeSelection(container, "first");
    selectionchange();
    fire(document.body, "mousedown");
    fire(document.body, "mouseup");
    expect(btn.hidden).toBe(true);

    currentSelection = makeSelection(container, "second");
    selectionchange();
    expect(btn.hidden).toBe(false);
  });

  it("re-shows when the same text is re-selected via a drag (collapse lifts suppression)", () => {
    const { container, btn } = setup();
    const sel = makeSelection(container, "same text");
    currentSelection = sel;
    selectionchange();
    fire(document.body, "mousedown");
    fire(document.body, "mouseup");
    expect(btn.hidden).toBe(true);

    // Drag over the same text again: mousedown, the browser collapses the
    // selection, the drag rebuilds the identical range, mouseup.
    fire(document.body, "mousedown");
    currentSelection = COLLAPSED;
    selectionchange();
    currentSelection = sel;
    selectionchange();
    fire(document.body, "mouseup");
    expect(btn.hidden).toBe(false);
  });
});

describe("copy button dismissal after clicking it (#377)", () => {
  function stubClipboard(ok: boolean): ReturnType<typeof vi.fn> {
    const writeText = ok
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    return writeText;
  }

  it("shows a confirmation beat then dismisses and clears the selection", async () => {
    const writeText = stubClipboard(true);
    const { container, btn } = setup();
    const sel = currentSelection = makeSelection(container, "copy me");
    selectionchange();

    fire(btn, "mousedown"); // on the button itself: must not dismiss
    expect(btn.hidden).toBe(false);
    btn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith("copy me");
    expect(btn.textContent).toContain("Copied");
    expect(btn.hidden).toBe(false);

    await vi.advanceTimersByTimeAsync(1200);
    expect(btn.hidden).toBe(true);
    expect(sel.removeAllRanges).toHaveBeenCalled();
  });

  it("dismisses honestly when the clipboard write is refused, keeping the selection", async () => {
    stubClipboard(false);
    const { container, btn } = setup();
    const sel = currentSelection = makeSelection(container, "copy me");
    selectionchange();

    btn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(btn.textContent).toContain("Copy failed");

    await vi.advanceTimersByTimeAsync(1200);
    expect(btn.hidden).toBe(true);
    expect(sel.removeAllRanges).not.toHaveBeenCalled();

    // The surviving selection stays dismissed on later re-validation...
    selectionchange();
    expect(btn.hidden).toBe(true);
    // ...but a new selection shows the button again.
    currentSelection = makeSelection(container, "another");
    selectionchange();
    expect(btn.hidden).toBe(false);
  });

  it("does not let the stale confirmation timer clobber a newer selection", async () => {
    stubClipboard(true);
    const { container, btn } = setup();
    const first = currentSelection = makeSelection(container, "first");
    selectionchange();
    btn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(btn.textContent).toContain("Copied");

    // During the beat the user selects something else.
    const second = (currentSelection = makeSelection(container, "second"));
    selectionchange();
    expect(btn.hidden).toBe(false);

    await vi.advanceTimersByTimeAsync(1200);
    expect(btn.hidden).toBe(false); // still up for the new selection
    expect(btn.textContent).toContain("Copy"); // label restored
    expect(second.removeAllRanges).not.toHaveBeenCalled();
    expect(first.removeAllRanges).not.toHaveBeenCalled();
  });

  it("does not clear a re-selection of the identical range made during the beat", async () => {
    stubClipboard(true);
    const { container, btn } = setup();
    const sel = (currentSelection = makeSelection(container, "same range"));
    selectionchange();
    btn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(btn.textContent).toContain("Copied");

    // Within the beat the user collapses and re-selects the exact same text:
    // identical signature, but a NEW selection the timer must not clear.
    currentSelection = COLLAPSED;
    selectionchange();
    currentSelection = sel;
    selectionchange();
    expect(btn.hidden).toBe(false);

    await vi.advanceTimersByTimeAsync(1200);
    expect(btn.hidden).toBe(false);
    expect(sel.removeAllRanges).not.toHaveBeenCalled();
  });

  it("does not suppress a re-selected identical range when a slow copy fails", async () => {
    let reject: (e: Error) => void = () => {};
    const writeText = vi.fn().mockImplementation(
      () => new Promise((_res, rej) => (reject = rej)),
    );
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const { container, btn } = setup();
    const sel = (currentSelection = makeSelection(container, "same range"));
    selectionchange();
    btn.click();

    // While the clipboard write is still pending, collapse and re-select the
    // identical range. The late failure must not suppress this new selection.
    currentSelection = COLLAPSED;
    selectionchange();
    currentSelection = sel;
    selectionchange();

    reject(new Error("denied"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1200);
    expect(btn.hidden).toBe(false);
    selectionchange();
    expect(btn.hidden).toBe(false);
  });

  it("hides instead of lingering when the selection vanished before the click lands", () => {
    stubClipboard(true);
    const { container, btn } = setup();
    currentSelection = makeSelection(container, "gone soon");
    selectionchange();
    expect(btn.hidden).toBe(false);

    currentSelection = COLLAPSED;
    btn.click();
    expect(btn.hidden).toBe(true);
  });
});
