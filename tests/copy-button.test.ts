import { describe, expect, it } from "vitest";
import {
  computeCopyButtonPlacement,
  CopyButtonDismissal,
  selectionSignaturesEqual,
  type CopyButtonInput,
  type SelectionSignature,
} from "../app/src/renderer/chat/copy-button.js";

const VIEWPORT = { width: 1000, height: 800 };

function input(overrides: Partial<CopyButtonInput> = {}): CopyButtonInput {
  return {
    isCollapsed: false,
    rangeCount: 1,
    inContainer: true,
    rect: { top: 100, bottom: 120, right: 300, width: 200, height: 20 },
    container: { top: 0, bottom: 800, left: 0, right: 1000 },
    viewport: VIEWPORT,
    ...overrides,
  };
}

describe("computeCopyButtonPlacement", () => {
  it("shows the button below a normal selection", () => {
    const p = computeCopyButtonPlacement(input());
    expect(p).toEqual({ hidden: false, top: 124, left: 220 });
  });

  it("hides when the selection is collapsed", () => {
    expect(computeCopyButtonPlacement(input({ isCollapsed: true }))).toEqual({
      hidden: true,
    });
  });

  it("hides when there is no range", () => {
    expect(computeCopyButtonPlacement(input({ rangeCount: 0 }))).toEqual({
      hidden: true,
    });
  });

  it("hides when the selection is outside the chat container", () => {
    expect(computeCopyButtonPlacement(input({ inContainer: false }))).toEqual({
      hidden: true,
    });
  });

  it("hides when the selection's client rect has zero area", () => {
    const rect = { top: 0, bottom: 0, right: 0, width: 0, height: 0 };
    expect(computeCopyButtonPlacement(input({ rect }))).toEqual({
      hidden: true,
    });
  });

  it("flips the button above the selection when it would overflow the bottom", () => {
    const rect = { top: 760, bottom: 780, right: 300, width: 200, height: 20 };
    expect(computeCopyButtonPlacement(input({ rect }))).toEqual({
      hidden: false,
      top: 728,
      left: 220,
    });
  });

  it("clamps the left edge so the button stays on-screen at the far left", () => {
    const rect = { top: 100, bottom: 120, right: 40, width: 30, height: 20 };
    expect(computeCopyButtonPlacement(input({ rect }))).toMatchObject({
      hidden: false,
      left: 4,
    });
  });

  it("clamps the left edge so the button stays on-screen at the far right", () => {
    const rect = { top: 100, bottom: 120, right: 1000, width: 200, height: 20 };
    expect(computeCopyButtonPlacement(input({ rect }))).toMatchObject({
      hidden: false,
      left: 916,
    });
  });

  // The bug: position is viewport-relative, so the same selection at a
  // scrolled-up rect must yield a different top. This is what makes
  // recomputing on scroll meaningful instead of leaving a stranded button.
  it("follows the selection when it scrolls (different rect -> different top)", () => {
    const before = computeCopyButtonPlacement(
      input({ rect: { top: 380, bottom: 400, right: 300, width: 200, height: 20 } }),
    );
    const after = computeCopyButtonPlacement(
      input({ rect: { top: 180, bottom: 200, right: 300, width: 200, height: 20 } }),
    );
    expect(before).toEqual({ hidden: false, top: 404, left: 220 });
    expect(after).toEqual({ hidden: false, top: 204, left: 220 });
  });

  // #299: the chat container is the scroller, so a live selection can scroll
  // out of the visible scrollport. The button must hide rather than strand at a
  // stale position over the rest of the pane.
  it("hides when the selection has scrolled above the chat scrollport", () => {
    const container = { top: 100, bottom: 700, left: 0, right: 1000 };
    const rect = { top: 30, bottom: 50, right: 300, width: 200, height: 20 };
    expect(computeCopyButtonPlacement(input({ container, rect }))).toEqual({ hidden: true });
  });

  it("hides when the selection has scrolled below the chat scrollport", () => {
    const container = { top: 100, bottom: 700, left: 0, right: 1000 };
    const rect = { top: 740, bottom: 760, right: 300, width: 200, height: 20 };
    expect(computeCopyButtonPlacement(input({ container, rect }))).toEqual({ hidden: true });
  });

  it("stays shown when the selection straddles the scrollport's top edge (still partly visible)", () => {
    const container = { top: 100, bottom: 700, left: 0, right: 1000 };
    const rect = { top: 80, bottom: 140, right: 300, width: 200, height: 60 };
    expect(computeCopyButtonPlacement(input({ container, rect }))).toMatchObject({ hidden: false });
  });

  // #339: a selection inside a wide / horizontally-scrollable block (e.g. a long
  // line in a code block) lays its text out far beyond the visible chat panel --
  // Range rects aren't clipped by ancestor overflow. Clamping to the viewport
  // alone flings the button into the right-hand pane. It must clamp to the chat
  // container's right edge instead.
  it("clamps the right edge to the chat container, not the viewport, when the selection overflows right", () => {
    const container = { top: 0, bottom: 800, left: 0, right: 600 };
    const rect = { top: 100, bottom: 120, right: 1400, width: 1200, height: 20 };
    expect(computeCopyButtonPlacement(input({ container, rect }))).toEqual({
      hidden: false,
      top: 124,
      left: 516,
    });
  });

  // The container can be inset from the viewport's left edge too (a left gutter
  // or shell). The left clamp must use the container's left, not the viewport's.
  it("clamps the left edge to the chat container when the container is inset from the left", () => {
    const container = { top: 0, bottom: 800, left: 300, right: 1000 };
    const rect = { top: 100, bottom: 120, right: 320, width: 20, height: 20 };
    expect(computeCopyButtonPlacement(input({ container, rect }))).toEqual({
      hidden: false,
      top: 124,
      left: 304,
    });
  });
});

