// @vitest-environment node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const BROWSER = join(__dirname, "..", "..");
const REPO = join(BROWSER, "..");
const PACKAGE = join("node_modules", "@galaxyproject", "galaxy-ops", "package.json");

describe("galaxy-ops", () => {
  // The browser once pinned a fork of its own; Orbit's brain, which the worker runs, uses the
  // repo root's, and two copies would mean two operation lists and two behaviours.
  it("is the repo root's, with no copy of the browser's own", () => {
    expect(existsSync(join(REPO, PACKAGE))).toBe(true);
    expect(existsSync(join(BROWSER, PACKAGE))).toBe(false);
    expect(existsSync(join(BROWSER, "core", PACKAGE))).toBe(false);
  });
});
