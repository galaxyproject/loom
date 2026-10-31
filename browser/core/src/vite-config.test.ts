// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { defines, orbitBrain, orbitBrowserVite } from "../vite";

const ENV = [
  "VITE_ORBIT_BRAIN",
  "ORBIT_BUILD_COMMIT",
  "ORBIT_BUILD_TIME",
  "LOOM_BUILD_COMMIT",
  "LOOM_BUILD_TIME",
] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const config = (command: "build" | "serve") =>
  orbitBrowserVite({ command, flavorRoot: "/tmp/flavor" });

describe("the Orbit brain flag", () => {
  it("defaults to the browser brain, with no aliases", () => {
    delete process.env.VITE_ORBIT_BRAIN;
    const built = config("build");
    expect(built.define?.["process.env.orbit_brain"]).toBe('"browser"');
    expect(built.resolve).not.toHaveProperty("alias");
    expect(built.worker).not.toHaveProperty("plugins");
  });

  // A build calls defines() with no settings, so a flag read there would reach only the dev server.
  it.each(["build", "serve"] as const)("reaches the %s config with the aliases", (command) => {
    process.env.VITE_ORBIT_BRAIN = "orbit";
    const c = config(command);
    expect(c.define?.["process.env.orbit_brain"]).toBe('"orbit"');
    const aliases = c.resolve?.alias as Array<{ find: RegExp; replacement: string }>;
    expect(
      aliases.some((a) => a.find.test("node:fs") && a.replacement.endsWith("shims/fs.ts")),
    ).toBe(true);
    expect(aliases.some((a) => a.find.test("@earendil-works/pi-tui"))).toBe(true);
    expect(c.worker).toHaveProperty("plugins");
  });

  it("refuses a value that isn't a brain", () => {
    process.env.VITE_ORBIT_BRAIN = "orbiter";
    expect(() => orbitBrain()).toThrow(/VITE_ORBIT_BRAIN=orbiter/);
    expect(() => config("build")).toThrow(/not a brain/);
  });
});

describe("build stamps", () => {
  it("are pinned by ORBIT_BUILD_COMMIT and ORBIT_BUILD_TIME, for byte comparisons", () => {
    process.env.ORBIT_BUILD_COMMIT = "pinned";
    process.env.ORBIT_BUILD_TIME = "2000-01-01T00:00:00.000Z";
    const d = defines();
    expect(d["process.env.build_commit"]).toBe('"pinned"');
    expect(d["process.env.build_built"]).toBe('"2000-01-01T00:00:00.000Z"');
  });

  it("still take the LOOM_ spelling", () => {
    process.env.LOOM_BUILD_COMMIT = "legacy";
    expect(defines()["process.env.build_commit"]).toBe('"legacy"');
  });
});
