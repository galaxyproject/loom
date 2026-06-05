import { describe, it, expect } from "vitest";
import { parseSemver, comparePre, isNewer, pickChannel } from "../shared/version-compare.js";

describe("parseSemver", () => {
  it("parses plain and prerelease versions, tolerating a v prefix", () => {
    expect(parseSemver("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: "" });
    expect(parseSemver("0.3.0-alpha.10")).toEqual({
      major: 0,
      minor: 3,
      patch: 0,
      pre: "alpha.10",
    });
  });
  it("returns null for garbage", () => {
    expect(parseSemver("not-a-version")).toBeNull();
  });
});

describe("isNewer", () => {
  it("compares core version components", () => {
    expect(isNewer("0.2.0", "0.3.0")).toBe(true);
    expect(isNewer("0.3.0", "0.2.0")).toBe(false);
    expect(isNewer("0.3.0", "0.3.0")).toBe(false);
  });
  it("honors prerelease precedence", () => {
    expect(isNewer("1.0.0-alpha", "1.0.0")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0-alpha")).toBe(false);
    expect(isNewer("1.0.0-alpha.9", "1.0.0-alpha.10")).toBe(true);
    expect(isNewer("1.0.0-alpha.10", "1.0.0-alpha.9")).toBe(false);
  });
  it("returns false for unparseable input", () => {
    expect(isNewer("garbage", "1.0.0")).toBe(false);
  });
});

describe("comparePre", () => {
  it("treats an absent prerelease as higher precedence than any prerelease", () => {
    expect(comparePre("", "alpha")).toBeGreaterThan(0);
    expect(comparePre("alpha", "")).toBeLessThan(0);
    expect(comparePre("", "")).toBe(0);
  });
  it("ranks numeric identifiers below alphanumeric ones", () => {
    expect(comparePre("1", "alpha")).toBeLessThan(0);
    expect(comparePre("alpha", "1")).toBeGreaterThan(0);
  });
  it("gives a longer prerelease higher precedence when all preceding fields tie", () => {
    expect(comparePre("alpha", "alpha.1")).toBeLessThan(0);
    expect(comparePre("alpha.1", "alpha")).toBeGreaterThan(0);
  });
  it("returns zero for identical prerelease tags", () => {
    expect(comparePre("alpha.1", "alpha.1")).toBe(0);
  });
});

describe("pickChannel", () => {
  it("maps a plain version to latest and a prerelease to its identifier", () => {
    expect(pickChannel("0.3.0")).toBe("latest");
    expect(pickChannel("0.3.0-alpha.4")).toBe("alpha");
    expect(pickChannel("1.2.3-beta.1")).toBe("beta");
    expect(pickChannel("2.0.0-rc.1")).toBe("rc");
  });
});
