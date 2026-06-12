import { describe, it, expect } from "vitest";
import { isLoopbackHost, evaluateBind, authorizeWsUpgrade } from "./auth.js";

describe("isLoopbackHost", () => {
  it("recognizes loopback hosts, rejects exposed ones", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("10.0.0.5")).toBe(false);
  });
});

describe("evaluateBind", () => {
  it("allows a loopback bind with no token", () => {
    expect(evaluateBind("127.0.0.1", undefined, false).ok).toBe(true);
  });
  it("refuses an exposed bind with no token and no opt-out", () => {
    const d = evaluateBind("0.0.0.0", undefined, false);
    expect(d.ok).toBe(false);
    expect(d.error).toMatch(/LOOM_WEB_TOKEN/);
  });
  it("allows an exposed bind once a token is set", () => {
    expect(evaluateBind("0.0.0.0", "s3cret", false).ok).toBe(true);
  });
  it("allows an exposed bind with the explicit insecure opt-out", () => {
    expect(evaluateBind("0.0.0.0", undefined, true).ok).toBe(true);
  });
});

describe("authorizeWsUpgrade", () => {
  it("rejects a cross-origin upgrade", () => {
    const r = authorizeWsUpgrade(
      { origin: "http://evil.example", host: "localhost:3000", url: "/ws" },
      undefined,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cross-origin/);
  });
  it("allows same-origin when no token is configured", () => {
    expect(
      authorizeWsUpgrade(
        { origin: "http://localhost:3000", host: "localhost:3000", url: "/ws" },
        undefined,
      ).ok,
    ).toBe(true);
  });
  it("requires a matching token when one is configured", () => {
    expect(authorizeWsUpgrade({ host: "h", url: "/ws" }, "sek").ok).toBe(false);
    expect(authorizeWsUpgrade({ host: "h", url: "/ws?token=nope" }, "sek").ok).toBe(false);
    expect(authorizeWsUpgrade({ host: "h", url: "/ws?token=sek" }, "sek").ok).toBe(true);
  });
  it("allows a non-browser client (no Origin) that presents the token", () => {
    expect(authorizeWsUpgrade({ host: "h", url: "/ws?token=sek" }, "sek").ok).toBe(true);
  });
});
