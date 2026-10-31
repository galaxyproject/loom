import { describe, expect, it } from "vitest";

import { GALAXY_READY, GALAXY_UNREACHABLE } from "./agent/galaxy-status";
import { galaxyCanRun, galaxyRefusalMessage } from "./diagnostics";

describe("the approval gate, on what the worker says of Galaxy", () => {
  it("refuses exactly when Galaxy did not answer", () => {
    expect(galaxyCanRun(GALAXY_READY)).toBe(true);
    expect(galaxyCanRun(GALAXY_UNREACHABLE)).toBe(false);
  });

  it("does not block before the agent has reported", () => {
    expect(galaxyCanRun(undefined)).toBe(true);
    expect(galaxyCanRun(null)).toBe(true);
  });

  it("names the server when it refuses", () => {
    expect(galaxyRefusalMessage()).toMatch(/Galaxy did not answer/);
  });
});
