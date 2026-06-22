/**
 * Auto-push bridge: drives the debounced push from notebook + connection state.
 * Pushes only a genuine edit to a bound + connected notebook; bind / resume /
 * re-bind primes the baseline without pushing, and disconnect / unbound never
 * pushes. The manager's real `stripHousekeepingBlocks` dedup is exercised here,
 * so a binding-only self-write does not loop.
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

import { setupAutoPushBridge } from "../extensions/loom/auto-push-bridge";
import { renderGalaxyPageBlock } from "../extensions/loom/galaxy-page-binding";

const DEBOUNCE = 10;

beforeEach(() => {
  vi.useFakeTimers();
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

function bindingBlock(pageId: string, rev: string | null = null): string {
  return renderGalaxyPageBlock({
    pageId,
    pageSlug: null,
    galaxyServerUrl: "https://usegalaxy.org",
    historyId: "hist-1",
    lastSyncedRevision: rev,
    boundAt: "2026-06-20T11:00:00Z",
  });
}

/** Notebook content = narrative body + the binding housekeeping block. */
function content(pageId: string | null, body: string, rev: string | null = null): string {
  const head = `# Notebook\n\n${body}\n`;
  return pageId ? `${head}\n${bindingBlock(pageId, rev)}` : head;
}

function start(push = vi.fn(async () => {})) {
  const { pi, handlers } = fakePi();
  setupAutoPushBridge(pi, { push, debounceMs: DEBOUNCE });
  return { push, handlers };
}

const settle = () => vi.advanceTimersByTimeAsync(DEBOUNCE + 1);

describe("auto-push bridge", () => {
  it("pushes a genuine edit to a bound, connected notebook", async () => {
    const { push } = start();
    captured.listener!(content("page-1", "first")); // bind -> prime
    await settle();
    expect(push).not.toHaveBeenCalled();

    captured.listener!(content("page-1", "edited")); // real edit -> push
    await settle();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("primes (does not push) on the first observation of a bound notebook", async () => {
    const { push } = start();
    captured.listener!(content("page-1", "body"));
    await settle();
    expect(push).not.toHaveBeenCalled();
  });

  it("does not loop on the push's own binding-only self-write", async () => {
    const { push } = start();
    captured.listener!(content("page-1", "body", "r1")); // prime
    await settle();
    captured.listener!(content("page-1", "changed", "r1")); // edit -> push
    await settle();
    expect(push).toHaveBeenCalledTimes(1);

    // Self-write: same body, bumped revision in the binding block only.
    captured.listener!(content("page-1", "changed", "r2"));
    await settle();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("does not push while disconnected", async () => {
    connected.value = false;
    const { push } = start();
    captured.listener!(content("page-1", "first"));
    await settle();
    captured.listener!(content("page-1", "edited"));
    await settle();
    expect(push).not.toHaveBeenCalled();
  });

  it("does not push for an unbound notebook", async () => {
    const { push } = start();
    captured.listener!(content(null, "just prose"));
    await settle();
    captured.listener!(content(null, "more prose"));
    await settle();
    expect(push).not.toHaveBeenCalled();
  });

  it("primes on session_start (resume) so the resume itself doesn't push", async () => {
    currentNotebook.value = content("page-resumed", "inherited");
    const { push, handlers } = start();
    await handlers["session_start"]({}, {});
    await settle();
    expect(push).not.toHaveBeenCalled();

    captured.listener!(content("page-resumed", "now edited"));
    await settle();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("re-primes (no push) when the binding changes to a new page", async () => {
    const { push } = start();
    captured.listener!(content("page-1", "body")); // prime page-1
    await settle();
    captured.listener!(content("page-2", "body")); // rebind -> prime, no push
    await settle();
    expect(push).not.toHaveBeenCalled();

    captured.listener!(content("page-2", "edited")); // edit on page-2 -> push
    await settle();
    expect(push).toHaveBeenCalledTimes(1);
  });
});
