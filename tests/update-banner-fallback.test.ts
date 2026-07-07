// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import {
  showReleaseFallback,
  clearReleaseFallback,
  openReleaseWithFallback,
  copyToClipboard,
  NEUTRAL_FALLBACK_NOTE,
  OPEN_FAILED_FALLBACK_NOTE,
} from "../app/src/renderer/update-banner.js";

describe("showReleaseFallback", () => {
  let banner: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = `<div id="update-banner"></div>`;
    banner = document.getElementById("update-banner")!;
  });

  it("reveals the release URL as selectable text inside the banner", () => {
    const url = "https://github.com/galaxyproject/loom/releases/tag/v0.5.2";
    showReleaseFallback(banner, url);
    const fallback = banner.querySelector(".update-banner-fallback");
    expect(fallback).not.toBeNull();
    expect(fallback!.textContent).toContain(url);
  });

  it("puts the exact URL in a dedicated selectable element", () => {
    const url = "https://github.com/galaxyproject/loom/releases/latest";
    showReleaseFallback(banner, url);
    const urlEl = banner.querySelector(".update-banner-fallback-url");
    expect(urlEl).not.toBeNull();
    expect(urlEl!.textContent).toBe(url);
  });

  it("uses a neutral note by default (no failure is asserted on a plain reveal)", () => {
    showReleaseFallback(banner, "https://github.com/galaxyproject/loom/releases/latest");
    expect(banner.querySelector(".update-banner-fallback-note")!.textContent).toBe(
      NEUTRAL_FALLBACK_NOTE,
    );
  });

  it("shows the given note when the open is a confirmed failure", () => {
    showReleaseFallback(
      banner,
      "https://github.com/galaxyproject/loom/releases/latest",
      OPEN_FAILED_FALLBACK_NOTE,
    );
    expect(banner.querySelector(".update-banner-fallback-note")!.textContent).toBe(
      OPEN_FAILED_FALLBACK_NOTE,
    );
  });

  it("resets a stale failure note back to neutral on a later success", () => {
    const url = "https://github.com/galaxyproject/loom/releases/latest";
    showReleaseFallback(banner, url, OPEN_FAILED_FALLBACK_NOTE);
    showReleaseFallback(banner, url); // e.g. a retry that opened successfully
    expect(banner.querySelector(".update-banner-fallback-note")!.textContent).toBe(
      NEUTRAL_FALLBACK_NOTE,
    );
  });

  it("is idempotent -- a second call reuses the element and updates the URL", () => {
    showReleaseFallback(banner, "https://github.com/galaxyproject/loom/releases/tag/v1");
    showReleaseFallback(banner, "https://github.com/galaxyproject/loom/releases/tag/v2");
    expect(banner.querySelectorAll(".update-banner-fallback").length).toBe(1);
    expect(banner.querySelector(".update-banner-fallback-url")!.textContent).toBe(
      "https://github.com/galaxyproject/loom/releases/tag/v2",
    );
  });

  it("clearReleaseFallback removes a shown fallback and is a no-op when absent", () => {
    clearReleaseFallback(banner); // absent: must not throw
    showReleaseFallback(banner, "https://github.com/galaxyproject/loom/releases/latest");
    expect(banner.querySelector(".update-banner-fallback")).not.toBeNull();
    clearReleaseFallback(banner);
    expect(banner.querySelector(".update-banner-fallback")).toBeNull();
  });

  it("offers a copy button that copies the URL to the clipboard", async () => {
    const url = "https://github.com/galaxyproject/loom/releases/latest";
    let copied: string | null = null;
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (t: string) => {
          copied = t;
        },
      },
    });
    showReleaseFallback(banner, url);
    const copyBtn = banner.querySelector<HTMLButtonElement>(".update-banner-fallback-copy")!;
    expect(copyBtn).not.toBeNull();
    copyBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(copied).toBe(url);
  });
});

describe("openReleaseWithFallback", () => {
  let banner: HTMLElement;
  const url = "https://github.com/galaxyproject/loom/releases/tag/v0.5.2";

  beforeEach(() => {
    document.body.innerHTML = `<div id="update-banner"></div>`;
    banner = document.getElementById("update-banner")!;
  });

  const noteText = () => banner.querySelector(".update-banner-fallback-note")!.textContent;

  it("keeps the copyable link visible with a neutral note when the open reports success", async () => {
    // The WSLg regression: shell.openExternal can resolve { opened: true }
    // without a browser ever appearing. The link must still be reachable and
    // must NOT claim a failure.
    await openReleaseWithFallback(banner, url, async () => ({ opened: true, url }));
    expect(banner.querySelector(".update-banner-fallback-url")!.textContent).toBe(url);
    expect(noteText()).toBe(NEUTRAL_FALLBACK_NOTE);
  });

  it("escalates the note to the failure message when the open reports it didn't open", async () => {
    await openReleaseWithFallback(banner, url, async () => ({ opened: false, url }));
    expect(banner.querySelector(".update-banner-fallback-url")!.textContent).toBe(url);
    expect(noteText()).toBe(OPEN_FAILED_FALLBACK_NOTE);
  });

  it("escalates the note to the failure message when the open call rejects", async () => {
    await openReleaseWithFallback(banner, url, async () => {
      throw new Error("no browser");
    });
    expect(banner.querySelector(".update-banner-fallback-url")!.textContent).toBe(url);
    expect(noteText()).toBe(OPEN_FAILED_FALLBACK_NOTE);
  });

  it("reveals the link before awaiting the open, so a hung open still isn't a dead end", () => {
    let resolveOpen: (v: { opened: boolean }) => void = () => {};
    const pending = openReleaseWithFallback(
      banner,
      url,
      () => new Promise((res) => (resolveOpen = res)),
    );
    // Synchronously after the call, before the open settles, the URL is shown.
    expect(banner.querySelector(".update-banner-fallback-url")!.textContent).toBe(url);
    resolveOpen({ opened: true });
    return pending;
  });
});

describe("copyToClipboard", () => {
  it("writes the text through the async clipboard API and reports success", async () => {
    let copied: string | null = null;
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (t: string) => {
          copied = t;
        },
      },
    });
    const ok = await copyToClipboard("hello");
    expect(ok).toBe(true);
    expect(copied).toBe("hello");
  });

  it("reports failure instead of throwing when the clipboard API is unavailable", async () => {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    await expect(copyToClipboard("hello")).resolves.toBe(false);
  });

  it("reports failure instead of throwing when writeText rejects", async () => {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    await expect(copyToClipboard("hello")).resolves.toBe(false);
  });
});
