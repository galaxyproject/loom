/**
 * Local-execution capability signal.
 *
 * The shell tells the brain whether it has a local execution surface via the
 * LOOM_LOCAL_EXEC env var. A shell that runs the brain with no local exec at all
 * -- the web/container remote shell -- sets LOOM_LOCAL_EXEC=off and supplies its
 * own authoritative tool_call gate, so the brain skips its local-execution
 * safety machinery (exec-guard + bash sandbox) there.
 *
 * The native Windows remote-only desktop is deliberately NOT this case: it keeps
 * a local *file* surface (so LOOM_LOCAL_EXEC stays "on" and exec-guard runs) and
 * only removes the bash *shell*, signalled by the sibling LOOM_LOCAL_SHELL var
 * (see isLocalShellDisabled below).
 *
 * The default (var unset or any value other than "off") is "local exec
 * available", so the guard stays ON -- fail-safe. Because this toggles a
 * security control AND brain-env forwards every LOOM_-prefixed var, shells with
 * a local exec surface (desktop Electron, CLI) must set this authoritatively at
 * spawn rather than letting an ambient value in the launching environment leak
 * through and silently disable the guard.
 */
export function isLocalExecDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LOOM_LOCAL_EXEC === "off";
}

/**
 * Whether the shell told the brain it has no local bash shell, via
 * LOOM_LOCAL_SHELL=off (set by the native Windows remote-only desktop). Distinct
 * from isLocalExecDisabled: a Windows desktop keeps a local *file* surface
 * (exec-guard write-jail stays on) but has no *shell*, so LOOM_LOCAL_EXEC stays
 * "on" while LOOM_LOCAL_SHELL is "off". The init-gate uses this to reject plans
 * whose routing requires a local execution leg. Fail-safe: only the exact "off"
 * disables it, so an unset var (mac/linux) keeps local plans runnable.
 */
export function isLocalShellDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LOOM_LOCAL_SHELL === "off";
}
