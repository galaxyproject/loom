/**
 * Phase 3 token transport (main side): parse + hold the embed token the brain
 * pushes on the dedicated widget key, and never let a token-keyed message reach
 * the renderer (swallow even a malformed one).
 */

import { describe, expect, it, vi } from "vitest";
import {
  EmbedTokenStore,
  isEmbedTokenWidget,
  parseEmbedTokenWidget,
} from "../app/src/main/embed-token-store";
import {
  LoomWidgetKey,
  encodeEmbedToken,
  type EmbedTokenWidgetPayload,
} from "../shared/loom-shell-contract.js";

const PAYLOAD: EmbedTokenWidgetPayload = {
  pageId: "adb5f5c93f827949",
  token: "deadbeefdeadbeefdeadbeefdeadbeef",
  expiresAt: "2026-06-20T12:15:00Z",
};

function setWidget(key: string, lines: string[]): Record<string, unknown> {
  return { type: "extension_ui_request", method: "setWidget", widgetKey: key, widgetLines: lines };
}

describe("parseEmbedTokenWidget / isEmbedTokenWidget", () => {
  it("decodes a well-formed embed-token widget", () => {
    const data = setWidget(LoomWidgetKey.EmbedToken, encodeEmbedToken(PAYLOAD));
    expect(isEmbedTokenWidget(data)).toBe(true);
    expect(parseEmbedTokenWidget(data)).toEqual(PAYLOAD);
  });

  it("ignores a setWidget on a different key (forwarded to the renderer)", () => {
    const data = setWidget(LoomWidgetKey.Notebook, ["# hi"]);
    expect(isEmbedTokenWidget(data)).toBe(false);
    expect(parseEmbedTokenWidget(data)).toBeNull();
  });

  it("ignores a non-setWidget request", () => {
    const data = { type: "extension_ui_request", method: "notify", message: "hello" };
    expect(isEmbedTokenWidget(data)).toBe(false);
    expect(parseEmbedTokenWidget(data)).toBeNull();
  });

  it("matches the key but returns null for a malformed payload (still swallowed)", () => {
    const data = setWidget(LoomWidgetKey.EmbedToken, ["{not json"]);
    // Key matched → caller must swallow so a token-keyed message never leaks...
    expect(isEmbedTokenWidget(data)).toBe(true);
    // ...but there's nothing to store.
    expect(parseEmbedTokenWidget(data)).toBeNull();
  });
});

describe("EmbedTokenStore", () => {
  it("starts empty and holds the last set token", () => {
    const store = new EmbedTokenStore();
    expect(store.get()).toBeNull();
    store.set(PAYLOAD);
    expect(store.get()).toEqual(PAYLOAD);
  });

  it("notifies subscribers on set and clear", () => {
    const store = new EmbedTokenStore();
    const seen = vi.fn();
    store.onChange(seen);

    store.set(PAYLOAD);
    store.clear();

    expect(seen.mock.calls.map((c) => c[0])).toEqual([PAYLOAD, null]);
  });

  it("does not emit when clearing an already-empty store", () => {
    const store = new EmbedTokenStore();
    const seen = vi.fn();
    store.onChange(seen);
    store.clear();
    expect(seen).not.toHaveBeenCalled();
  });

  it("stops notifying after unsubscribe", () => {
    const store = new EmbedTokenStore();
    const seen = vi.fn();
    const off = store.onChange(seen);
    off();
    store.set(PAYLOAD);
    expect(seen).not.toHaveBeenCalled();
  });
});
