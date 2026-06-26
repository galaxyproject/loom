/**
 * Phase 3 token transport (brain side): the embed-token bridge drives the token
 * lifecycle from notebook + connection state and emits each minted token on the
 * dedicated EmbedToken widget key — only while bound AND connected.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { captured, connected, currentNotebook } = vi.hoisted(() => ({
  captured: { listener: null as null | ((content: string) => void) },
  connected: { value: true },
  currentNotebook: { value: null as string | null },
}));

vi.mock("../extensions/loom/state.js", () => ({
  onNotebookChange: (listener: (content: string) => void) => {
    captured.listener = listener;
    return () => {};
  },
  isGalaxyEffectivelyConnected: () => connected.value,
  readCurrentNotebook: () => currentNotebook.value,
}));

import { setupEmbedTokenBridge } from "../extensions/loom/embed-token-bridge";
import { renderGalaxyPageBlock } from "../extensions/loom/galaxy-page-binding";
import { decodeEmbedToken, LoomWidgetKey } from "../shared/loom-shell-contract.js";
import type { GalaxyEmbedToken } from "../extensions/loom/galaxy-pages-api";

const TTL_MS = 15 * 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-20T12:00:00Z"));
  captured.listener = null;
  connected.value = true;
  currentNotebook.value = null;
});

afterEach(() => {
  vi.useRealTimers();
});

function fakePi() {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const pi = { on: (evt: string, h: (...a: any[]) => any) => (handlers[evt] = h) } as any;
  return { pi, handlers };
}

/** Mint stub echoing the page id so tests can assert which page was minted. */
function echoMint() {
  return vi.fn(async (pageId: string): Promise<GalaxyEmbedToken> => {
    return { token: `tok-${pageId}`, expires_at: new Date(Date.now() + TTL_MS).toISOString() };
  });
}

function bindingBlock(pageId: string): string {
  return renderGalaxyPageBlock({
    pageId,
    pageSlug: null,
    galaxyServerUrl: "https://usegalaxy.org",
    historyId: "hist-1",
    lastSyncedRevision: null,
    boundAt: "2026-06-20T11:00:00Z",
  });
}

function start(mint = echoMint()) {
  const { pi, handlers } = fakePi();
  setupEmbedTokenBridge(pi, { mint });
  const setWidget = vi.fn();
  handlers["before_agent_start"]({}, { ui: { setWidget } });
  return { setWidget, mint, handlers };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

function lastToken(setWidget: ReturnType<typeof vi.fn>) {
  const call = [...setWidget.mock.calls].reverse().find((c) => c[0] === LoomWidgetKey.EmbedToken);
  return call ? decodeEmbedToken(call[1]) : null;
}

describe("embed token bridge", () => {
  it("mints and emits on the EmbedToken key when bound and connected", async () => {
    const { setWidget, mint } = start();
    captured.listener!(`# a\n\n${bindingBlock("page-1")}`);
    await flush();

    expect(mint).toHaveBeenCalledWith("page-1", expect.any(AbortSignal));
    expect(lastToken(setWidget)).toEqual({
      pageId: "page-1",
      token: "tok-page-1",
      expiresAt: new Date(Date.parse("2026-06-20T12:00:00Z") + TTL_MS).toISOString(),
    });
  });

  it("does not mint while disconnected, even when bound", async () => {
    connected.value = false;
    const { setWidget, mint } = start();
    captured.listener!(bindingBlock("page-1"));
    await flush();

    expect(mint).not.toHaveBeenCalled();
    expect(lastToken(setWidget)).toBeNull();
  });

  it("does not mint for an unbound notebook", async () => {
    const { setWidget, mint } = start();
    captured.listener!("# just prose, no binding\n");
    await flush();

    expect(mint).not.toHaveBeenCalled();
    expect(lastToken(setWidget)).toBeNull();
  });

  it("mints on session_start for an already-bound notebook (resume — Bug 3)", async () => {
    // No notebook change fires on a --continue resume; the manager must pick up
    // the inherited binding from the current notebook content.
    currentNotebook.value = bindingBlock("page-resumed");
    const mint = echoMint();
    const { pi, handlers } = fakePi();
    setupEmbedTokenBridge(pi, { mint });
    const setWidget = vi.fn();
    handlers["session_start"]({}, { ui: { setWidget } });
    await flush();

    expect(mint).toHaveBeenCalledWith("page-resumed", expect.any(AbortSignal));
    expect(lastToken(setWidget)).toMatchObject({
      pageId: "page-resumed",
      token: "tok-page-resumed",
    });
  });

  it("does not mint on session_start while disconnected", async () => {
    connected.value = false;
    currentNotebook.value = bindingBlock("page-resumed");
    const mint = echoMint();
    const { pi, handlers } = fakePi();
    setupEmbedTokenBridge(pi, { mint });
    const setWidget = vi.fn();
    handlers["session_start"]({}, { ui: { setWidget } });
    await flush();

    expect(mint).not.toHaveBeenCalled();
  });

  it("re-points at the new page when the binding changes", async () => {
    const { setWidget, mint } = start();
    captured.listener!(bindingBlock("page-1"));
    await flush();
    captured.listener!(bindingBlock("page-2"));
    await flush();

    expect(mint.mock.calls.map((c) => c[0])).toEqual(["page-1", "page-2"]);
    expect(lastToken(setWidget)).toMatchObject({ pageId: "page-2", token: "tok-page-2" });
  });
});
