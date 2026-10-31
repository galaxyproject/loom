// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { defines, orbitBrowserVite } from "../vite";

const ENV = [
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

describe("Orbit's brain in the worker", () => {
  // The worker's only brain: every build and the dev server stand Node out of its way.
  it.each(["build", "serve"] as const)("reaches the %s config with the aliases", (command) => {
    const c = config(command);
    expect(c.define).not.toHaveProperty("process.env.orbit_brain");
    const aliases = c.resolve?.alias as Array<{ find: RegExp; replacement: string }>;
    expect(
      aliases.some((a) => a.find.test("node:fs") && a.replacement.endsWith("shims/fs.ts")),
    ).toBe(true);
    expect(aliases.some((a) => a.find.test("@earendil-works/pi-tui"))).toBe(true);
    expect(c.worker).toHaveProperty("plugins");
  });

  it("leaves Node's own modules to tests, which run under Node", () => {
    const c = orbitBrowserVite({ command: "serve", mode: "test", flavorRoot: "/tmp/flavor" });
    expect(c.resolve).not.toHaveProperty("alias");
    expect(
      c.plugins?.some((p) => (p as { name?: string })?.name === "orbit-browser-node-guard"),
    ).toBe(false);
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
