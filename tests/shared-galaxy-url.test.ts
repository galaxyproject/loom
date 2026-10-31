import { describe, expect, it } from "vitest";
import { normalizeGalaxyUrl } from "../shared/galaxy-url.js";
import { normalizeGalaxyUrl as appNormalize } from "../app/src/main/galaxy-url.js";
import { normalizeGalaxyUrl as brainNormalize } from "../extensions/orbit/profiles";

describe("normalizeGalaxyUrl", () => {
  it.each([
    ["https://usegalaxy.org", "https://usegalaxy.org"],
    ["https://usegalaxy.org/", "https://usegalaxy.org"],
    ["https://usegalaxy.org///", "https://usegalaxy.org"],
    ["  usegalaxy.org  ", "https://usegalaxy.org"],
    ["http://localhost:8080/", "http://localhost:8080"],
  ])("tidies %j to %j", (input, expected) => {
    expect(normalizeGalaxyUrl(input)).toBe(expected);
  });

  it.each([
    ["https://usegalaxy.org/api", "https://usegalaxy.org"],
    ["https://usegalaxy.org/api/", "https://usegalaxy.org"],
    ["https://usegalaxy.org//api//", "https://usegalaxy.org"],
    ["usegalaxy.org/api", "https://usegalaxy.org"],
    ["http://127.0.0.1:8080/api", "http://127.0.0.1:8080"],
    ["https://example.org/galaxy/api/", "https://example.org/galaxy"],
  ])("takes the API root %j back to the server root %j", (input, expected) => {
    expect(normalizeGalaxyUrl(input)).toBe(expected);
  });

  it("strips only a whole trailing /api path segment", () => {
    // A host called "api" is not an API root.
    expect(normalizeGalaxyUrl("https://api")).toBe("https://api");
    expect(normalizeGalaxyUrl("api")).toBe("https://api");
    expect(normalizeGalaxyUrl("https://example.org/apis")).toBe("https://example.org/apis");
    expect(normalizeGalaxyUrl("https://example.org/myapi")).toBe("https://example.org/myapi");
    expect(normalizeGalaxyUrl("https://example.org/api/v2")).toBe("https://example.org/api/v2");
  });

  it("leaves a differently-cased /API alone, since Galaxy's API root is lowercase", () => {
    // A path prefix that happens to be spelled API is a deployment, not an API root.
    expect(normalizeGalaxyUrl("https://example.org/API")).toBe("https://example.org/API");
    expect(normalizeGalaxyUrl("https://example.org/galaxy/API/")).toBe(
      "https://example.org/galaxy/API",
    );
  });

  it.each([
    ["https://example.org/?x=1", "https://example.org"],
    ["https://example.org/#/histories/list", "https://example.org"],
    ["https://example.org/galaxy/api?key=abc#top", "https://example.org/galaxy"],
    ["example.org?x=1", "https://example.org"],
  ])(
    "drops the query and fragment from %j, which would swallow the API path",
    (input, expected) => {
      expect(normalizeGalaxyUrl(input)).toBe(expected);
    },
  );

  it.each([
    ["HTTPS://example.org/api/?", "HTTPS://example.org"],
    ["https://example.org/api#", "https://example.org"],
    ["//example.org/api", "https://example.org"],
    ["https://example.org/api/api", "https://example.org"],
    ["https://example.org/galaxy/api/api/", "https://example.org/galaxy"],
  ])("also takes the paste %j to %j", (input, expected) => {
    expect(normalizeGalaxyUrl(input)).toBe(expected);
  });

  it("never changes the host the key goes to", () => {
    for (const u of [
      "https://evil.example#@good.example/api",
      "https://good.example?@evil.example",
      "https://user@good.example/api?next=//evil.example",
      "https://good.example:8443/galaxy/api/#x",
    ]) {
      expect(new URL(normalizeGalaxyUrl(u)).host).toBe(new URL(u).host);
    }
  });

  it.each([
    ["https://example.org/api ?x", "https://example.org"],
    ["https://example.org/ #top", "https://example.org"],
    ["https://example.org/api\t#x", "https://example.org"],
    ["example.org/api /", "https://example.org"],
  ])("finishes the job in one pass on %j", (input, expected) => {
    expect(normalizeGalaxyUrl(input)).toBe(expected);
  });

  it("is idempotent across combinations of the awkward parts", () => {
    const parts = {
      scheme: ["", "https://", "HTTP://", "//"],
      host: ["example.org", "api", "127.0.0.1:8080"],
      path: ["", "/galaxy", "/api", "/API", "/api/api", "/galaxy/api/"],
      gap: ["", " ", "\t", "/", " /"],
      tail: ["", "?x=1", "#frag", "?", "#"],
    };
    for (const s of parts.scheme)
      for (const h of parts.host)
        for (const p of parts.path)
          for (const g of parts.gap)
            for (const t of parts.tail) {
              const once = normalizeGalaxyUrl(` ${s}${h}${p}${g}${t} `);
              expect(normalizeGalaxyUrl(once), JSON.stringify(once)).toBe(once);
            }
  });

  it.each([
    "",
    "   ",
    "//",
    "/",
    "https://",
    "?x=1",
    "#",
    "https://?",
    "HTTP://#",
    "https:// /api",
  ])("leaves %j, which names no host, blank", (input) => {
    expect(normalizeGalaxyUrl(input)).toBe("");
  });

  it("leaves blank input blank", () => {
    expect(normalizeGalaxyUrl("")).toBe("");
    expect(normalizeGalaxyUrl("   ")).toBe("");
  });

  it("is idempotent", () => {
    for (const u of [
      "usegalaxy.org/api/",
      "https://example.org/galaxy/api",
      "http://localhost:8080",
      "https://example.org/api/api",
      "HTTPS://example.org/API/?",
      "https://example.org/galaxy/api/?x=1#y",
    ]) {
      const once = normalizeGalaxyUrl(u);
      expect(normalizeGalaxyUrl(once)).toBe(once);
    }
  });

  it("is the same function the desktop and the brain use", () => {
    expect(appNormalize).toBe(normalizeGalaxyUrl);
    expect(brainNormalize).toBe(normalizeGalaxyUrl);
  });
});
