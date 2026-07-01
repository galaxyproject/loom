import { describe, it, expect } from "vitest";
import { resolveReleasePageUrl } from "../app/src/main/release-page.js";

const LATEST = "https://github.com/galaxyproject/loom/releases/latest";

describe("resolveReleasePageUrl", () => {
  it("passes a valid loom releases URL through untouched", () => {
    const url = "https://github.com/galaxyproject/loom/releases/tag/v0.5.2";
    expect(resolveReleasePageUrl(url)).toBe(url);
    expect(resolveReleasePageUrl(LATEST)).toBe(LATEST);
  });

  it("pins to the latest releases page for a non-releases loom URL", () => {
    expect(resolveReleasePageUrl("https://github.com/galaxyproject/loom/issues/368")).toBe(LATEST);
  });

  it("pins to the latest releases page for a foreign host", () => {
    expect(resolveReleasePageUrl("https://evil.example/galaxyproject/loom/releases/tag/x")).toBe(
      LATEST,
    );
  });

  it("pins to the latest releases page for a look-alike host prefix", () => {
    // github.com.evil.com must not satisfy the pin.
    expect(
      resolveReleasePageUrl("https://github.com.evil.com/galaxyproject/loom/releases/tag/x"),
    ).toBe(LATEST);
  });

  it("pins to the latest releases page for a javascript: URL", () => {
    expect(resolveReleasePageUrl("javascript:alert(1)")).toBe(LATEST);
  });

  it("pins to the latest releases page for http (non-https) releases URL", () => {
    expect(resolveReleasePageUrl("http://github.com/galaxyproject/loom/releases/tag/v1")).toBe(
      LATEST,
    );
  });

  it("pins to the latest releases page for non-string input", () => {
    expect(resolveReleasePageUrl(undefined)).toBe(LATEST);
    expect(resolveReleasePageUrl(null)).toBe(LATEST);
    expect(resolveReleasePageUrl(42)).toBe(LATEST);
    expect(resolveReleasePageUrl({})).toBe(LATEST);
  });
});
