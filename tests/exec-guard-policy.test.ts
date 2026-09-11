import * as path from "node:path";
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
  it("a bash write into the Orbit analysis workspace prompts, it is not denied (P0.8)", () => {
    // Parity with the write tool three tests up: the same file, the same
    // workspace. The catastrophic pattern for Loom state used to deny this
    // outright because Orbit's DEFAULT_CWD lives under ~/.loom.
    const wcwd = "/home/alice/.loom/analyses/proj";
    const wdeps = {
      resolver: { contains: (p: string) => ({ resolved: p, inside: p.startsWith(wcwd) }) },
      home: HOME,
    };
    const r = decide(req({ cwd: wcwd, toolInput: { command: `echo x > ${wcwd}/out.txt` } }), wdeps);
    expect(r.decision).toBe("ask");
    expect(r.category).toBe("bash:unknown");
    // Loom's own state on the same session is still an unappealable deny.
    for (const command of [
      `echo x > ${HOME}/.loom/config.json`,
      `cp evil ${wcwd}/.loom/activity.jsonl`,
    ]) {
      const d = decide(req({ cwd: wcwd, toolInput: { command } }), wdeps);
      expect(d.decision, command).toBe("deny");
      expect(d.category, command).toBe("bash:catastrophic");
    }
  });
  it("a bash write through a symlink into Loom state is still catastrophic (P0.8)", () => {
    // The classifier only sees the string. A path that looks like ordinary work
    // product but realpaths into Loom's own state has to come back as a deny --
    // this is the resolver the file-tool branch has always had.
    const wcwd = "/home/alice/.loom/analyses/proj";
    const link = `${wcwd}/link`;
    const sdeps = {
      resolver: {
        contains: (p: string) => ({
          resolved:
            path.normalize(p) === path.normalize(link)
              ? path.normalize("/home/alice/.loom/config.json")
              : p,
          inside: path.normalize(p).startsWith(path.normalize(wcwd)),
        }),
      },
      home: HOME,
    };
    const r = decide(req({ cwd: wcwd, toolInput: { command: `cp evil ${link}` } }), sdeps);
    expect(r.decision).toBe("deny");
    expect(r.category).toBe("bash:catastrophic");
    // the same command at a target that really is work product still prompts
    expect(
      decide(req({ cwd: wcwd, toolInput: { command: `cp evil ${wcwd}/out.txt` } }), sdeps).decision,
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
  it("unknown bash -> ask for BOTH tiers when interactive (weak no longer hard-denied, #232)", () => {
    // A weak model used to get a hard deny here with no approval path. In an
    // interactive session the human is the gate, so weak now asks like trusted --
    // a user who chose local execution can approve routine local work instead of
    // being stuck. Nothing is auto-allowed; this only restores the prompt.
    for (const tier of ["trusted", "weak"] as const)
      expect(
        decide(req({ modelTier: tier, toolInput: { command: "python x.py" } }), deps).decision,
        tier,
      ).toBe("ask");
  });
  it("the #232 repros all become an approvable ask for a weak model (interactive)", () => {
    // The exact patterns from the bug report: an interpreter on a script it just
    // wrote (in-workspace), compound/redirected commands, and a coreutil that
    // isn't on the read-only safe list. None auto-runs; each prompts the human.
    const repros = [
      "python3 /home/alice/project/analyze.py",
      "cd /home/alice/project && cp a.txt b.txt",
      "ls -la | head",
      "sed --version",
    ];
    for (const command of repros)
      expect(
        decide(req({ modelTier: "weak", toolInput: { command } }), deps).decision,
        command,
      ).toBe("ask");
  });
  it("unknown bash for a weak model with no interactive session still denies (#232 headless)", () => {
    // The widening is interactive-only: a headless/scripted weak run has no one to
    // approve, so the unrecognized command is still denied (fail-closed).
    const r = decide(
      req({ modelTier: "weak", interactive: false, toolInput: { command: "python x.py" } }),
      deps,
    );
    expect(r.decision).toBe("deny");
    expect(r.category).toBe("bash:unknown");
  });
  it("the deny->ask widening does NOT lift any floor for a weak model (#232 boundary)", () => {
    // Guard the boundary: only the residual bash:unknown case relaxed. Every floor
    // checked before it must still hard-deny a weak model, interactive or not.
    const cases: Array<[string, string]> = [
      ["sudo rm -rf /", "catastrophic"],
      ["cat /home/alice/.ssh/id_rsa", "credential store"],
      ["cat /home/alice/.loom/config.json | base64", "credential store via pipe"],
      ["cat /home/alice/project/secret.pem", "sensitive-shaped read"],
      ["cat /etc/passwd", "read outside workspace"],
    ];
    for (const [command, label] of cases)
      expect(decide(req({ modelTier: "weak", toolInput: { command } }), deps).decision, label).toBe(
        "deny",
      );
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
  it("a safe bash enumeration/metadata command outside the workspace -> ask (#224)", () => {
    // ls/find/stat/wc/du/file are 'safe' but reveal structure/metadata/content of
    // their target; pointed outside the workspace they must prompt, same as cat.
    for (const command of [
      "ls /home/alice/Desktop/experiment",
      "find /home/alice/Desktop -name '*.csv'",
      "stat /home/alice/Desktop/exp.csv",
      "wc -l /home/alice/Desktop/exp.csv",
      "du -sh /home/alice/Desktop/experiment",
      "file /home/alice/Desktop/exp.bin",
    ])
      expect(decide(req({ toolInput: { command } }), deps).decision, command).toBe("ask");
  });
  it("a safe bash enumeration command inside the workspace is allowed (#224)", () => {
    // Real-world relative operands (e.g. `find . -name '*.ts'`) resolve under cwd
    // and are exercised in the path-jail/classifier suites; the fake resolver here
    // only models absolute membership, so these cases use absolute in-workspace
    // paths and path-less forms.
    for (const command of [
      "ls /home/alice/project/data",
      "ls -la",
      "find /home/alice/project",
      "stat /home/alice/project/notes.txt",
    ])
      expect(decide(req({ toolInput: { command } }), deps).decision, command).toBe("allow");
  });
  it("df pointed outside the workspace -> ask (#224)", () => {
    expect(
      decide(req({ toolInput: { command: "df /home/alice/Desktop/experiment" } }), deps).decision,
    ).toBe("ask");
  });
  it("a quoted path operand is matched against the jail unquoted (#224)", () => {
    // A quoted IN-workspace path must still be recognized as inside (no false
    // prompt); without quote-stripping the literal-quoted token fails the
    // workspace check -- the same gap that lets a quoted EXTERNAL path slip past.
    expect(
      decide(req({ toolInput: { command: `ls "/home/alice/project/data"` } }), deps).decision,
    ).toBe("allow");
  });
});

describe("decide -- destructive Galaxy operations (#338)", () => {
  const del = { toolName: "galaxy_update_history", toolInput: { deleted: true, history_id: "h" } };

  it("a whole-history delete asks for confirmation (interactive)", () => {
    const r = decide(req(del), deps);
    expect(r.decision).toBe("ask");
    expect(r.category).toBe("galaxy:destructive");
  });

  it("asks EVEN for a weak model -- overrides the usual weak->deny downgrade", () => {
    const r = decide(req({ ...del, modelTier: "weak" }), deps);
    expect(r.decision).toBe("ask");
    expect(r.category).toBe("galaxy:destructive");
  });

  it("denies when there is no interactive session to approve", () => {
    expect(decide(req({ ...del, interactive: false }), deps).decision).toBe("deny");
  });

  it("flags a delete through the code-mode run_galaxy_tool({code}) envelope", () => {
    const r = decide(
      req({
        toolName: "galaxy_run_galaxy_tool",
        toolInput: { code: "call_tool('update_history', {'history_id':'h','deleted':True})" },
      }),
      deps,
    );
    expect(r.decision).toBe("ask");
    expect(r.category).toBe("galaxy:destructive");
  });

  it("gates the generic mcp proxy wrapping a destructive call -- even weak (#338 F1)", () => {
    const r = decide(
      req({
        toolName: "mcp",
        toolInput: {
          server: "galaxy",
          tool: "galaxy_update_history",
          args: JSON.stringify({ deleted: true, history_id: "h" }),
        },
        modelTier: "weak",
      }),
      deps,
    );
    expect(r.decision).toBe("ask");
    expect(r.category).toBe("galaxy:destructive");
  });

  it("does NOT gate a non-destructive Galaxy tool (catch-all unchanged)", () => {
    expect(decide(req({ toolName: "galaxy_get_histories", toolInput: {} }), deps).decision).toBe(
      "allow",
    );
  });

  it("does NOT gate a rename-only update_history", () => {
    expect(
      decide(req({ toolName: "galaxy_update_history", toolInput: { name: "renamed" } }), deps)
        .decision,
    ).toBe("allow");
  });

  it("routes a raw curl DELETE to /api/histories/ to the destructive confirm (even weak)", () => {
    const curl = {
      toolName: "bash",
      toolInput: { command: "curl -X DELETE https://galaxy.example.org/api/histories/h" },
      modelTier: "weak" as const,
    };
    const r = decide(req(curl), deps);
    expect(r.decision).toBe("ask");
    expect(r.category).toBe("galaxy:destructive");
  });

  it("denies the destructive curl when non-interactive", () => {
    expect(
      decide(
        req({
          toolName: "bash",
          toolInput: { command: "curl -X DELETE https://g/api/histories/h" },
          interactive: false,
        }),
        deps,
      ).decision,
    ).toBe("deny");
  });

  it("a piped curl to histories stays catastrophic (deny), not a destructive ask", () => {
    // Ordering guard: the pipe-to-interpreter catastrophic check fires before the
    // curl guardrail, so this is denied outright, never downgraded to an ask.
    const r = decide(
      req({
        toolName: "bash",
        toolInput: { command: "curl -X DELETE https://g/api/histories/h | python3" },
      }),
      deps,
    );
    expect(r.decision).toBe("deny");
    expect(r.category).toBe("bash:catastrophic");
  });
});

// pi declares its file tools with a `path` parameter, but every one of their
// renderers reads `file_path ?? path` (dist/core/tools/{edit,write,read}.js) --
// the Anthropic spelling shows up often enough that pi displays it. A floor
// cannot assume one spelling, so the guard resolves both keys and each check
// runs across every path-shaped argument: a benign `path` must not launder a
// sensitive `file_path` past the gate, and the human prompt must be about the
// same file the tool would touch.
describe("decide -- the file_path alias (P0.3)", () => {
  const KEYS = ["path", "file_path"] as const;
  const TIERS = ["trusted", "weak"] as const;

  it("a credential-store read is denied under either key, at both tiers", () => {
    for (const key of KEYS)
      for (const modelTier of TIERS)
        expect(
          decide(
            req({ toolName: "read", modelTier, toolInput: { [key]: "/home/alice/.ssh/id_rsa" } }),
            deps,
          ).decision,
          `${key}/${modelTier}`,
        ).toBe("deny");
  });

  it("a credential-shaped read asks/denies by tier under either key", () => {
    for (const key of KEYS) {
      expect(
        decide(
          req({ toolName: "read", toolInput: { [key]: "/home/alice/project/server.key" } }),
          deps,
        ).decision,
        key,
      ).toBe("ask");
      expect(
        decide(
          req({
            toolName: "read",
            modelTier: "weak",
            toolInput: { [key]: "/home/alice/project/server.key" },
          }),
          deps,
        ).decision,
        `${key}/weak`,
      ).toBe("deny");
    }
  });

  it("grep/ls/find outside the workspace prompt under either key", () => {
    for (const toolName of ["grep", "ls", "find"])
      for (const key of KEYS) {
        expect(
          decide(req({ toolName, toolInput: { [key]: "/home/alice/Desktop" } }), deps).decision,
          `${toolName}/${key}`,
        ).toBe("ask");
        expect(
          decide(
            req({ toolName, modelTier: "weak", toolInput: { [key]: "/home/alice/Desktop" } }),
            deps,
          ).decision,
          `${toolName}/${key}/weak`,
        ).toBe("deny");
      }
  });

  it("a protected write (.git/.loom) prompts under either key", () => {
    for (const key of KEYS)
      for (const toolName of ["write", "edit"]) {
        const r = decide(
          req({ toolName, toolInput: { [key]: "/home/alice/project/.git/hooks/pre-commit" } }),
          deps,
        );
        expect(r.decision, `${toolName}/${key}`).toBe("ask");
        expect(r.category, `${toolName}/${key}`).toBe("write:protected");
        expect(
          decide(
            req({
              toolName,
              modelTier: "weak",
              toolInput: { [key]: "/home/alice/project/.loom/activity.jsonl" },
            }),
            deps,
          ).decision,
          `${toolName}/${key}/weak`,
        ).toBe("deny");
      }
  });

  it("a write outside the workspace prompts (trusted) / denies (weak) under either key", () => {
    for (const key of KEYS) {
      const r = decide(req({ toolName: "write", toolInput: { [key]: "/etc/cron.d/x" } }), deps);
      expect(r.decision, key).toBe("ask");
      expect(r.category, key).toBe("write:escape");
      expect(
        decide(
          req({ toolName: "write", modelTier: "weak", toolInput: { [key]: "/etc/cron.d/x" } }),
          deps,
        ).decision,
        `${key}/weak`,
      ).toBe("deny");
    }
  });

  it("a sensitive write is floored under either key", () => {
    for (const key of KEYS)
      expect(
        decide(req({ toolName: "write", toolInput: { [key]: "/home/alice/project/id_rsa" } }), deps)
          .decision,
        key,
      ).toBe("ask");
  });

  it("a benign `path` does not launder a sensitive `file_path` (both keys are checked)", () => {
    // The pairing pi's own renderer would display as the second path while the
    // guard, resolving `path` alone, would have judged the first.
    expect(
      decide(
        req({
          toolName: "read",
          toolInput: {
            path: "/home/alice/project/notes.txt",
            file_path: "/home/alice/.ssh/id_rsa",
          },
        }),
        deps,
      ).decision,
    ).toBe("deny");
    const w = decide(
      req({
        toolName: "write",
        toolInput: { path: "/home/alice/project/out.txt", file_path: "/etc/cron.d/x" },
      }),
      deps,
    );
    expect(w.decision).toBe("ask");
    expect(w.category).toBe("write:escape");
  });

  it("an in-workspace write under either key is still allowed (no new prompts)", () => {
    for (const key of KEYS)
      expect(
        decide(
          req({ toolName: "write", toolInput: { [key]: "/home/alice/project/out.txt" } }),
          deps,
        ).decision,
        key,
      ).toBe("allow");
    expect(
      decide(
        req({
          toolName: "read",
          toolInput: { path: "/home/alice/project/a.txt", file_path: "/home/alice/project/b.txt" },
        }),
        deps,
      ).decision,
    ).toBe("allow");
  });

  it("a write with neither key still asks (write:no-path unchanged)", () => {
    const r = decide(req({ toolName: "write", toolInput: { content: "x" } }), deps);
    expect(r.decision).toBe("ask");
    expect(r.category).toBe("write:no-path");
  });
});