// #377: clicking anywhere outside the button must dismiss it for good, even
// when the click leaves the document selection intact (non-selectable UI
// chrome, the chat input, a scrollbar). Node identity stands in for real DOM
// nodes -- the signature only ever compares by reference.
function sig(node: unknown, a = 0, f = 5): SelectionSignature {
  return { anchorNode: node, anchorOffset: a, focusNode: node, focusOffset: f };
}

describe("selectionSignaturesEqual", () => {
  const node = {};

  it("treats two nulls as equal and null vs a signature as different", () => {
    expect(selectionSignaturesEqual(null, null)).toBe(true);
    expect(selectionSignaturesEqual(null, sig(node))).toBe(false);
    expect(selectionSignaturesEqual(sig(node), null)).toBe(false);
  });

  it("compares nodes by identity and offsets by value", () => {
    expect(selectionSignaturesEqual(sig(node), sig(node))).toBe(true);
    expect(selectionSignaturesEqual(sig(node), sig({}))).toBe(false);
    expect(selectionSignaturesEqual(sig(node, 0, 5), sig(node, 0, 6))).toBe(false);
    expect(selectionSignaturesEqual(sig(node, 1, 5), sig(node, 0, 5))).toBe(false);
  });
});

describe("CopyButtonDismissal", () => {
  const r1 = sig({});
  const r2 = sig({});

  it("suppresses nothing until a dismissal happens", () => {
    const d = new CopyButtonDismissal();
    expect(d.suppresses(r1)).toBe(false);
    expect(d.suppresses(null)).toBe(false);
  });

  it("keeps the button dismissed when a click leaves the selection untouched (non-selectable chrome)", () => {
    const d = new CopyButtonDismissal();
    d.suppress(r1);
    // No selectionchange fires at all -- mouseup re-validation must not re-show.
    expect(d.suppresses(r1)).toBe(true);
  });

  it("keeps the button dismissed when only a text control's internal selection changes (chat input click)", () => {
    const d = new CopyButtonDismissal();
    d.suppress(r1);
    // Chromium fires document selectionchange for textarea caret moves, but the
    // document selection itself is unchanged.
    d.noteSelectionChange(r1);
    expect(d.suppresses(r1)).toBe(true);
  });

  it("does not suppress a different selection", () => {
    const d = new CopyButtonDismissal();
    d.suppress(r1);
    expect(d.suppresses(r2)).toBe(false);
  });

  it("lifts suppression when the selection collapses, so re-selecting the same text shows again", () => {
    const d = new CopyButtonDismissal();
    d.suppress(r1);
    // Drag re-select: browser collapses the selection on mousedown-in-text...
    d.noteSelectionChange(null);
    // ...then the drag rebuilds the exact same range.
    d.noteSelectionChange(r1);
    expect(d.suppresses(r1)).toBe(false);
  });

  it("lifts suppression when the selection actually changes (new drag or keyboard extension)", () => {
    const d = new CopyButtonDismissal();
    d.suppress(r1);
    d.noteSelectionChange(r2);
    expect(d.suppresses(r2)).toBe(false);
    expect(d.suppresses(r1)).toBe(false);
  });

  it("clears any prior suppression when dismissing with no selection", () => {
    const d = new CopyButtonDismissal();
    d.suppress(r1);
    d.suppress(null);
    expect(d.suppresses(r1)).toBe(false);
    expect(d.suppresses(null)).toBe(false);
  });
});
