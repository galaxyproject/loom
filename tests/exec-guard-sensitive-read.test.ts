import { describe, it, expect } from "vitest";
import {
  isSensitivePath,
  isCredentialStore,
  isProtectedWritePath,
} from "../extensions/loom/exec-guard/sensitive-read";

const HOME = "/home/alice";
describe("isSensitivePath", () => {
  it("flags ssh, aws, gcloud, netrc, env, loom config", () => {
    for (const p of [
      "/home/alice/.ssh/id_rsa",
      "/home/alice/.aws/credentials",
      "/home/alice/.config/gcloud/access_tokens.db",
      "/home/alice/.netrc",
      "/home/alice/project/.env",
      "/home/alice/.loom/config.json",
    ])
      expect(isSensitivePath(p, HOME), p).toBe(true);
  });
  it("flags key/pem files anywhere", () => {
    expect(isSensitivePath("/home/alice/project/server.key", HOME)).toBe(true);
    expect(isSensitivePath("/tmp/foo.pem", HOME)).toBe(true);
  });
  it("flags macOS keychains", () => {
    expect(isSensitivePath("/home/alice/Library/Keychains/login.keychain-db", HOME)).toBe(true);
    expect(isSensitivePath("/home/alice/Library/Keychains/x.keychain", HOME)).toBe(true);
  });
  it("allows ordinary project files", () => {
    expect(isSensitivePath("/home/alice/project/notebook.md", HOME)).toBe(false);
    expect(isSensitivePath("/home/alice/project/data/reads.fastq", HOME)).toBe(false);
  });
});

// Dedicated credential stores: a subset of sensitive paths whose CONTENTS the
// agent has no business reading, so reads are denied for ALL model tiers (not
// downgraded to an ask). This is the floor that closes #183 -- ~/.loom/config.json
// is a store; a credential-SHAPED file that might be a project fixture is not.
describe("isCredentialStore", () => {
  it("flags the dedicated home credential stores (dirs + exact files)", () => {
    for (const p of [
      "/home/alice/.ssh/id_rsa",
      "/home/alice/.aws/credentials",
      "/home/alice/.gnupg/secring.gpg",
      "/home/alice/.config/gcloud/access_tokens.db",
      "/home/alice/.kube/config",
      "/home/alice/.docker/config.json",
      "/home/alice/Library/Keychains/login.keychain-db",
      "/home/alice/.netrc",
      "/home/alice/.pgpass",
      "/home/alice/.npmrc",
      "/home/alice/.loom/config.json",
    ])
      expect(isCredentialStore(p, HOME), p).toBe(true);
  });
  it("does NOT flag credential-shaped files that may be project fixtures", () => {
    // sensitive by basename, but not a dedicated store -> stays an ask, not a deny
    expect(isCredentialStore("/home/alice/project/.env", HOME)).toBe(false);
    expect(isCredentialStore("/home/alice/project/server.key", HOME)).toBe(false);
    expect(isCredentialStore("/tmp/foo.pem", HOME)).toBe(false);
    // every store is still sensitive; the inverse just isn't true
    expect(isSensitivePath("/home/alice/project/.env", HOME)).toBe(true);
  });
  it("does NOT flag ordinary files, and is not fooled by lookalikes", () => {
    expect(isCredentialStore("/home/alice/project/notebook.md", HOME)).toBe(false);
    expect(isCredentialStore("/home/alice/.loom/analyses/proj/config.json", HOME)).toBe(false);
    expect(isCredentialStore("/home/alice/.sshconfig", HOME)).toBe(false);
  });
});

describe("isProtectedWritePath", () => {
  it("flags writes under .git or .loom", () => {
    expect(isProtectedWritePath("/home/alice/project/.git/hooks/pre-commit")).toBe(true);
    expect(isProtectedWritePath("/home/alice/project/.git/config")).toBe(true);
    expect(isProtectedWritePath("/home/alice/project/.loom/config.json")).toBe(true);
  });
  it("allows ordinary project writes", () => {
    expect(isProtectedWritePath("/home/alice/project/notebook.md")).toBe(false);
    expect(isProtectedWritePath("/home/alice/project/src/main.py")).toBe(false);
    // not fooled by a substring -- only a real path segment counts
    expect(isProtectedWritePath("/home/alice/project/gitignore.md")).toBe(false);
  });

  // Orbit files analyses under $HOME/.loom/analyses/<name>, so the workspace's own
  // ancestry contains a .loom segment. That ancestor must NOT make every write
  // "protected" -- only real Loom state / git dirs should gate.
  it("allows analysis work product under ~/.loom/analyses (ancestor .loom carved out)", () => {
    expect(isProtectedWritePath("/home/alice/.loom/analyses/proj/notebook.md", HOME)).toBe(false);
    expect(isProtectedWritePath("/home/alice/.loom/analyses/proj/src/run.py", HOME)).toBe(false);
  });
  it("still flags .git/.loom state nested inside an analysis", () => {
    expect(isProtectedWritePath("/home/alice/.loom/analyses/proj/.loom/activity.jsonl", HOME)).toBe(
      true,
    );
    expect(
      isProtectedWritePath("/home/alice/.loom/analyses/proj/.git/hooks/pre-commit", HOME),
    ).toBe(true);
  });
  it("flags Loom home state OUTSIDE the analyses tree", () => {
    expect(isProtectedWritePath("/home/alice/.loom/sessions/s1/activity.jsonl", HOME)).toBe(true);
    expect(isProtectedWritePath("/home/alice/.loom/cache/skills/x.md", HOME)).toBe(true);
    expect(isProtectedWritePath("/home/alice/.loom/config.json", HOME)).toBe(true);
  });
  // regression (adversarial review): a .git must never be relativized/carved away,
  // even when the cwd itself sits inside a .git dir -- hook injection stays gated.
  it("flags a real .git even when it is the cwd's own ancestor", () => {
    expect(isProtectedWritePath("/home/alice/project/.git/hooks/pre-commit", HOME)).toBe(true);
  });
  // regression: a per-workspace .loom for a normal (non-analyses) cwd still gates.
  it("flags a per-workspace .loom outside the analyses tree", () => {
    expect(isProtectedWritePath("/home/alice/myproj/.loom/activity.jsonl", HOME)).toBe(true);
  });
  it("folds case on the .git/.loom segment (macOS HFS+)", () => {
    expect(isProtectedWritePath("/home/alice/project/.Git/hooks/x", HOME)).toBe(true);
    expect(isProtectedWritePath("/home/alice/.loom/analyses/proj/.LOOM/x", HOME)).toBe(true);
  });
  it("with no home, falls back to the absolute-path check", () => {
    expect(isProtectedWritePath("/home/alice/.loom/analyses/proj/notebook.md")).toBe(true);
    expect(isProtectedWritePath("/home/alice/project/.git/config")).toBe(true);
  });
});
