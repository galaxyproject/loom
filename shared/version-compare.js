// Shared, shell-neutral semver helpers. Used by the Orbit version-check banner
// and the CLI update notice so there's one implementation of precedence rules.
// Deliberately dependency-free (no `semver` package) for one small feature.

/**
 * @typedef {{ major: number, minor: number, patch: number, pre: string }} SemverParts
 */

/** @param {string} v @returns {SemverParts | null} */
export function parseSemver(v) {
  const m = String(v)
    .replace(/^v/, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
    pre: m[4] ?? "",
  };
}

// Compares two prerelease tags per semver precedence. Numeric segments compare
// numerically (alpha.10 > alpha.9, which a string compare gets wrong). Returns
// negative when a < b, positive when a > b, zero when equal.
/** @param {string} a @param {string} b @returns {number} */
export function comparePre(a, b) {
  if (a === b) return 0;
  // No prerelease tag outranks the same version with one (1.0.0 > 1.0.0-alpha).
  if (!a) return 1;
  if (!b) return -1;
  const ap = a.split(".");
  const bp = b.split(".");
  const len = Math.min(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const x = ap[i];
    const y = bp[i];
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const dx = parseInt(x, 10);
      const dy = parseInt(y, 10);
      if (dx !== dy) return dx < dy ? -1 : 1;
    } else if (xn !== yn) {
      // Numeric identifiers have lower precedence than alphanumeric ones.
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return ap.length === bp.length ? 0 : ap.length < bp.length ? -1 : 1;
}

/** True when `candidate` is a strictly newer version than `current`.
 * @param {string} current @param {string} candidate @returns {boolean} */
export function isNewer(current, candidate) {
  const a = parseSemver(current);
  const b = parseSemver(candidate);
  if (!a || !b) return false;
  if (b.major !== a.major) return b.major > a.major;
  if (b.minor !== a.minor) return b.minor > a.minor;
  if (b.patch !== a.patch) return b.patch > a.patch;
  return comparePre(a.pre, b.pre) < 0;
}

// Maps an installed version to the npm dist-tag / release channel it tracks.
// Mirrors release.yml: prerelease -> first prerelease identifier (alpha/beta/
// rc), plain semver -> latest. So an alpha user hears about alphas, not stable.
/** @param {string} version @returns {string} */
export function pickChannel(version) {
  const parsed = parseSemver(version);
  if (!parsed || !parsed.pre) return "latest";
  return parsed.pre.split(".")[0] || "latest";
}
