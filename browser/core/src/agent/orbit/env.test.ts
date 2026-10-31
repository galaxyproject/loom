import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

it("completes a process that has only the dev server's defines on it", async () => {
  const partial: Record<string, unknown> = { env: { orbit_brain: "orbit" } };
  vi.stubGlobal("process", partial);
  vi.resetModules();
  const { setOrbitCwd } = await import("./env");
  vi.unstubAllGlobals();
  setOrbitCwd("/orbit/c1");
  expect((partial.cwd as () => string)()).toBe("/orbit/c1");
  expect(partial.pid).toBe(1);
  expect(partial.env).toEqual({ orbit_brain: "orbit" });
});
