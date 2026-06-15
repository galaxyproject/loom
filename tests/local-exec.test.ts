import { describe, it, expect } from "vitest";
import { isLocalExecDisabled, isLocalShellDisabled } from "../extensions/loom/local-exec.js";

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

describe("isLocalShellDisabled", () => {
  it("reports no local shell only for the exact off signal", () => {
    expect(isLocalShellDisabled({ LOOM_LOCAL_SHELL: "off" })).toBe(true);
  });

  // Fail-safe the same way isLocalExecDisabled does: anything not exactly "off"
  // leaves the local shell "available", so mac/linux/web (var unset) keep
  // running local-tagged plans. The actual no-bash guarantee on Windows is the
  // removed bash tool, not this flag -- this only drives the friendly init-gate
  // "re-tag your plan" message.
  it.each([{}, { LOOM_LOCAL_SHELL: "on" }, { LOOM_LOCAL_SHELL: "" }, { LOOM_LOCAL_SHELL: "OFF" }])(
    "treats the shell as available for env %p",
    (env) => {
      expect(isLocalShellDisabled(env as NodeJS.ProcessEnv)).toBe(false);
    },
  );
});
