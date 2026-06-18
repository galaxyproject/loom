import { describe, it, expect } from "vitest";
import { normalizeGalaxyUrl, validateGalaxyUrl } from "../app/src/main/galaxy-url.js";

describe("normalizeGalaxyUrl", () => {
  it("adds https:// to a scheme-less host", () => {
    expect(normalizeGalaxyUrl("test.galaxyproject.org")).toBe("https://test.galaxyproject.org");
  });

  it("preserves an explicit scheme", () => {
    expect(normalizeGalaxyUrl("https://x.org")).toBe("https://x.org");
    expect(normalizeGalaxyUrl("http://localhost:8080")).toBe("http://localhost:8080");
  });

  it("leaves an empty string empty", () => {
    expect(normalizeGalaxyUrl("  ")).toBe("");
  });
});

describe("validateGalaxyUrl", () => {
  it("accepts https to any host", () => {
    expect(validateGalaxyUrl("https://usegalaxy.org").ok).toBe(true);
    expect(validateGalaxyUrl("https://my-institution.example").ok).toBe(true);
  });

  it("accepts http only for loopback", () => {
    expect(validateGalaxyUrl("http://localhost:8080").ok).toBe(true);
    expect(validateGalaxyUrl("http://127.0.0.1:9000").ok).toBe(true);
    expect(validateGalaxyUrl("http://[::1]:8080").ok).toBe(true);
  });

  it("rejects cleartext http to a non-loopback host (the exfil/downgrade case)", () => {
    const r = validateGalaxyUrl("http://evil.example/api");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/https/i);
  });

  it("rejects a resolvable hostname masquerading as loopback (127.x must be a numeric IP)", () => {
    expect(validateGalaxyUrl("http://127.evil.example").ok).toBe(false);
    expect(validateGalaxyUrl("http://127.0.0.1.evil.example").ok).toBe(false);
  });

  it("rejects non-http(s) schemes", () => {
    expect(validateGalaxyUrl("ftp://host/x").ok).toBe(false);
    expect(validateGalaxyUrl("file:///etc/passwd").ok).toBe(false);
  });

  it("rejects an unparseable URL", () => {
    expect(validateGalaxyUrl("not a url").ok).toBe(false);
  });
});
