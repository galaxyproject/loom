/**
 * Inputs to the startup analysis-directory decision. Kept as a plain value
 * object (no fs/env access) so the precedence is unit-testable apart from the
 * electron-app glue in main.ts.
 */
export interface StartupCwdSources {
  /** `--cwd` CLI argument, if passed. */
  cliCwd?: string;
  /** `LOOM_CWD` environment override, if set. */
  envCwd?: string;
  /** Persisted `config.defaultCwd` -- the last analysis directory used (#312). */
  configDefaultCwd?: string;
  /** Hardcoded default (`~/.loom/analyses`) used when nothing else applies. */
  fallback: string;
}

/**
 * Decide which analysis directory Orbit opens to.
 *
 * Priority: `--cwd` CLI arg > `LOOM_CWD` env > persisted `config.defaultCwd` >
 * hardcoded fallback. The persisted `defaultCwd` is written by
 * AgentManager.switchCwd whenever the user changes directories in-app, so a
 * clean restart reopens the most recently used directory (#312).
 *
 * Returns the raw choice; the caller still expands a leading `~` and ensures
 * the directory exists.
 */
export function resolveStartupCwd(sources: StartupCwdSources): string {
  return sources.cliCwd || sources.envCwd || sources.configDefaultCwd || sources.fallback;
}
