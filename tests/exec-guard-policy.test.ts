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
  sandbox: false,
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
  it("read of a credential store is denied for ALL tiers (bash)", () => {
    // hardened (#183): a dedicated credential store is never readable, even by a
    // capable model with an interactive session to approve.
    for (const tier of ["trusted", "weak"] as const)
      expect(
        decide(
          req({ modelTier: tier, toolInput: { command: "cat /home/alice/.ssh/id_rsa" } }),
          deps,
        ).decision,
        tier,
      ).toBe("deny");
  });
  it("reading ~/.loom/config.json is denied for all tiers and via any path (#183)", () => {
    const cfg = "/home/alice/.loom/config.json";
    for (const tier of ["trusted", "weak"] as const)
      expect(
        decide(req({ modelTier: tier, toolInput: { command: `cat ${cfg}` } }), deps).decision,
        `cat/${tier}`,
      ).toBe("deny");
    expect(
      decide(req({ toolName: "read", toolInput: { path: cfg } }), deps).decision,
      "read tool",
    ).toBe("deny");
    // the reported evasion: a pipe forced kind="unknown" so the floor was skipped.
    expect(
      decide(req({ toolInput: { command: `cat ${cfg} | python3 -m json.tool` } }), deps).decision,
      "piped",
    ).toBe("deny");
  });
  it("the credential-store floor is NOT lifted by a trusted workspace", () => {
    const cfg = { ...baseCfg, trustedWorkspaces: [CWD] };
    expect(
      decide(
        req({ config: cfg, toolInput: { command: "cat /home/alice/.loom/config.json | base64" } }),
        deps,
      ).decision,
    ).toBe("deny");
  });
  it("a credential-SHAPED file that is not a dedicated store still asks/denies by tier", () => {
    // basename .key/.pem can be a project fixture -> keep the prompt, don't hard-deny
    expect(
      decide(req({ toolName: "read", toolInput: { path: "/home/alice/project/server.key" } }), deps)
        .decision,
    ).toBe("ask");
    expect(
      decide(
        req({
          toolName: "read",
          modelTier: "weak",
          toolInput: { path: "/home/alice/project/server.key" },
        }),
        deps,
      ).decision,
    ).toBe("deny");
    expect(
      decide(req({ toolInput: { command: "cat /home/alice/project/secret.pem" } }), deps).decision,
    ).toBe("ask");
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
  it("read tool on a credential store is denied for ALL tiers", () => {
    for (const tier of ["trusted", "weak"] as const)
      expect(
        decide(
          req({
            toolName: "read",
            modelTier: tier,
            toolInput: { path: "/home/alice/.aws/credentials" },
          }),
          deps,
        ).decision,
        tier,
      ).toBe("deny");
  });
  it("grep/ls/find of a credential store is denied for ALL tiers", () => {
    for (const tool of ["grep", "ls", "find"])
      for (const tier of ["trusted", "weak"] as const)
        expect(
          decide(
            req({
              toolName: tool,
              modelTier: tier,
              toolInput: { path: "/home/alice/.ssh/id_rsa" },
            }),
            deps,
          ).decision,
          `${tool}/${tier}`,
        ).toBe("deny");
  });
  it("grep with no path (searches cwd) is allowed", () => {
    expect(decide(req({ toolName: "grep", toolInput: { pattern: "TODO" } }), deps).decision).toBe(
      "allow",
    );
  });
  it("write/edit to a sensitive path is floored even inside the jail", () => {
    // id_rsa lives inside the workspace here, but its credential shape must win.
    expect(
      decide(req({ toolName: "write", toolInput: { path: "/home/alice/project/id_rsa" } }), deps)
        .decision,
    ).toBe("ask");
    expect(
      decide(
        req({ toolName: "edit", toolInput: { path: "/home/alice/project/secrets.pem" } }),
        deps,
      ).decision,
    ).toBe("ask");
    // weak model downgrades the ask to a deny, same as a sensitive read.
    expect(
      decide(
        req({
          toolName: "write",
          modelTier: "weak",
          toolInput: { path: "/home/alice/project/.env" },
        }),
        deps,
      ).decision,
    ).toBe("deny");
  });
  it("write to .git or .loom prompts even inside the workspace", () => {
    expect(
      decide(
        req({
          toolName: "write",
          toolInput: { path: "/home/alice/project/.git/hooks/pre-commit" },
        }),
        deps,
      ).decision,
    ).toBe("ask");
    expect(
      decide(
        req({ toolName: "edit", toolInput: { path: "/home/alice/project/.loom/config.json" } }),
        deps,
      ).decision,
    ).toBe("ask");
  });
  it("allows writes when the workspace itself lives under ~/.loom (Orbit default cwd)", () => {
    // Orbit's DEFAULT_CWD is ~/.loom/analyses, so the analysis workspace sits
    // under a .loom segment. The notebook the agent edits constantly must be
    // allowed, while .loom/.git state *inside* the workspace still prompts.
    const wcwd = "/home/alice/.loom/analyses/proj";
    const wresolver: PathResolver = {
      contains: (p) => ({ resolved: p, inside: p.startsWith(wcwd) || p.startsWith("/tmp") }),
    };
    const wdeps = { resolver: wresolver, home: HOME };
    expect(
      decide(
        req({ cwd: wcwd, toolName: "edit", toolInput: { path: `${wcwd}/notebook.md` } }),
        wdeps,
      ).decision,
    ).toBe("allow");
    expect(
      decide(
        req({ cwd: wcwd, toolName: "write", toolInput: { path: `${wcwd}/.loom/activity.jsonl` } }),
        wdeps,
      ).decision,
    ).toBe("ask");
    expect(
      decide(
        req({ cwd: wcwd, toolName: "write", toolInput: { path: `${wcwd}/.git/hooks/pre-commit` } }),
        wdeps,
      ).decision,
    ).toBe("ask");
  });
  it("gates a .git write even when cwd is inside the .git dir (no carve-away)", () => {
    // adversarial-review regression: the protected floor must not relativize a
    // real .git away just because the session cwd happens to sit inside it.
    const gcwd = "/home/alice/project/.git";
    const gres: PathResolver = {
      contains: (p) => ({ resolved: p, inside: p.startsWith(gcwd) }),
    };
    expect(
      decide(
        req({ cwd: gcwd, toolName: "write", toolInput: { path: `${gcwd}/hooks/pre-commit` } }),
        { resolver: gres, home: HOME },
      ).decision,
    ).toBe("ask");
  });
  it("gates Loom state when cwd is a .loom dir outside the analyses tree", () => {
    // regression B: a .loom state dir as cwd must not carve its own .loom away.
    const lcwd = "/home/alice/.loom/sessions/s1";
    const lres: PathResolver = {
      contains: (p) => ({ resolved: p, inside: p.startsWith(lcwd) }),
    };
    expect(
      decide(req({ cwd: lcwd, toolName: "write", toolInput: { path: `${lcwd}/activity.jsonl` } }), {
        resolver: lres,
        home: HOME,
      }).decision,
    ).toBe("ask");
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
  it("file-tool dispatch is case-insensitive (a capitalized Write can't escape the jail)", () => {
    expect(
      decide(req({ toolName: "Write", toolInput: { path: "/etc/cron.d/x" } }), deps).decision,
    ).toBe("ask"); // not "allow" via the other-tool fallthrough
    expect(
      decide(req({ toolName: "EDIT", toolInput: { path: "/home/alice/project/id_rsa" } }), deps)
        .decision,
    ).toBe("ask");
    expect(
      decide(req({ toolName: "READ", toolInput: { path: "/etc/hosts" } }), deps).decision,
    ).toBe("ask");
  });
  it("non-bash, non-file tools (galaxy_*) are allowed", () => {
    expect(decide(req({ toolName: "galaxy_search_tools", toolInput: {} }), deps).decision).toBe(
      "allow",
    );
  });

  it("reading a non-sensitive file OUTSIDE the workspace -> ask (trusted) / deny (weak)", () => {
    expect(
      decide(req({ toolName: "read", toolInput: { path: "/etc/hosts" } }), deps).decision,
    ).toBe("ask");
    expect(
      decide(req({ toolName: "read", modelTier: "weak", toolInput: { path: "/etc/hosts" } }), deps)
        .decision,
    ).toBe("deny");
  });
  it("reading inside the workspace is allowed", () => {
    expect(
      decide(req({ toolName: "read", toolInput: { path: "/home/alice/project/data/x.csv" } }), deps)
        .decision,
    ).toBe("allow");
  });
  it("a safe bash read outside the workspace -> ask; inside -> allow", () => {
    expect(decide(req({ toolInput: { command: "cat /etc/passwd" } }), deps).decision).toBe("ask");
    expect(
      decide(req({ toolInput: { command: "cat /home/alice/project/notes.txt" } }), deps).decision,
    ).toBe("allow");
  });
});
