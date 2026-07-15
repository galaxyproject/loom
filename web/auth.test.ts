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

// #330 (Codex, HIGH): in GxIT mode the tool XML sets LOOM_WEB_ALLOW_INSECURE=1
// and no token, because a Galaxy-controlled entry-point URL can't carry one.
// The origin check was skipped entirely when Origin was absent, so any process
// that could reach port 3000 -- e.g. another container on the default Docker
// bridge, where inter-container traffic is allowed by default -- could open the
// control socket and drive the victim's credentialed agent.
//
// Browsers always send Origin on a WebSocket upgrade, so requiring it costs the
// real client nothing: a browser upgrade that passes today (Origin present and
// matching Host) still passes. Only origin-less non-browser clients are newly
// rejected -- which is exactly the threat.
describe("authorizeWsUpgrade with requireOrigin (insecure remote mode)", () => {
  const policy = { requireOrigin: true };

  it("rejects an origin-less upgrade", () => {
    const r = authorizeWsUpgrade({ host: "orbit.example.org", url: "/ws" }, undefined, policy);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/origin/i);
  });

  it("still allows a same-origin browser upgrade", () => {
    expect(
      authorizeWsUpgrade(
        { origin: "https://orbit.example.org", host: "orbit.example.org", url: "/ws" },
        undefined,
        policy,
      ).ok,
    ).toBe(true);
  });

  it("still rejects a cross-origin upgrade", () => {
    expect(
      authorizeWsUpgrade(
        { origin: "https://evil.example.org", host: "orbit.example.org", url: "/ws" },
        undefined,
        policy,
      ).ok,
    ).toBe(false);
  });

  it("rejects when Host is missing, since the Origin can't be verified", () => {
    expect(
      authorizeWsUpgrade({ origin: "https://orbit.example.org", url: "/ws" }, undefined, policy).ok,
    ).toBe(false);
  });

  it("rejects a malformed Origin", () => {
    expect(
      authorizeWsUpgrade({ origin: "not-a-url", host: "orbit.example.org" }, undefined, policy).ok,
    ).toBe(false);
  });
});

// The policy is opt-in: local dev (loopback) and token-authenticated deployments
// keep accepting non-browser clients, so wscat/curl workflows still work.
describe("authorizeWsUpgrade without requireOrigin (default)", () => {
  it("still allows an origin-less client when no policy is passed", () => {
    expect(authorizeWsUpgrade({ host: "127.0.0.1:3000", url: "/ws" }, undefined).ok).toBe(true);
  });
  it("still allows an origin-less client that presents the token", () => {
    expect(authorizeWsUpgrade({ host: "h", url: "/ws?token=s3cret" }, "s3cret").ok).toBe(true);
  });
});
