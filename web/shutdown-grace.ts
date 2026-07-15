/**
 * How long to let the brain drain before the SIGKILL backstop.
 *
 * The brain's session_shutdown hook is what flushes the notebook to its Galaxy
 * Page, so this window is the difference between a durable notebook and one that
 * only ever existed under /tmp. Shared by the signal path and the
 * restart/reset-session handlers, which respawn a brain and would otherwise race
 * the outgoing one's final push.
 */
export const DEFAULT_SHUTDOWN_GRACE_MS = 8000;

/**
 * Resolve the drain window from the env. A non-numeric or negative override
 * would parse to NaN and setTimeout(NaN) fires immediately -- the SIGKILL
 * backstop would then race the flush it exists to protect -- so anything
 * non-finite or negative falls back to the default.
 */
export function resolveShutdownGraceMs(env: NodeJS.ProcessEnv): number {
  const raw = env.LOOM_SHUTDOWN_GRACE_MS;
  if (raw === undefined) return DEFAULT_SHUTDOWN_GRACE_MS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SHUTDOWN_GRACE_MS;
}
