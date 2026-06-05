import { describe, it, expect } from "vitest";
import { parseCliArgs } from "../app/src/main/cli-args";

// The bug this guards: the call site used process.argv.slice(2), which is right
// in dev (`electron . --cwd x` -> args at index 2) but drops `--cwd` in a
// packaged app (`orbit --cwd x` -> args at index 1). Scanning the full argv is
// position-independent and works for both, plus the second-instance event argv.
describe("parseCliArgs", () => {
  it("finds --cwd in a packaged-app argv (user args start at index 1)", () => {
    expect(
      parseCliArgs(["/Applications/Orbit.app/Contents/MacOS/orbit", "--cwd", "/Users/me/a"]),
    ).toEqual({ cwd: "/Users/me/a" });
  });

  it("finds --cwd in a dev argv (electron . --cwd ...)", () => {
    expect(parseCliArgs(["/path/to/electron", ".", "--cwd", "/Users/me/a"])).toEqual({
      cwd: "/Users/me/a",
    });
  });

  it("finds --cwd in a second-instance argv (full argv from the OS)", () => {
    expect(parseCliArgs(["/x/orbit", "--cwd", "/Users/me/y"])).toEqual({ cwd: "/Users/me/y" });
  });

  it("ignores Electron's own flags and the app-path arg", () => {
    expect(parseCliArgs(["/x/orbit", "--no-sandbox", ".", "--cwd", "/z"])).toEqual({ cwd: "/z" });
  });

  it("returns empty when --cwd is absent", () => {
    expect(parseCliArgs(["/x/orbit"])).toEqual({});
    expect(parseCliArgs([])).toEqual({});
  });

  it("ignores a trailing --cwd with no value (bounds-safe)", () => {
    expect(parseCliArgs(["/x/orbit", "--cwd"])).toEqual({});
  });
});
