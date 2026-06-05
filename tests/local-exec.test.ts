import { describe, it, expect } from "vitest";
import { isLocalExecDisabled } from "../extensions/loom/local-exec.js";

describe("isLocalExecDisabled", () => {
  it("disables local-exec safety only for the exact off signal", () => {
    expect(isLocalExecDisabled({ LOOM_LOCAL_EXEC: "off" })).toBe(true);
  });

  // Fail-safe: anything that is NOT exactly "off" keeps exec-guard ON, so an
  // ambient/garbled value can never silently disable a security control.
  it.each([
    {},
    { LOOM_LOCAL_EXEC: "on" },
    { LOOM_LOCAL_EXEC: "" },
    { LOOM_LOCAL_EXEC: "OFF" },
    { LOOM_LOCAL_EXEC: "false" },
    { LOOM_LOCAL_EXEC: "0" },
  ])("keeps the guard on for env %p", (env) => {
    expect(isLocalExecDisabled(env as NodeJS.ProcessEnv)).toBe(false);
  });
});
