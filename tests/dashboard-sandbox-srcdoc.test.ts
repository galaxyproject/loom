// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { buildSandboxDocument } from "../app/src/renderer/dashboard/sandbox/srcdoc.js";
import { SANDBOX_BRIDGE_SOURCE } from "../app/src/renderer/dashboard/sandbox/bridge.js";
import {
  SANDBOX_FORBIDDEN_TOKENS,
  SANDBOX_FRAME_CSP,
  SANDBOX_TOKENS,
} from "../app/src/renderer/dashboard/sandbox/policy.js";

/** Where our policy sits in the built document. Everything else is measured against it. */
function cspIndex(doc: string): number {
  const at = doc.indexOf('http-equiv="Content-Security-Policy"');
  expect(at).toBeGreaterThan(-1);
  return at;
}

describe("sandbox policy", () => {
  it("blocks every fetch path by default and overrides only what a view needs to draw", () => {
    expect(SANDBOX_FRAME_CSP).toContain("default-src 'none'");
    expect(SANDBOX_FRAME_CSP).toContain("script-src 'unsafe-inline'");
    expect(SANDBOX_FRAME_CSP).toContain("style-src 'unsafe-inline'");
    expect(SANDBOX_FRAME_CSP).toContain("img-src data:");
    // Neither of these falls back to default-src, so their absence would be a
    // hole rather than a redundancy.
    expect(SANDBOX_FRAME_CSP).toContain("form-action 'none'");
    expect(SANDBOX_FRAME_CSP).toContain("base-uri 'none'");
    // No source that could reach the network may appear anywhere in it.
    expect(SANDBOX_FRAME_CSP).not.toMatch(/https?:/);
    expect(SANDBOX_FRAME_CSP).not.toContain("'self'");
    expect(SANDBOX_FRAME_CSP).not.toContain("*");
  });

  it("grants allow-scripts and nothing else", () => {
    // The equality is the test. Looping over SANDBOX_FORBIDDEN_TOKENS after it
    // cannot fail for any value that gets past this line, so it is not here;
    // the list is documentation of intent, asserted against the DOM attribute
    // the widget actually sets in the widget's own test.
    expect(SANDBOX_TOKENS.split(/\s+/).filter(Boolean)).toEqual(["allow-scripts"]);
    expect(SANDBOX_FORBIDDEN_TOKENS).toContain("allow-same-origin");
  });
});

describe("buildSandboxDocument", () => {
  it("puts the policy first, before anything the agent wrote", () => {
    const doc = buildSandboxDocument({ html: "<p id='mine'>hello</p>" });
    const policyAt = cspIndex(doc);
    expect(doc.indexOf("<!doctype html>")).toBe(0);
    // Only the doctype, <html> and <head> may precede it.
    expect(doc.slice(0, policyAt).replace(/\s+/g, "")).toBe(
      '<!doctypehtml><htmllang="en"><head><meta',
    );
    expect(doc.indexOf("id='mine'")).toBeGreaterThan(policyAt);
  });

  it("keeps the policy first even when the content carries its own", () => {
    const hostile = '<meta http-equiv="Content-Security-Policy" content="default-src *">';
    const doc = buildSandboxDocument({ html: hostile });
    expect(doc.indexOf(SANDBOX_FRAME_CSP)).toBeLessThan(doc.indexOf("default-src *"));
    // Ours is the first CSP meta in the document and reaches the parser
    // intact. A later one can only narrow what is allowed, never widen it --
    // that part is the browser's promise and is checked in a browser too.
    expect(doc.indexOf(`content="${SANDBOX_FRAME_CSP}"`)).toBe(
      cspIndex(doc) + 'http-equiv="Content-Security-Policy" '.length,
    );
    expect(doc.indexOf("default-src *")).toBeGreaterThan(cspIndex(doc));
  });

  it("is not derailed by closing tags in the content", () => {
    for (const trick of [
      "</iframe><script>steal()</script>",
      "</head><body onload='steal()'>",
      "</script></style></body></html>",
      '"><img src=x onerror=steal()>',
    ]) {
      const doc = buildSandboxDocument({ html: trick });
      const policyAt = cspIndex(doc);
      expect(doc.indexOf(trick)).toBeGreaterThan(policyAt);
      // Exactly one policy, one charset, one bridge -- the content did not
      // manage to make the builder emit a second head.
      expect(doc.match(/http-equiv="Content-Security-Policy"/g)).toHaveLength(1);
      expect(doc.match(/<meta charset="utf-8">/g)).toHaveLength(1);
    }
  });

  it("escapes a title rather than letting it close its own element", () => {
    const doc = buildSandboxDocument({ html: "x", title: "</title><script>steal()</script>" });
    expect(doc).not.toContain("</title><script>steal()");
    expect(doc).toContain("&lt;/title&gt;");
  });

  it("caps a very long title", () => {
    const doc = buildSandboxDocument({ html: "x", title: "t".repeat(5000) });
    expect(doc).not.toContain("t".repeat(201));
  });

  it("themes the frame, which cannot see Orbit's own custom properties", () => {
    expect(buildSandboxDocument({ html: "x", theme: "light" })).toContain("color-scheme: light");
    expect(buildSandboxDocument({ html: "x", theme: "dark" })).toContain("color-scheme: dark");
    // Anything unrecognised falls to dark, which is Orbit's default.
    expect(buildSandboxDocument({ html: "x" })).toContain("color-scheme: dark");
  });

  it("inlines a bridge that cannot close its own script element", () => {
    expect(SANDBOX_BRIDGE_SOURCE).not.toMatch(/<\/\s*script/i);
    const doc = buildSandboxDocument({ html: "x" });
    expect(doc.match(/<script>/g)).toHaveLength(1);
    expect(doc.indexOf("<script>")).toBeLessThan(doc.indexOf("<body>"));
  });

  it("survives being assigned to a real iframe without escaping into the page", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", SANDBOX_TOKENS);
    frame.srcdoc = buildSandboxDocument({ html: "</iframe><p>escaped?</p>" });
    host.append(frame);
    expect(host.querySelectorAll("iframe")).toHaveLength(1);
    expect(host.querySelector("p")).toBeNull();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    host.remove();
  });
});
