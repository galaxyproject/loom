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

export const PROVIDER_API_KEY_NAMES = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
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
