import * as fs from "fs";
import * as path from "path";
import { WORKSPACE_STATE_DIR_NAMES } from "../workspace-state-dir";

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
// Both brain config locations: a newer release may have copied the config
// into ~/.orbit, and this one reads it from there when it exists.
const SENSITIVE_HOME_FILES = [
  ".netrc",
  ".loom/config.json",
  ".orbit/config.json",
  ".pgpass",
  ".npmrc",
];
// Basename / extension patterns sensitive anywhere.
const SENSITIVE_BASENAME =
  /^(\.env(\..+)?|id_rsa|id_ed25519|id_ecdsa|.*\.pem|.*\.key|.*\.keychain(-db)?|credentials)$/i;

function within(abs: string, dir: string): boolean {
  const rel = path.relative(dir, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * `within`, case-folded. Only the credential-store lists use it.
 *
 * macOS is case-insensitive and its realpath does not normalize case, so
 * `Library/Keychains` and `library/keychains` name one directory that an
 * exact-case list only half-covers -- `library/keychains/user.kb` walked
 * straight past this check. Folding can over-match a literally lowercase
 * `library/keychains` on Linux, which errs toward refusing a read, and that is
 * the safe direction for a list whose whole purpose is credential stores.
 *
 * Deliberately NOT used by the write-protection carve-out below: there a match
 * means "this is an analysis workspace, so allow the write", and folding would
 * widen an exemption rather than a refusal.
 */
function withinFolded(abs: string, dir: string): boolean {
  return within(abs.toLowerCase(), dir.toLowerCase());
}

// Dedicated credential stores: the home-relative dirs and exact files above
// that exist solely to hold secrets. The agent has no legitimate reason to read
// their CONTENTS, so reads are denied for every model tier (not just downgraded
// to an ask). This is the floor that closes #183 -- ~/.loom/config.json is a
// store. The basename patterns (.env, *.pem, *.key, ...) are deliberately NOT
// stores: those can be project fixtures, so they keep the ask/deny-by-tier path.
export function isCredentialStore(absPath: string, home: string): boolean {
  const norm = path.normalize(absPath);
  for (const d of SENSITIVE_HOME_DIRS) if (withinFolded(norm, path.join(home, d))) return true;
  // Also as realpaths: callers compare resolved targets, so a config.json that
  // is itself a symlink into the workspace would otherwise read as a plain
  // workspace file.
  for (const f of SENSITIVE_HOME_FILES) {
    const candidates = home ? withRealpath(path.join(home, f)) : [path.join(home, f)];
    if (candidates.some((c) => norm.toLowerCase() === c.toLowerCase())) return true;
  }
  return false;
}

// A path both as written and as resolved, since callers hand us realpaths. A
// file that doesn't exist yet resolves through its parent.
function withRealpath(p: string): string[] {
  const out = [p];
  try {
    out.push(fs.realpathSync(p));
  } catch {
    try {
      out.push(path.join(fs.realpathSync(path.dirname(p)), path.basename(p)));
    } catch {
      /* nothing on disk yet -- the lexical path is all there is */
    }
  }
  return out;
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
// a state dir (`.loom` or `.orbit` -- Loom's own session state) should never be
// written by the model silently -- it uses git commands for repo ops, not the
// write tool.
//
// `home` enables the one carve-out we need: Orbit files analyses under
// $HOME/.loom/analyses/<name>/ (and, after the rename, $HOME/.orbit/analyses),
// so those workspaces sit under a state-dir segment yet are the agent's actual
// work product, not Loom state. Writes there are allowed -- but a *nested*
// `.git`/`.loom`/`.orbit` inside an analysis (a real repo's hooks, or the
// per-workspace state dir) stays protected. Everything else with a `.git` or
// state-dir segment -- Loom's home state, some other repo's .git, a
// per-workspace state dir outside the analyses tree, or a path whose cwd
// happens to sit inside one -- stays gated. `.git` is never carved out: a
// workspace is never legitimately inside one. Pass home="" for the plain
// absolute check (callers without a home / the unit tests).
export function isProtectedWritePath(absPath: string, home = ""): boolean {
  if (hasSegment(path.normalize(absPath), ".git")) return true;
  return isLoomStatePath(absPath, home);
}

// Both spellings are state in every workspace, whichever one it actually uses:
// a `.loom` workspace must not leave a sibling `.orbit` writable, or the other
// way round.
function hasStateSegment(p: string): boolean {
  return WORKSPACE_STATE_DIR_NAMES.some((name) => hasSegment(p, name));
}

// Loom's own state: a path with a state-dir segment that is NOT the analyses
// tree Orbit hands the agent as a workspace. Split out of isProtectedWritePath
// so the bash classifier can reuse exactly this carve-out without also
// inheriting the `.git` rule -- a `.git` write through bash is an ordinary
// unrecognized command, not a catastrophic one. (home is compared
// un-realpath'd, matching isSensitivePath; pass home="" for the plain absolute
// check.)
export function isLoomStatePath(absPath: string, home = ""): boolean {
  const norm = path.normalize(absPath);
  if (!hasStateSegment(norm)) return false;
  // A home that itself sits under a state dir gets no carve-out: the segment
  // above it is state no matter which analyses tree the path is in.
  if (home && !hasStateSegment(path.normalize(home))) {
    for (const name of WORKSPACE_STATE_DIR_NAMES) {
      const analyses = path.join(home, name, "analyses");
      if (within(norm, analyses) && !hasStateSegment(path.relative(analyses, norm))) {
        return false;
      }
    }
  }
  return true;
}
