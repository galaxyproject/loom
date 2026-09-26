import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { isCredentialStore } from "../extensions/loom/exec-guard/sensitive-read";
import { decide } from "../extensions/loom/exec-guard/policy";
import { buildSandboxConfig } from "../extensions/loom/sandbox/sandbox-config";
import type {
  GuardianConfig,
  PathResolver,
  PolicyRequest,
} from "../extensions/loom/exec-guard/types";

// The brain config lives at ~/.loom/config.json, or ~/.orbit/config.json once a
// newer release has put one there. Both hold the same keys, so every gate that
// knows one has to know the other, however a command spells the path.

const HOME = "/home/alice";
const CWD = "/home/alice/project";
const CONFIGS = [".loom/config.json", ".orbit/config.json"];

const cfg: GuardianConfig = {
  enabled: true,
  dangerouslyBypassPermissions: false,
  trustedWorkspaces: [CWD],
  extraWorkspaceRoots: [],
  consentAcknowledged: null,
  sandbox: false,
};
// posix.resolve so Windows doesn't prefix these fake POSIX paths with a drive
// letter that HOME lacks.
const resolver: PathResolver = {
  contains: (p) => {
    const resolved = nodePath.posix.resolve(CWD, p.replace(/^~(?=$|\/)/, HOME));
    return { resolved, inside: resolved.startsWith(CWD) };
  },
};
const deps = { resolver, home: HOME };
const req = (toolName: string, toolInput: Record<string, unknown>): PolicyRequest =>
  ({
    toolName,
    toolInput,
    modelTier: "trusted",
    config: cfg,
    interactive: true,
    cwd: CWD,
  }) as PolicyRequest;

describe.each(CONFIGS)("~/%s", (rel) => {
  const abs = `${HOME}/${rel}`;

  it("is a credential store for the read tool and a shell read", () => {
    expect(decide(req("read", { path: abs }), deps).category).toBe("read:credential-store");
    for (const command of [`cat ~/${rel} | head`, `cat ${abs}`]) {
      expect(decide(req("bash", { command }), deps).category, command).toBe(
        "read:credential-store",
      );
    }
  });

  it("refuses a shell write or move however the path is spelled", () => {
    for (const command of [
      `echo '{}' > ~/${rel}`,
      `echo '{}' > "$HOME"/${rel}`,
      `cp /tmp/x "\${HOME}/${rel}"`,
      `tee ${abs} < /tmp/x`,
      `dd if=/dev/null of=${abs}`,
      `dd if=/dev/null of=~/${rel}`,
      `mv ${abs} /tmp/x`,
    ]) {
      expect(decide(req("bash", { command }), deps).decision, command).toBe("deny");
    }
  });

  it("gates the write tool", () => {
    expect(decide(req("write", { path: abs }), deps).decision).not.toBe("allow");
  });

  it("is on the sandbox's read-deny list", () => {
    const c = buildSandboxConfig({ cwd: CWD, tmpDir: "/tmp" });
    expect(c.filesystem.denyRead).toContain(`~/${rel}`);
  });
});

describe("default config symlinked elsewhere", () => {
  it.each(CONFIGS)("still treats ~/%s's target as the key store", (rel) => {
    const home = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "cfg-link-")));
    try {
      const target = nodePath.join(home, "work", "settings.json");
      fs.mkdirSync(nodePath.dirname(target), { recursive: true });
      fs.writeFileSync(target, "{}");
      fs.mkdirSync(nodePath.dirname(nodePath.join(home, rel)));
      fs.symlinkSync(target, nodePath.join(home, rel));
      expect(isCredentialStore(target, home)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
