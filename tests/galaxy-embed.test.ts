/**
 * Tests for the Phase 2 embed helpers: absolute embed-URL construction, the
 * shell-neutral NotebookEmbed projection + contract round-trip, and the
 * embed-token refresh-timing math.
 */

import { describe, expect, it } from "vitest";
import {
  buildNotebookEmbed,
  getEmbedUrl,
  refreshDelayMs,
  shouldRefreshToken,
  DEFAULT_REFRESH_SKEW_MS,
} from "../extensions/loom/galaxy-embed";
import type { GalaxyPageBindingYaml } from "../extensions/loom/galaxy-page-binding";
import { decodeNotebookEmbed, encodeNotebookEmbed } from "../shared/loom-shell-contract.js";

function binding(overrides: Partial<GalaxyPageBindingYaml> = {}): GalaxyPageBindingYaml {
  return {
    pageId: "adb5f5c93f827949",
    pageSlug: "my-analysis",
    galaxyServerUrl: "https://usegalaxy.org",
    historyId: "hist-1",
    lastSyncedRevision: null,
    boundAt: "2026-06-20T11:00:00Z",
    ...overrides,
  };
}

describe("getEmbedUrl", () => {
  it("builds the absolute chrome-free published-page URL", () => {
    expect(getEmbedUrl(binding())).toBe(
      "https://usegalaxy.org/published/page?id=adb5f5c93f827949&embed=true",
    );
  });

  it("trims a trailing slash off the server URL", () => {
    expect(getEmbedUrl(binding({ galaxyServerUrl: "https://usegalaxy.org/" }))).toBe(
      "https://usegalaxy.org/published/page?id=adb5f5c93f827949&embed=true",
    );
  });

  it("honors a deployment prefix in the server URL", () => {
    expect(getEmbedUrl(binding({ galaxyServerUrl: "https://example.org/galaxy" }))).toBe(
      "https://example.org/galaxy/published/page?id=adb5f5c93f827949&embed=true",
    );
  });

  it("appends rev and embed_origin when given", () => {
    const url = getEmbedUrl(binding(), { rev: "rev-9", embedOrigin: "app://orbit" });
    expect(url).toBe(
      "https://usegalaxy.org/published/page?id=adb5f5c93f827949&embed=true&rev=rev-9&embed_origin=app%3A%2F%2Forbit",
    );
  });

  it("omits rev/embed_origin when null or absent", () => {
    expect(getEmbedUrl(binding(), { rev: null, embedOrigin: null })).toBe(
      "https://usegalaxy.org/published/page?id=adb5f5c93f827949&embed=true",
    );
  });
});

describe("buildNotebookEmbed", () => {
  it("projects a binding into the embed payload, embedding lastSyncedRevision as rev", () => {
    const payload = buildNotebookEmbed(binding({ lastSyncedRevision: "rev-3" }));
    expect(payload).toEqual({
      bound: true,
      pageId: "adb5f5c93f827949",
      historyId: "hist-1",
      galaxyUrl: "https://usegalaxy.org",
      embedUrl: "https://usegalaxy.org/published/page?id=adb5f5c93f827949&embed=true&rev=rev-3",
      lastSyncedRevision: "rev-3",
    });
  });

  it("forwards embed_origin into the embedUrl", () => {
    const payload = buildNotebookEmbed(binding(), { embedOrigin: "app://orbit" });
    expect(payload.embedUrl).toContain("embed_origin=app%3A%2F%2Forbit");
  });

  it("returns the unbound payload for a null binding", () => {
    expect(buildNotebookEmbed(null)).toEqual({
      bound: false,
      pageId: null,
      historyId: null,
      galaxyUrl: null,
      embedUrl: null,
      lastSyncedRevision: null,
    });
  });

  it("round-trips through the shell contract", () => {
    const payload = buildNotebookEmbed(binding({ lastSyncedRevision: "rev-3" }));
    expect(decodeNotebookEmbed(encodeNotebookEmbed(payload))).toEqual(payload);
  });
});

