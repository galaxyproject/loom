/**
 * Where the brain keeps its global state (config.json, caches, the session
 * index, the what's-new stamp). Historically ~/.loom; moving to ~/.orbit.
 *
 * Every caller that needs a path under that dir resolves it here rather than
 * joining homedir() with ".loom" itself, so the move is one switch and a
 * ~/.orbit/config.json written by a newer release is honored by this one.
 *
 * ~/.orbit also holds desktop-only shell state (window-state.json and the
 * desktop's own version-check.json); nothing here touches those.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Off for the compatibility release: ~/.orbit is used only if a newer release
// already put a config there, and nothing is copied. The rename release flips
// this, which turns on the one-time copy and makes ~/.orbit the default for
// new installs.
export const MIGRATE_TO_ORBIT_STATE_DIR = false;

export const MOVED_MARKER_FILE = "MOVED-TO-ORBIT.txt";
const CONFIG_FILE = "config.json";
// Carried across on migration. Caches, the session index and the version
// check regenerate on their own, so they stay behind.
const MIGRATED_EXTRA_FILES = ["whats-new-seen.json"];

/**
 * @typedef {{ home?: string, migrate?: boolean }} StateDirOptions
 */

function homeOf(opts) {
  return opts?.home ?? os.homedir();
}

/** @param {string} [home] */
export function legacyStateDir(home = os.homedir()) {
  return path.join(home, ".loom");
}

/** @param {string} [home] */
export function orbitStateDir(home = os.homedir()) {
  return path.join(home, ".orbit");
}

/**
 * ~/.orbit once it holds a config.json, else ~/.loom -- until migration is on,
 * after which only an unmigrated ~/.loom/config.json keeps a user on the old
 * dir.
 *
 * @param {StateDirOptions} [opts]
 */
export function resolveStateDir(opts = {}) {
  const home = homeOf(opts);
  const orbit = orbitStateDir(home);
  if (fs.existsSync(path.join(orbit, CONFIG_FILE))) return orbit;
  const legacy = legacyStateDir(home);
  if (!(opts.migrate ?? MIGRATE_TO_ORBIT_STATE_DIR)) return legacy;
  return fs.existsSync(path.join(legacy, CONFIG_FILE)) ? legacy : orbit;
}

/** @param {StateDirOptions} [opts] */
export function resolveConfigPath(opts = {}) {
  return path.join(resolveStateDir(opts), CONFIG_FILE);
}

/**
 * The CLI's npm version-check cache. ~/.orbit/version-check.json already
 * belongs to the desktop's GitHub release check, so anywhere but the legacy
 * dir the CLI uses its own name.
 *
 * @param {StateDirOptions} [opts]
 */
export function resolveCliVersionCheckPath(opts = {}) {
  const dir = resolveStateDir(opts);
  const name =
    dir === legacyStateDir(homeOf(opts)) ? "version-check.json" : "cli-version-check.json";
  return path.join(dir, name);
}

/**
 * Where a new analysis goes when nothing is configured. ~/.loom/analyses is
 * real user data that is never moved, and pi keys session history by absolute
 * cwd, so an existing one keeps winning until ~/.orbit/analyses appears.
 *
 * @param {StateDirOptions} [opts]
 */
export function resolveDefaultAnalysesDir(opts = {}) {
  const home = homeOf(opts);
  const legacy = path.join(legacyStateDir(home), "analyses");
  const orbit = path.join(orbitStateDir(home), "analyses");
  if (fs.existsSync(legacy) && !fs.existsSync(orbit)) return legacy;
  return path.join(resolveStateDir(opts), "analyses");
}

function movedNotice(legacyDir, orbitDir, when) {
  return `Loom is now Orbit, and its settings live in ${orbitDir} now.

On ${when} Orbit copied config.json (and the what's-new stamp, if any) from
this directory to ${orbitDir}. From now on it reads ${path.join(orbitDir, CONFIG_FILE)}
and ignores ${path.join(legacyDir, CONFIG_FILE)}, so changes made to the copy here
have no effect. Saved API keys were copied as-is and keep working.

Nothing here was deleted. Analyses under ${path.join(legacyDir, "analyses")} stay
where they are, and Orbit keeps opening them. Loom releases older than 0.8
still read the old config.json here. Once you no longer run one, the rest of
this directory apart from analyses/ is safe to remove.
`;
}

// Stage the bytes beside the destination, then hard-link into place: link()
// refuses to replace an existing file, so a second process migrating at the
// same moment can't overwrite a config the first one already copied and the
// user has since changed.
function copyNoClobber(src, dest, mode) {
  const bytes = fs.readFileSync(src);
  const tmp = `${dest}.migrating-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  const fd = fs.openSync(tmp, "wx", mode);
  try {
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmp, mode);
    try {
      fs.linkSync(tmp, dest);
      return true;
    } catch (err) {
      if (err?.code === "EEXIST") return false;
      // Filesystems without hard links: fall back to a checked rename.
      if (fs.existsSync(dest)) return false;
      fs.renameSync(tmp, dest);
      return true;
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * One-time copy of ~/.loom's settings into ~/.orbit. Copies, never moves:
 * ~/.loom is left intact apart from a MOVED-TO-ORBIT.txt explaining where
 * things went. Safe to call on every startup.
 *
 * @param {StateDirOptions & { enabled?: boolean, now?: Date }} [opts]
 * @returns {{ status: "disabled" | "nothing-to-migrate" | "already-migrated" | "migrated" | "failed", error?: unknown }}
 */
export function migrateStateDir(opts = {}) {
  if (!(opts.enabled ?? MIGRATE_TO_ORBIT_STATE_DIR)) return { status: "disabled" };
  const home = homeOf(opts);
  const legacy = legacyStateDir(home);
  const orbit = orbitStateDir(home);
  const legacyConfig = path.join(legacy, CONFIG_FILE);
  const orbitConfig = path.join(orbit, CONFIG_FILE);
  const marker = path.join(legacy, MOVED_MARKER_FILE);
  const writeMarker = () => {
    try {
      fs.writeFileSync(marker, movedNotice(legacy, orbit, (opts.now ?? new Date()).toISOString()), {
        flag: "wx",
      });
    } catch {
      /* already there, or ~/.loom is read-only -- the copy still stands */
    }
  };

  if (!fs.existsSync(legacyConfig)) return { status: "nothing-to-migrate" };
  if (fs.existsSync(orbitConfig)) {
    writeMarker();
    return { status: "already-migrated" };
  }
  try {
    fs.mkdirSync(orbit, { recursive: true, mode: 0o700 });
    for (const name of MIGRATED_EXTRA_FILES) {
      const src = path.join(legacy, name);
      if (!fs.existsSync(src) || fs.existsSync(path.join(orbit, name))) continue;
      try {
        copyNoClobber(src, path.join(orbit, name), fs.statSync(src).mode & 0o777);
      } catch {
        /* a lost what's-new stamp just shows the notice once more */
      }
    }
    // Last, because its presence is what switches resolveStateDir over.
    const copied = copyNoClobber(legacyConfig, orbitConfig, 0o600);
    writeMarker();
    return { status: copied ? "migrated" : "already-migrated" };
  } catch (error) {
    return { status: "failed", error };
  }
}
