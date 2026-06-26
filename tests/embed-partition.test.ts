/**
 * Phase 3.3 trust boundary: the embed token is injected (and frame headers
 * stripped) ONLY for the Galaxy origin, off-origin iframe navigations are
 * blocked, and the API key never appears anywhere here.
 */

import { describe, expect, it } from "vitest";
import {
  COOKIE_HEADER,
  EMBED_TOKEN_HEADER,
  SET_COOKIE_HEADER,
  sameGalaxyOrigin,
  shouldBlockNavigation,
  stripFrameHeaders,
  stripHeader,
} from "../app/src/main/embed-partition";

const GALAXY = "https://usegalaxy.org";

describe("sameGalaxyOrigin", () => {
  it("matches the Galaxy origin (any path)", () => {
    expect(sameGalaxyOrigin("https://usegalaxy.org/published/page?embed=true", GALAXY)).toBe(true);
    expect(sameGalaxyOrigin("https://usegalaxy.org/api/datasets/123/display", GALAXY)).toBe(true);
  });

  it("honors a deployment-prefixed server URL by origin (prefix is just a path)", () => {
    expect(sameGalaxyOrigin("https://example.org/anything", "https://example.org/galaxy")).toBe(
      true,
    );
  });

  it("rejects a different host, port, or scheme", () => {
    expect(sameGalaxyOrigin("https://evil.example/x", GALAXY)).toBe(false);
    expect(sameGalaxyOrigin("https://usegalaxy.org:8443/x", GALAXY)).toBe(false);
    expect(sameGalaxyOrigin("http://usegalaxy.org/x", GALAXY)).toBe(false);
  });

  it("rejects non-http(s) schemes and the account API on another host", () => {
    expect(sameGalaxyOrigin("file:///etc/passwd", GALAXY)).toBe(false);
    expect(sameGalaxyOrigin("https://attacker.test/api/users/me/api_key", GALAXY)).toBe(false);
  });

  it("rejects everything when the server URL is unknown or unparseable", () => {
    expect(sameGalaxyOrigin("https://usegalaxy.org/x", null)).toBe(false);
    expect(sameGalaxyOrigin("not a url", GALAXY)).toBe(false);
    expect(sameGalaxyOrigin("https://usegalaxy.org/x", "not a url")).toBe(false);
  });
});

describe("shouldBlockNavigation", () => {
  it("allows navigation within the Galaxy origin", () => {
    expect(shouldBlockNavigation("https://usegalaxy.org/published/page?id=1", GALAXY)).toBe(false);
  });

  it("blocks navigation off the Galaxy origin", () => {
    expect(shouldBlockNavigation("https://evil.example/phish", GALAXY)).toBe(true);
  });

  it("blocks http(s) navigation when the server is unknown (fail closed)", () => {
    expect(shouldBlockNavigation("https://usegalaxy.org/x", null)).toBe(true);
  });

  it("leaves non-http(s) frame schemes alone (about:/blob:/data:)", () => {
    expect(shouldBlockNavigation("about:blank", GALAXY)).toBe(false);
    expect(shouldBlockNavigation("blob:https://usegalaxy.org/abc", GALAXY)).toBe(false);
    expect(shouldBlockNavigation("data:text/html,hi", GALAXY)).toBe(false);
  });

  it("blocks an unparseable navigation URL (fail closed)", () => {
    expect(shouldBlockNavigation("ht!tp://%%%", GALAXY)).toBe(true);
  });
});

describe("stripFrameHeaders", () => {
  it("removes X-Frame-Options and CSP (incl. report-only), case-insensitively", () => {
    const stripped = stripFrameHeaders({
      "Content-Type": ["text/html"],
      "X-Frame-Options": ["DENY"],
      "content-security-policy": ["frame-ancestors 'none'"],
      "Content-Security-Policy-Report-Only": ["default-src 'self'"],
    });
    expect(stripped).toEqual({ "Content-Type": ["text/html"] });
  });

  it("is a no-op on headers with nothing to strip, and tolerates undefined", () => {
    expect(stripFrameHeaders({ "Content-Type": ["text/html"] })).toEqual({
      "Content-Type": ["text/html"],
    });
    expect(stripFrameHeaders(undefined)).toEqual({});
  });
});

describe("stripHeader (stateless embed partition — LOOM Bug 1)", () => {
  it("removes the Cookie request header case-insensitively (single-value form)", () => {
    const stripped = stripHeader(
      { "X-Galaxy-Embed-Token": "abc", cookie: "galaxysession=anon" },
      COOKIE_HEADER,
    );
    expect(stripped).toEqual({ "X-Galaxy-Embed-Token": "abc" });
  });

  it("removes the Set-Cookie response header case-insensitively (array form)", () => {
    const stripped = stripHeader(
      { "Content-Type": ["text/html"], "set-cookie": ["galaxysession=anon; Path=/"] },
      SET_COOKIE_HEADER,
    );
    expect(stripped).toEqual({ "Content-Type": ["text/html"] });
  });

  it("is a no-op when the header is absent, and tolerates undefined", () => {
    expect(stripHeader({ "X-Galaxy-Embed-Token": "abc" }, COOKIE_HEADER)).toEqual({
      "X-Galaxy-Embed-Token": "abc",
    });
    expect(stripHeader(undefined, COOKIE_HEADER)).toEqual({});
  });

  it("composes with stripFrameHeaders to drop frame + cookie headers together", () => {
    const stripped = stripHeader(
      stripFrameHeaders({
        "Content-Type": ["text/html"],
        "X-Frame-Options": ["DENY"],
        "Set-Cookie": ["galaxysession=anon"],
      }),
      SET_COOKIE_HEADER,
    );
    expect(stripped).toEqual({ "Content-Type": ["text/html"] });
  });
});

describe("EMBED_TOKEN_HEADER", () => {
  it("is the scoped embed-token header, not an API key header", () => {
    expect(EMBED_TOKEN_HEADER).toBe("X-Galaxy-Embed-Token");
    expect(EMBED_TOKEN_HEADER.toLowerCase()).not.toContain("api");
  });
});
