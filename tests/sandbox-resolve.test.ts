import { describe, it, expect, afterEach } from "vitest";
import { resolveSandbox } from "../extensions/loom/exec-guard/guardian-config";
import type { GuardianConfig } from "../extensions/loom/exec-guard/types";

function cfg(sandbox: boolean): GuardianConfig {
  return {
    enabled: true,
    dangerouslyBypassPermissions: false,
    trustedWorkspaces: [],
    extraWorkspaceRoots: [],
    consentAcknowledged: null,
    sandbox,
  };
}

describe("resolveSandbox", () => {
  const saved: Record<string, string | undefined> = {
    LOOM_SANDBOX: process.env.LOOM_SANDBOX,
  };
  afterEach(() => {
    for (const key of ["LOOM_SANDBOX"]) {
      const v = saved[key];
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
  });

  it("follows config when no env override is set", () => {
    delete process.env.LOOM_SANDBOX;
    expect(resolveSandbox(cfg(true))).toBe(true);
    expect(resolveSandbox(cfg(false))).toBe(false);
  });

  it("LOOM_SANDBOX=1 forces it on regardless of config", () => {
    process.env.LOOM_SANDBOX = "1";
    expect(resolveSandbox(cfg(false))).toBe(true);
  });
});
