import { describe, expect, it } from "vitest";
import {
  checkBaseUrl,
  describeNetworkError,
  interpretModelsResponse,
} from "../app/src/main/endpoint-probe.js";

/** The shape undici actually throws: a bare TypeError with the reason on cause. */
function fetchFailed(code: string, message = "some transport failure"): TypeError {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(message), { code }),
  });
}

describe("describeNetworkError", () => {
  it("names a DNS failure instead of reporting 'fetch failed'", () => {
    const out = describeNetworkError(fetchFailed("ENOTFOUND", "getaddrinfo ENOTFOUND api.x.test"));
    expect(out).toContain("Host not found");
    expect(out).toContain("ENOTFOUND");
    expect(out).not.toBe("Network error: fetch failed");
  });

  it("calls out an untrusted certificate and why Loom sees it that way", () => {
    const out = describeNetworkError(fetchFailed("UNABLE_TO_VERIFY_LEAF_SIGNATURE"));
    expect(out).toContain("TLS certificate not trusted");
    expect(out).toContain("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    expect(out).toContain("system store");
  });

  it("keeps the timeout wording for an aborted request", () => {
    const aborted = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    expect(describeNetworkError(aborted)).toBe("Validation timed out");
  });

  it("digs the code out of a nested cause chain", () => {
    const deep = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("socket hang up"), {
        cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      }),
    });
    expect(describeNetworkError(deep)).toContain("ECONNRESET");
  });

  it("still surfaces something useful for an unmapped code", () => {
    const out = describeNetworkError(fetchFailed("UND_ERR_SOCKET", "other side closed"));
    expect(out).toContain("UND_ERR_SOCKET");
    expect(out).toContain("other side closed");
  });

  it("falls back to the message when there is no code at all", () => {
    expect(describeNetworkError(new Error("something broke"))).toBe(
      "Network error: something broke",
    );
  });

  it("mentions an environment proxy only when one is set", () => {
    const err = fetchFailed("ECONNREFUSED");
    expect(describeNetworkError(err, { proxyConfigured: true })).toContain("does not use it");
    expect(describeNetworkError(err, { proxyConfigured: false })).not.toContain("proxy");
  });
});

describe("checkBaseUrl", () => {
  it("trims and drops trailing slashes", () => {
    expect(checkBaseUrl("  https://api.example.test/v1//  ")).toEqual({
      ok: true,
      url: "https://api.example.test/v1",
    });
  });

  it("rejects a scheme-less URL", () => {
    const res = checkBaseUrl("api.example.test/v1");
    expect(res).toEqual({ ok: false, error: "Base URL must start with http(s)://" });
  });

  it("allows plain http for a local endpoint", () => {
    expect(checkBaseUrl("http://localhost:4000/v1")).toEqual({
      ok: true,
      url: "http://localhost:4000/v1",
    });
  });

  // A URL copied out of rendered text keeps its look-alike punctuation, and the
  // only symptom downstream is a DNS failure against a URL that reads correctly.
  it("catches a look-alike hyphen in the host and names the codepoint", () => {
    // ‑ is a non-breaking hyphen -- what a rendered doc substitutes for "-".
    const res = checkBaseUrl("https://api.helmholtz‑blablador.fz-juelich.de/v1");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("non-ASCII");
      expect(res.error).toContain("U+2011");
    }
  });

  it("does not object to non-ASCII outside the host", () => {
    expect(checkBaseUrl("https://api.example.test/v1/café").ok).toBe(true);
  });
});

describe("interpretModelsResponse", () => {
  it("reads an OpenAI-shaped list, deduped", () => {
    const body = JSON.stringify({
      object: "list",
      data: [{ id: "alpha" }, { id: " beta " }, { id: "alpha" }, { id: 7 }],
    });
    expect(interpretModelsResponse(200, body)).toEqual({
      valid: true,
      models: ["alpha", "beta"],
    });
  });

  it("accepts a bare array of ids", () => {
    expect(interpretModelsResponse(200, JSON.stringify(["a", "b"]))).toEqual({
      valid: true,
      models: ["a", "b"],
    });
  });

  it("keeps a parseable but unfamiliar JSON shape valid, with no models", () => {
    expect(interpretModelsResponse(200, JSON.stringify({ ok: true }))).toEqual({
      valid: true,
      models: [],
    });
  });

  // loom#441: blablador answers an unauthenticated /v1/models with 200 and a
  // plain-text line. Treating that as proof of a working key is what made a
  // rejected key look like a working endpoint that served no models.
  it("does not call a 200 valid when the body is not JSON, and quotes the server", () => {
    const res = interpretModelsResponse(
      200,
      "You must provide a valid API key. Obtain one from http://helmholtz.cloud",
    );
    expect(res.valid).toBe(false);
    expect(res.error).toContain("You must provide a valid API key");
  });

  it("recognises an HTML body as a wrong base URL rather than quoting markup", () => {
    const res = interpretModelsResponse(200, "<!doctype html><html><body>Sign in</body></html>");
    expect(res.valid).toBe(false);
    expect(res.error).toContain("web page");
    expect(res.error).not.toContain("<");
  });

  it("reports an empty 200 body", () => {
    const res = interpretModelsResponse(200, "   \n  ");
    expect(res.valid).toBe(false);
    expect(res.error).toContain("empty reply");
  });

  it("caps a long non-JSON body so it fits a status label", () => {
    const res = interpretModelsResponse(200, "x".repeat(500));
    expect(res.valid).toBe(false);
    expect(res.error!.length).toBeLessThan(200);
    expect(res.error).toContain("...");
  });

  it("maps auth and server statuses", () => {
    expect(interpretModelsResponse(401, "")).toEqual({
      valid: false,
      error: "Invalid API key (401)",
    });
    expect(interpretModelsResponse(403, "").error).toContain("403");
    expect(interpretModelsResponse(500, "").error).toBe("Unexpected response: HTTP 500");
  });
});
