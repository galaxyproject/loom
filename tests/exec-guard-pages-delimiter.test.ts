import { describe, it, expect } from "vitest";
import {
  wrapUntrustedRemoteBody,
  stripUntrustedMarkers,
} from "../extensions/loom/galaxy-pages-sync";

describe("wrapUntrustedRemoteBody", () => {
  it("brackets remote content with untrusted markers", () => {
    const out = wrapUntrustedRemoteBody("hello");
    expect(out).toMatch(/BEGIN UNTRUSTED GALAXY PAGE CONTENT/);
    expect(out).toMatch(/END UNTRUSTED GALAXY PAGE CONTENT/);
    expect(out).toContain("hello");
  });
  it("is idempotent (no marker accumulation on re-wrap)", () => {
    const once = wrapUntrustedRemoteBody("hello");
    const twice = wrapUntrustedRemoteBody(once);
    expect(twice).toBe(once);
  });
  it("stripUntrustedMarkers removes the markers (clean round-trip back to Galaxy)", () => {
    expect(stripUntrustedMarkers(wrapUntrustedRemoteBody("hello")).trim()).toBe("hello");
  });
});
