/**
 * Curated allowlist for the env that gets forwarded into the brain subprocess.
 * Forwarding the caller's process.env wholesale leaks unrelated secrets
 * (AWS_*, GITHUB_TOKEN, GOOGLE_APPLICATION_CREDENTIALS, ...) to every MCP
 * subprocess the brain spawns. The set below is the cross-shell baseline;
 * each caller (Electron main, web server) layers its own additions on top.
 */

export const BRAIN_ENV_PASSTHROUGH = new Set([
  // Process basics
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
  "PWD",
  // Locale
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  // Display (the brain itself rarely needs it, but tools spawned by the
  // brain -- e.g. matplotlib via the bash tool -- sometimes do)
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  // Node
  "NODE_OPTIONS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  // Conda / mamba (per-analysis env activation in tools)
  "CONDA_EXE",
  "CONDA_PREFIX",
  "CONDA_DEFAULT_ENV",
  "MAMBA_EXE",
  "MAMBA_ROOT_PREFIX",
  // CA bundles (corporate proxies)
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
]);

export const BRAIN_ENV_PREFIXES = ["LOOM_", "GALAXY_", "PI_"];

// Built-in provider -> the env var its API key lives in. Mirrors the brain's
// PROVIDER_ENV_MAP (bin/loom.js / app/src/main/agent.ts).
//
// Don't try to derive these by uppercasing the provider name: google's key is
// GEMINI_API_KEY, not GOOGLE_API_KEY, so a name-derived guess silently fails to
// find a perfectly good key (and, worse, routes a supplied one somewhere the
// brain never reads).
export const PROVIDER_KEY_VARS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

// Must stay a superset of the brain's built-in provider->env-key map
// (PROVIDER_ENV_MAP in bin/loom.js / app/src/main/agent.ts): a provider key
// that isn't listed here is dropped at this boundary, so in remote mode -- where
// creds are env-only -- the brain would fail its credential check and refuse to
// launch. brain-env.test.ts guards the superset relationship. Derived from the
// map above so the two can't drift; AI_GATEWAY_API_KEY has no provider name of
// its own (it's the brain's fallback var) so it's listed separately.
export const PROVIDER_API_KEY_NAMES = new Set([
  ...Object.values(PROVIDER_KEY_VARS),
  "AI_GATEWAY_API_KEY",
]);

/**
 * Build a curated brain env from a source env. Forwards the named baseline
 * and any LOOM_/GALAXY_/PI_-prefixed vars. Provider API keys are opt-in
 * because desktop sources them from the OS keychain, not the shell.
 *
 * @param {NodeJS.ProcessEnv} [sourceEnv]
 * @param {{ includeProviderKeys?: boolean }} [opts]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildBrainEnv(sourceEnv = process.env, opts = {}) {
  const env = {};
  for (const key of BRAIN_ENV_PASSTHROUGH) {
    const v = sourceEnv[key];
    if (v !== undefined) env[key] = v;
  }
  for (const [k, v] of Object.entries(sourceEnv)) {
    if (v === undefined) continue;
    if (BRAIN_ENV_PREFIXES.some((p) => k.startsWith(p))) env[k] = v;
  }
  if (opts.includeProviderKeys) {
    for (const key of PROVIDER_API_KEY_NAMES) {
      const v = sourceEnv[key];
      if (v !== undefined) env[key] = v;
    }
  }
  return env;
}
