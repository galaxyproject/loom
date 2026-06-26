/**
 * Phase 3.1/3.2 notebook view-model: Markdown↔Galaxy mode persistence, Galaxy
 * availability, and the mode→view resolution incl. fallback states.
 */

import { describe, expect, it } from "vitest";
import {
  canUseGalaxyView,
  parseStoredViewMode,
  resolveNotebookView,
  shouldReloadEmbed,
  type NotebookEmbedState,
} from "../app/src/renderer/artifacts/notebook-view-model";
import type { NotebookEmbedPayload } from "../shared/loom-shell-contract.js";

const BOUND: NotebookEmbedPayload = {
  bound: true,
  pageId: "page-1",
  historyId: "hist-1",
  galaxyUrl: "https://usegalaxy.org",
  embedUrl: "https://usegalaxy.org/published/page?id=page-1&embed=true&rev=rev-3",
  lastSyncedRevision: "rev-3",
};

const UNBOUND: NotebookEmbedPayload = {
  bound: false,
  pageId: null,
  historyId: null,
  galaxyUrl: null,
  embedUrl: null,
  lastSyncedRevision: null,
};

function state(over: Partial<NotebookEmbedState> = {}): NotebookEmbedState {
  return { payload: BOUND, connected: true, ...over };
}

describe("parseStoredViewMode", () => {
  it("returns galaxy only for the exact stored value", () => {
    expect(parseStoredViewMode("galaxy")).toBe("galaxy");
  });

  it("defaults to markdown for null, empty, or anything else", () => {
    expect(parseStoredViewMode(null)).toBe("markdown");
    expect(parseStoredViewMode("")).toBe("markdown");
    expect(parseStoredViewMode("Galaxy")).toBe("markdown");
    expect(parseStoredViewMode("md")).toBe("markdown");
  });
});

describe("canUseGalaxyView", () => {
  it("is true only when connected, bound, and an embed URL exists", () => {
    expect(canUseGalaxyView(state())).toBe(true);
  });

  it("is false when disconnected, unbound, or missing an embed URL", () => {
    expect(canUseGalaxyView(state({ connected: false }))).toBe(false);
    expect(canUseGalaxyView(state({ payload: UNBOUND }))).toBe(false);
    expect(canUseGalaxyView(state({ payload: null }))).toBe(false);
    expect(canUseGalaxyView(state({ payload: { ...BOUND, embedUrl: null } }))).toBe(false);
  });
});

describe("resolveNotebookView", () => {
  it("always shows markdown in markdown mode, regardless of embed state", () => {
    expect(resolveNotebookView("markdown", state())).toEqual({ kind: "markdown" });
    expect(resolveNotebookView("markdown", state({ connected: false, payload: null }))).toEqual({
      kind: "markdown",
    });
  });

  it("shows the live embed in galaxy mode when ready", () => {
    expect(resolveNotebookView("galaxy", state())).toEqual({
      kind: "galaxy",
      embedUrl: BOUND.embedUrl,
    });
  });

  it("falls back to disconnected when galaxy mode but not connected", () => {
    expect(resolveNotebookView("galaxy", state({ connected: false }))).toEqual({
      kind: "fallback",
      reason: "disconnected",
    });
  });

  it("falls back to unbound when connected but no binding/embed URL", () => {
    expect(resolveNotebookView("galaxy", state({ payload: UNBOUND }))).toEqual({
      kind: "fallback",
      reason: "unbound",
    });
    expect(resolveNotebookView("galaxy", state({ payload: null }))).toEqual({
      kind: "fallback",
      reason: "unbound",
    });
  });
});

describe("shouldReloadEmbed", () => {
  it("reloads when the embed URL changes (e.g. a synced-revision bump)", () => {
    const next = { ...BOUND, embedUrl: BOUND.embedUrl.replace("rev-3", "rev-9") };
    expect(shouldReloadEmbed(BOUND, next)).toBe(true);
  });

  it("does not reload on a no-op re-emit with the same URL", () => {
    expect(shouldReloadEmbed(BOUND, { ...BOUND })).toBe(false);
  });

  it("reloads on first bind (null → bound)", () => {
    expect(shouldReloadEmbed(null, BOUND)).toBe(true);
    expect(shouldReloadEmbed(UNBOUND, BOUND)).toBe(true);
  });

  it("does not reload when the new payload has no embed URL", () => {
    expect(shouldReloadEmbed(BOUND, UNBOUND)).toBe(false);
    expect(shouldReloadEmbed(BOUND, null)).toBe(false);
  });
});
