import { describe, it, expect } from "vitest";
import { validateGalaxyUrl, normalizeGalaxyUrl } from "../extensions/loom/profiles";

describe("validateGalaxyUrl", () => {
  it("accepts https://", () => {
    expect(validateGalaxyUrl("https://usegalaxy.org").ok).toBe(true);
    expect(validateGalaxyUrl("https://test.galaxyproject.org/").ok).toBe(true);
  });

  it("accepts http://localhost (local dev)", () => {
    expect(validateGalaxyUrl("http://localhost:8080").ok).toBe(true);
    expect(validateGalaxyUrl("http://127.0.0.1:8080").ok).toBe(true);
  });

  it("rejects http:// for non-loopback hosts", () => {
    const r = validateGalaxyUrl("http://usegalaxy.org");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/https/);
  });

  it("rejects malformed URLs", () => {
    expect(validateGalaxyUrl("not a url").ok).toBe(false);
    expect(validateGalaxyUrl("").ok).toBe(false);
  });

  it("rejects unsupported schemes", () => {
    expect(validateGalaxyUrl("ftp://galaxy.example.com").ok).toBe(false);
    expect(validateGalaxyUrl("file:///etc/passwd").ok).toBe(false);
  });

  it("trims whitespace before validating", () => {
    expect(validateGalaxyUrl("  https://x.galaxyproject.org  ").ok).toBe(true);
  });
});

describe("normalizeGalaxyUrl", () => {
  it("defaults a bare host to https://", () => {
    expect(normalizeGalaxyUrl("test.galaxyproject.org")).toBe("https://test.galaxyproject.org");
    expect(normalizeGalaxyUrl("usegalaxy.org/galaxy")).toBe("https://usegalaxy.org/galaxy");
  });

  it("preserves an explicit scheme", () => {
    expect(normalizeGalaxyUrl("https://usegalaxy.org")).toBe("https://usegalaxy.org");
    expect(normalizeGalaxyUrl("http://localhost:8080")).toBe("http://localhost:8080");
  });

  it("trims whitespace", () => {
    expect(normalizeGalaxyUrl("  test.galaxyproject.org  ")).toBe("https://test.galaxyproject.org");
  });

  it("leaves an empty string empty (validation rejects it)", () => {
    expect(normalizeGalaxyUrl("   ")).toBe("");
  });

  it("normalized bare host then passes validation", () => {
    expect(validateGalaxyUrl(normalizeGalaxyUrl("test.galaxyproject.org")).ok).toBe(true);
  });
});
