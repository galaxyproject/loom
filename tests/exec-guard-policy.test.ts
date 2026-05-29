import { describe, it, expect } from "vitest";
import { decide } from "../extensions/loom/exec-guard/policy";
import type {
  GuardianConfig,
  PathResolver,
  PolicyRequest,
} from "../extensions/loom/exec-guard/types";

const HOME = "/home/alice";
const CWD = "/home/alice/project";
const baseCfg: GuardianConfig = {
  enabled: true,
  dangerouslyBypassPermissions: false,
  trustedWorkspaces: [],
  extraWorkspaceRoots: [],
  consentAcknowledged: null,
};
// fake resolver: "inside" iff the path starts with CWD or /tmp.
const resolver: PathResolver = {
  contains: (p) => ({ resolved: p, inside: p.startsWith(CWD) || p.startsWith("/tmp") }),
};
const deps = { resolver, home: HOME };
function req(extra: Partial<PolicyRequest> & Record<string, unknown>): PolicyRequest {
  return {
    toolName: "bash",
    toolInput: {},
    modelTier: "trusted",
    config: baseCfg,
    interactive: true,
    cwd: CWD,
    ...extra,
  } as PolicyRequest;
}

describe("decide", () => {
  it("bypass allows everything", () => {
    const cfg = { ...baseCfg, dangerouslyBypassPermissions: true };
    expect(
      decide(req({ toolName: "bash", toolInput: { command: "rm -rf /" }, config: cfg }), deps)
        .decision,
    ).toBe("allow");
  });
  it("catastrophic bash denies even for trusted", () => {
    expect(decide(req({ toolInput: { command: "sudo rm -rf /" } }), deps).decision).toBe("deny");
  });
  it("safe bash allows", () => {
    expect(decide(req({ toolInput: { command: "ls -la" } }), deps).decision).toBe("allow");
  });
  it("safe read-command on a sensitive path -> ask (trusted) / deny (weak)", () => {
    expect(
      decide(req({ toolInput: { command: "cat /home/alice/.ssh/id_rsa" } }), deps).decision,
    ).toBe("ask");
    expect(
      decide(
        req({ modelTier: "weak", toolInput: { command: "cat /home/alice/.ssh/id_rsa" } }),
        deps,
      ).decision,
    ).toBe("deny");
  });
  it("write inside jail allows, outside asks (trusted) / denies (weak)", () => {
    expect(
      decide(req({ toolName: "write", toolInput: { path: "/home/alice/project/out.txt" } }), deps)
        .decision,
    ).toBe("allow");
    expect(
      decide(req({ toolName: "write", toolInput: { path: "/etc/cron.d/x" } }), deps).decision,
    ).toBe("ask");
    expect(
      decide(
        req({ toolName: "write", modelTier: "weak", toolInput: { path: "/etc/cron.d/x" } }),
        deps,
      ).decision,
    ).toBe("deny");
  });
  it("read sensitive -> ask/deny by tier", () => {
    expect(
      decide(req({ toolName: "read", toolInput: { path: "/home/alice/.aws/credentials" } }), deps)
        .decision,
    ).toBe("ask");
    expect(
      decide(
        req({
          toolName: "read",
          modelTier: "weak",
          toolInput: { path: "/home/alice/.aws/credentials" },
        }),
        deps,
      ).decision,
    ).toBe("deny");
  });
  it("unknown bash -> ask (trusted) / deny (weak)", () => {
    expect(decide(req({ toolInput: { command: "python x.py" } }), deps).decision).toBe("ask");
    expect(
      decide(req({ modelTier: "weak", toolInput: { command: "python x.py" } }), deps).decision,
    ).toBe("deny");
  });
  it("trusted workspace relaxes unknown bash ask -> allow (trusted only)", () => {
    const cfg = { ...baseCfg, trustedWorkspaces: [CWD] };
    expect(decide(req({ config: cfg, toolInput: { command: "python x.py" } }), deps).decision).toBe(
      "allow",
    );
    expect(
      decide(req({ config: cfg, modelTier: "weak", toolInput: { command: "python x.py" } }), deps)
        .decision,
    ).toBe("ask");
  });
  it("non-interactive turns ask into deny", () => {
    expect(
      decide(req({ interactive: false, toolInput: { command: "python x.py" } }), deps).decision,
    ).toBe("deny");
  });
  it("non-bash, non-file tools (galaxy_*) are allowed", () => {
    expect(decide(req({ toolName: "galaxy_search_tools", toolInput: {} }), deps).decision).toBe(
      "allow",
    );
  });
});