describe("embed-token refresh timing", () => {
  const NOW = Date.parse("2026-06-20T12:00:00Z");

  it("does not refresh while comfortably before expiry", () => {
    const expiresAt = new Date(NOW + 10 * 60_000).toISOString(); // +10 min
    expect(shouldRefreshToken(expiresAt, NOW)).toBe(false);
    expect(refreshDelayMs(expiresAt, NOW)).toBe(10 * 60_000 - DEFAULT_REFRESH_SKEW_MS);
  });

  it("refreshes once inside the skew window", () => {
    const expiresAt = new Date(NOW + 30_000).toISOString(); // +30s, inside 60s skew
    expect(shouldRefreshToken(expiresAt, NOW)).toBe(true);
    expect(refreshDelayMs(expiresAt, NOW)).toBe(0);
  });

  it("refreshes immediately for an already-expired token", () => {
    const expiresAt = new Date(NOW - 60_000).toISOString();
    expect(shouldRefreshToken(expiresAt, NOW)).toBe(true);
    expect(refreshDelayMs(expiresAt, NOW)).toBe(0);
  });

  it("treats an unparseable expiry as refresh-now", () => {
    expect(shouldRefreshToken("not-a-date", NOW)).toBe(true);
    expect(refreshDelayMs("not-a-date", NOW)).toBe(0);
  });

  it("honors a custom skew", () => {
    const expiresAt = new Date(NOW + 4 * 60_000).toISOString(); // +4 min
    expect(shouldRefreshToken(expiresAt, NOW, 5 * 60_000)).toBe(true);
    expect(shouldRefreshToken(expiresAt, NOW, 2 * 60_000)).toBe(false);
  });

  // Galaxy serializes expires_at as naive UTC with no Z/offset. Treating that
  // as local time on a UTC+N host computes an expiry hours in the past and
  // spins a hot re-mint loop (LOOM Bug 2) — so a tz-less stamp must parse UTC.
  it("treats a timezone-less expiry as UTC, not local", () => {
    // +10 min from NOW, rendered tz-less (drop the trailing Z) as Galaxy does.
    const tzless = new Date(NOW + 10 * 60_000).toISOString().replace(/Z$/, "");
    expect(tzless).not.toMatch(/[zZ]|[+-]\d\d:\d\d$/);
    expect(shouldRefreshToken(tzless, NOW)).toBe(false);
    expect(refreshDelayMs(tzless, NOW)).toBe(10 * 60_000 - DEFAULT_REFRESH_SKEW_MS);
  });

  it("parses Galaxy's microsecond, tz-less expires_at without flooring to now", () => {
    // Exactly the shape Galaxy emits: 6 fractional digits, no offset.
    const expiresAt = "2026-06-20T12:10:00.134849";
    expect(shouldRefreshToken(expiresAt, NOW)).toBe(false);
    expect(refreshDelayMs(expiresAt, NOW)).toBeGreaterThan(0);
  });

  it("respects an explicit offset (incl. no-colon form) rather than re-stamping UTC", () => {
    // +00:00 / +0000 mean the same instant as the tz-less-treated-as-UTC stamp;
    // the offset must be honored, not clobbered with a trailing Z.
    expect(refreshDelayMs("2026-06-20T12:10:00+00:00", NOW)).toBe(
      refreshDelayMs("2026-06-20T12:10:00", NOW),
    );
    expect(refreshDelayMs("2026-06-20T12:10:00+0000", NOW)).toBe(
      refreshDelayMs("2026-06-20T12:10:00", NOW),
    );
    // A real offset shifts the instant: +02:00 expiry is 2h earlier in UTC.
    expect(refreshDelayMs("2026-06-20T14:10:00+02:00", NOW)).toBe(
      refreshDelayMs("2026-06-20T12:10:00", NOW),
    );
  });
});
