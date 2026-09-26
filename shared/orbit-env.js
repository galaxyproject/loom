/**
 * Env var names are moving from LOOM_* to ORBIT_*. Every read goes through
 * readEnv("MODE"), which returns ORBIT_MODE if set, else the legacy LOOM_MODE.
 *
 * Writers (a shell setting env for the brain it spawns, the CLI translating a
 * flag) use writeEnv, which sets BOTH spellings. Setting only the legacy name
 * would let an ambient ORBIT_ twin -- forwarded by the brain-env prefix list --
 * silently outrank a value the shell set on purpose (e.g. LOCAL_EXEC=on).
 * The legacy name is still written because an older bundle only reads LOOM_*.
 */

// Off for the compatibility release, so nothing a user sees changes yet. Flip
// it in the release that renames the product.
export const WARN_ON_LEGACY_ENV = false;
let warnEnabled = WARN_ON_LEGACY_ENV;

// Names whose legacy spelling isn't simply LOOM_<name>: ORBIT_BIN already
// meant the desktop binary, and LOOM_BIN would be ambiguous once the CLI is
// also called orbit.
const LEGACY_ALIASES = {
  DESKTOP_BIN: ["ORBIT_BIN"],
  CORE_BIN: ["LOOM_BIN"],
};

/** Value written for SHELL_KIND by a desktop/web shell. Old bundles only know "orbit". */
export const DESKTOP_SHELL_KIND = "orbit";

const warned = new Set();

/** @param {string} name logical name without prefix, e.g. "MODE" */
export function currentEnvName(name) {
  return `ORBIT_${name}`;
}

/** @param {string} name */
export function legacyEnvNames(name) {
  return LEGACY_ALIASES[name] ?? [`LOOM_${name}`];
}

/** Every spelling of a logical name, canonical first. */
export function envNames(name) {
  return [currentEnvName(name), ...legacyEnvNames(name)];
}

function warnLegacy(legacy, current) {
  if (!warnEnabled || warned.has(legacy)) return;
  warned.add(legacy);
  try {
    process.stderr.write(`${legacy} is deprecated; set ${current} instead.\n`);
  } catch {
    /* stderr closed -- nothing useful to do */
  }
}

/**
 * @param {string} name
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | undefined}
 */
export function readEnv(name, env = process.env) {
  const current = currentEnvName(name);
  const v = env[current];
  if (v !== undefined) return v;
  for (const legacy of legacyEnvNames(name)) {
    const lv = env[legacy];
    if (lv !== undefined) {
      warnLegacy(legacy, current);
      return lv;
    }
  }
  return undefined;
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @param {string} value
 */
export function writeEnv(env, name, value) {
  for (const n of envNames(name)) env[n] = value;
}

/**
 * Copy an ORBIT_ value onto its legacy name when the legacy name is unset, for
 * consumers that can only look up one fixed name -- pi resolves a custom
 * provider's apiKey from the env var models.json names (LOOM_ACTIVE_LLM_API_KEY),
 * and older bundles only read LOOM_*. A legacy value that is already set is
 * left alone: whoever set it did so on purpose. An empty value counts as unset
 * on both sides -- `LOOM_ACTIVE_LLM_API_KEY=` left over in a container or shell
 * profile would otherwise shadow the real ORBIT_ key.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 */
export function mirrorToLegacyEnv(env, name) {
  const v = env[currentEnvName(name)];
  if (!v) return;
  const legacy = legacyEnvNames(name);
  if (legacy.some((n) => env[n])) return;
  for (const n of legacy) env[n] = v;
}

/**
 * Is the brain running under the desktop/web renderer rather than the CLI?
 * "desktop" is the new spelling of the value; "orbit" stays accepted.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function isDesktopShell(env = process.env) {
  const kind = readEnv("SHELL_KIND", env);
  return kind === "orbit" || kind === "desktop";
}

/** Test-only: toggle the legacy-name warning and forget which names already warned. */
export function _setLegacyEnvWarnings(enabled) {
  warnEnabled = enabled;
  warned.clear();
}
