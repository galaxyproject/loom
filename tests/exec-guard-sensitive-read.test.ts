import { describe, it, expect } from "vitest";
import {
  isSensitivePath,
  isCredentialStore,
  isProtectedWritePath,
  isLoomStatePath,
} from "../extensions/loom/exec-guard/sensitive-read";
import { WORKSPACE_STATE_DIR_NAMES } from "../extensions/loom/workspace-state-dir";

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
      "/home/alice/.orbit/config.json",
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
describe("credential stores on a case-insensitive filesystem", () => {
  // macOS is case-insensitive and its realpath does not normalize case, so an
  // exact-case list only half-covers these directories: `library/keychains`
  // and `Library/Keychains` are the same folder and only one of them was
  // refused. The web file surface reads through this policy, so the miss was
  // reachable from a browser with the session cwd at $HOME.
  it.each([
    "/home/alice/library/keychains/user.kb",
    "/home/alice/LIBRARY/KEYCHAINS/user.kb",
    "/home/alice/.SSH/known_hosts",
    "/home/alice/.Config/GCloud/creds.db",
    "/home/alice/.AWS/credentials.bak",
  ])("refuses %s whatever case it is written in", (p) => {
    expect(isCredentialStore(p, HOME), p).toBe(true);
    expect(isSensitivePath(p, HOME), p).toBe(true);
  });

  it.each(["/home/alice/.NETRC", "/home/alice/.Loom/Config.json"])(
    "refuses the exact-file entry %s whatever case it is written in",
    (p) => {
      expect(isCredentialStore(p, HOME), p).toBe(true);
    },
  );

  it("still lets an ordinary file through", () => {
    expect(isCredentialStore("/home/alice/project/Library/notes.md", HOME)).toBe(false);
    expect(isSensitivePath("/home/alice/project/Keychains.md", HOME)).toBe(false);
  });
});

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
      "/home/alice/.orbit/config.json",
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

// Every state-dir case above, for each spelling. A workspace uses one of them,
// but the other is state too -- in any workspace.
describe.each(WORKSPACE_STATE_DIR_NAMES)("isProtectedWritePath / isLoomStatePath -- %s", (D) => {
  const OTHER = WORKSPACE_STATE_DIR_NAMES.find((n) => n !== D)!;
  it("flags writes under the state dir", () => {
    expect(isProtectedWritePath(`/home/alice/project/${D}/config.json`)).toBe(true);
    expect(isLoomStatePath(`/home/alice/project/${D}/config.json`)).toBe(true);
  });
  it("allows analysis work product under ~/<state>/analyses", () => {
    expect(isProtectedWritePath(`/home/alice/${D}/analyses/proj/notebook.md`, HOME)).toBe(false);
    expect(isProtectedWritePath(`/home/alice/${D}/analyses/proj/src/run.py`, HOME)).toBe(false);
  });
  it("still flags .git and either state dir nested inside an analysis", () => {
    for (const nested of [D, OTHER]) {
      expect(
        isProtectedWritePath(`/home/alice/${D}/analyses/proj/${nested}/activity.jsonl`, HOME),
        nested,
      ).toBe(true);
    }
    expect(isProtectedWritePath(`/home/alice/${D}/analyses/proj/.git/hooks/pre-commit`, HOME)).toBe(
      true,
    );
  });
  it("flags home state outside the analyses tree", () => {
    expect(isProtectedWritePath(`/home/alice/${D}/sessions/s1/activity.jsonl`, HOME)).toBe(true);
    expect(isProtectedWritePath(`/home/alice/${D}/cache/skills/x.md`, HOME)).toBe(true);
    expect(isProtectedWritePath(`/home/alice/${D}/config.json`, HOME)).toBe(true);
  });
  it("flags a per-workspace state dir outside the analyses tree", () => {
    expect(isProtectedWritePath(`/home/alice/myproj/${D}/activity.jsonl`, HOME)).toBe(true);
    expect(isProtectedWritePath(`/home/alice/myproj/${D}/env/bin/python`, HOME)).toBe(true);
  });
  it("folds case on the segment (macOS HFS+)", () => {
    expect(isProtectedWritePath(`/home/alice/myproj/${D.toUpperCase()}/x`, HOME)).toBe(true);
    expect(
      isProtectedWritePath(`/home/alice/${D}/analyses/proj/${OTHER.toUpperCase()}/x`, HOME),
    ).toBe(true);
  });
  // path.win32.relative folds case, and on NTFS .LOOM really is the same dir as .loom.
  it.skipIf(process.platform === "win32")(
    "does not fold case on the carve-out (folding would widen an exemption)",
    () => {
      expect(
        isProtectedWritePath(`/home/alice/${D.toUpperCase()}/analyses/proj/notebook.md`, HOME),
      ).toBe(true);
    },
  );
  it("with no home, falls back to the absolute-path check", () => {
    expect(isProtectedWritePath(`/home/alice/${D}/analyses/proj/notebook.md`)).toBe(true);
  });
  it("a directory that merely ends in the name is not state", () => {
    expect(isProtectedWritePath(`/data/My${D}/foo`, HOME)).toBe(false);
  });
});

describe("isLoomStatePath -- a home that is itself under a state dir", () => {
  it.each(WORKSPACE_STATE_DIR_NAMES)("gets no %s/analyses carve-out", (D) => {
    for (const odd of ["/srv/.loom/alice", "/srv/.orbit/alice"]) {
      expect(isLoomStatePath(`${odd}/${D}/analyses/p/out.txt`, odd), odd).toBe(true);
    }
  });
});
