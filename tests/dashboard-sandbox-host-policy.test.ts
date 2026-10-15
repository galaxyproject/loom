// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkHostFramePolicy } from "../app/src/renderer/dashboard/sandbox/host-policy.js";

function withPolicies(...contents: string[]): Document {
  document.head.querySelectorAll("meta[http-equiv]").forEach((m) => m.remove());
  for (const content of contents) {
    const meta = document.createElement("meta");
    meta.setAttribute("http-equiv", "Content-Security-Policy");
    meta.setAttribute("content", content);
    document.head.append(meta);
  }
  return document;
}

beforeEach(() => {
  document.head.querySelectorAll("meta[http-equiv]").forEach((m) => m.remove());
});

describe("checkHostFramePolicy", () => {
  it("is satisfied by a frame-src that cannot reach the network", () => {
    expect(checkHostFramePolicy(withPolicies("frame-src blob:;")).contained).toBe(true);
    expect(checkHostFramePolicy(withPolicies("frame-src 'none';")).contained).toBe(true);
    expect(checkHostFramePolicy(withPolicies("frame-src blob: data:;")).contained).toBe(true);
  });

  it("follows the fallback chain to child-src and then default-src", () => {
    expect(checkHostFramePolicy(withPolicies("child-src blob:;")).contained).toBe(true);
    expect(checkHostFramePolicy(withPolicies("default-src 'none';")).contained).toBe(true);
    // frame-src wins over both, even when it is the looser one.
    const loose = checkHostFramePolicy(withPolicies("default-src 'none'; frame-src https:;"));
    expect(loose.contained).toBe(false);
    expect(loose.offending).toEqual(["https:"]);
  });

  it("rejects anything that could carry a URL off the machine", () => {
    for (const policy of [
      "frame-src *;",
      "frame-src https:;",
      "frame-src http://localhost:3000;",
      "frame-src blob: https://cdn.example.com;",
      // 'self' is a real HTTP origin in the web shell, so it does not count.
      "frame-src 'self';",
    ]) {
      expect(checkHostFramePolicy(withPolicies(policy)).contained).toBe(false);
    }
  });

  it("refuses a page with no policy at all rather than assuming one", () => {
    const result = checkHostFramePolicy(withPolicies());
    expect(result.contained).toBe(false);
    expect(result.effective).toBeNull();
  });

  it("is satisfied if any one of several policies pins frames, since all are enforced", () => {
    const doc = withPolicies("default-src 'self'; frame-src https:;", "frame-src blob:;");
    expect(checkHostFramePolicy(doc).contained).toBe(true);
  });

  it("does not care about the case of the http-equiv attribute", () => {
    document.head.querySelectorAll("meta[http-equiv]").forEach((m) => m.remove());
    const meta = document.createElement("meta");
    meta.setAttribute("http-equiv", "content-security-policy");
    meta.setAttribute("content", "frame-src blob:;");
    document.head.append(meta);
    expect(checkHostFramePolicy(document).contained).toBe(true);
  });
});

describe("the policy the app actually ships", () => {
  /**
   * The widget's containment of a self-navigating frame rests entirely on this
   * directive, in a file the widget does not own, which is narrow today for an
   * unrelated reason -- the PDF viewer needs `blob:`. Nothing else would go red
   * if someone added an embed host to it, so this does.
   */
  it("pins frames somewhere that cannot reach the network", () => {
    const html = readFileSync(resolve(__dirname, "../app/src/renderer/index.html"), "utf-8");
    const match = html.match(/http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]+)"/);
    expect(match, "index.html should carry a Content-Security-Policy meta").toBeTruthy();

    const doc = withPolicies(match![1]);
    const result = checkHostFramePolicy(doc);
    expect(
      result.contained,
      `index.html frame-src is "${result.effective}", which would let a custom view ` +
        `navigate itself to ${result.offending.join(", ")} and take its data along in the URL`,
    ).toBe(true);
  });
});

describe("where the policy has to live", () => {
  it("ignores a CSP meta in the body, which the browser ignores too", () => {
    // Scanning the whole document meant a policy the browser is not enforcing
    // could satisfy the precondition, and the agent can get markup into the
    // body. The frame must stay refused.
    const doc = document.implementation.createHTMLDocument("t");
    const meta = doc.createElement("meta");
    meta.setAttribute("http-equiv", "Content-Security-Policy");
    meta.setAttribute("content", "frame-src blob:;");
    doc.body.append(meta);
    expect(checkHostFramePolicy(doc).contained).toBe(false);
  });

  it("honours the same policy in the head", () => {
    const doc = document.implementation.createHTMLDocument("t");
    const meta = doc.createElement("meta");
    meta.setAttribute("http-equiv", "Content-Security-Policy");
    meta.setAttribute("content", "frame-src blob:;");
    doc.head.append(meta);
    expect(checkHostFramePolicy(doc).contained).toBe(true);
  });
});
