/**
 * Local-execution capability signal.
 *
 * The shell tells the brain whether it has a local execution surface via the
 * LOOM_LOCAL_EXEC env var. A shell that runs the brain with no local exec --
 * the web/container remote shell, and eventually a native Windows remote-only
 * build -- sets LOOM_LOCAL_EXEC=off and supplies its own authoritative tool_call
 * gate, so the brain skips its local-execution safety machinery (exec-guard +
 * bash sandbox) there.
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
