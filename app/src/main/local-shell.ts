// Host-side resolution of whether this desktop has a local bash shell.
//
// Windows ships remote-only: Galaxy I/O is the primary path and the bash tool
// is removed from the model entirely (pi --exclude-tools), while workspace file
// read/write stays available through the brain's exec-guard write-jail. This is
// the single seam a future WSL/container "local power mode" flips by resolving a
// real bash backend. No electron imports here, so it unit-tests from the root
// Vitest suite (same pattern as auto-update-policy.ts).

export function isLocalShellAvailable(
  platform: NodeJS.Platform | string = process.platform,
): boolean {
  return platform !== "win32";
}

/**
 * Spawn-arg/env deltas for a brain with no local shell:
 * - `--exclude-tools bash` removes bash from the model's advertised tool set at
 *   session construction (pi applies it before the rpc/interactive split), so
 *   the model never sees a shell -- true removal, not a block-on-call.
 * - `LOOM_LOCAL_SHELL=off` tells the (shell-neutral) brain its init-gate should
 *   reject plans whose routing tag requires a local leg.
 * Returns empty deltas on platforms that have a shell, so mac/linux are untouched.
 */
export function noLocalShellSpawnExtras(platform: NodeJS.Platform | string = process.platform): {
  args: string[];
  env: Record<string, string>;
} {
  if (isLocalShellAvailable(platform)) return { args: [], env: {} };
  return { args: ["--exclude-tools", "bash"], env: { LOOM_LOCAL_SHELL: "off" } };
}
