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
