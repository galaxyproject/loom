import { describe, it, expect } from "vitest";
import { findOrbit, type FindOrbitDeps } from "../extensions/loom/orbit-launcher";

function deps(over: Partial<FindOrbitDeps> = {}): FindOrbitDeps {
  return {
    platform: "linux",
    env: {},
    homedir: "/home/me",
    existsSync: () => false,
    ...over,
  };
}

describe("findOrbit -- env override", () => {
  it("returns ORBIT_BIN when set and the file exists", () => {
    const d = deps({
      env: { ORBIT_BIN: "/custom/path/Orbit" },
      existsSync: (p) => p === "/custom/path/Orbit",
    });
    expect(findOrbit(d)).toBe("/custom/path/Orbit");
  });

  it("returns null when ORBIT_BIN is set but missing on disk", () => {
    const d = deps({ env: { ORBIT_BIN: "/nope" }, existsSync: () => false });
    expect(findOrbit(d)).toBeNull();
  });
});

describe("findOrbit -- darwin", () => {
  it("returns /Applications/Orbit.app's binary when installed", () => {
    const macPath = "/Applications/Orbit.app/Contents/MacOS/Orbit";
    const d = deps({ platform: "darwin", existsSync: (p) => p === macPath });
    expect(findOrbit(d)).toBe(macPath);
  });

  it("falls back to ~/Applications/Orbit.app when system Applications is empty", () => {
    const userMacPath = "/home/me/Applications/Orbit.app/Contents/MacOS/Orbit";
    const d = deps({ platform: "darwin", existsSync: (p) => p === userMacPath });
    expect(findOrbit(d)).toBe(userMacPath);
  });

  it("returns null when neither location has Orbit", () => {
    const d = deps({ platform: "darwin", existsSync: () => false });
    expect(findOrbit(d)).toBeNull();
  });
});
