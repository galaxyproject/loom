import * as path from "path";

// Directories under $HOME that hold credentials/secrets.
const SENSITIVE_HOME_DIRS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".config/gcloud",
  ".kube",
  ".docker",
  "Library/Keychains",
];
// Exact files under $HOME.
const SENSITIVE_HOME_FILES = [".netrc", ".loom/config.json", ".pgpass", ".npmrc"];
// Basename / extension patterns sensitive anywhere.
const SENSITIVE_BASENAME =
  /^(\.env(\..+)?|id_rsa|id_ed25519|id_ecdsa|.*\.pem|.*\.key|.*\.keychain(-db)?|credentials)$/i;

function within(abs: string, dir: string): boolean {
  const rel = path.relative(dir, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Dedicated credential stores: the home-relative dirs and exact files above
// that exist solely to hold secrets. The agent has no legitimate reason to read
// their CONTENTS, so reads are denied for every model tier (not just downgraded
// to an ask). This is the floor that closes #183 -- ~/.loom/config.json is a
// store. The basename patterns (.env, *.pem, *.key, ...) are deliberately NOT
// stores: those can be project fixtures, so they keep the ask/deny-by-tier path.
export function isCredentialStore(absPath: string, home: string): boolean {
  const norm = path.normalize(absPath);
  for (const d of SENSITIVE_HOME_DIRS) if (within(norm, path.join(home, d))) return true;
  for (const f of SENSITIVE_HOME_FILES) if (norm === path.join(home, f)) return true;
  return false;
}

export function isSensitivePath(absPath: string, home: string): boolean {
  if (isCredentialStore(absPath, home)) return true;
  if (SENSITIVE_BASENAME.test(path.basename(path.normalize(absPath)))) return true;
  return false;
}

// Case-folded path-segment membership. macOS HFS+ is case-insensitive and
// realpath does not normalize case there, so `.Git` / `.LOOM` would otherwise
// dodge the check. Folding may over-match a literal `.Git` dir on case-sensitive
// Linux, but that errs toward protection.
function hasSegment(p: string, name: string): boolean {
  return p.split(path.sep).some((s) => s.toLowerCase() === name);
}

// Write targets gated even inside the workspace jail. A file under `.git`
// (hooks run on the next git operation; config can redirect hooksPath) or under
// `.loom` (Loom's own session state) should never be written by the model
// silently -- it uses git commands for repo ops, not the write tool.
//
// `home` enables the one carve-out we need: Orbit files analyses under
// $HOME/.loom/analyses/<name>/, so those workspaces sit under a `.loom` segment
// yet are the agent's actual work product, not Loom state. Writes there are
// allowed -- but a *nested* `.git`/`.loom` inside an analysis (a real repo's
// hooks, or the per-workspace activity log) stays protected. Everything else
// with a `.git`/`.loom` segment -- Loom's home state, some other repo's .git, a
// per-workspace .loom outside the analyses tree, or a path whose cwd happens to
// sit inside a .git/.loom dir -- stays gated. `.git` is never carved out: a
// workspace is never legitimately inside one. Pass home="" for the plain
// absolute check (callers without a home / the unit tests).
export function isProtectedWritePath(absPath: string, home = ""): boolean {
  const norm = path.normalize(absPath);
  if (hasSegment(norm, ".git")) return true;
  if (!hasSegment(norm, ".loom")) return false;
  // A `.loom` segment is present. It's benign only as the $HOME/.loom/analyses
  // ancestor of a user workspace; a `.loom` anywhere below that (or outside it)
  // is real Loom state. (home is compared un-realpath'd, matching isSensitivePath.)
  if (home) {
    const analyses = path.join(home, ".loom", "analyses");
    if (within(norm, analyses) && !hasSegment(path.relative(analyses, norm), ".loom")) {
      return false;
    }
  }
  return true;
}
