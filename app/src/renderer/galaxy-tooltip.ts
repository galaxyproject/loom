import type { GalaxyUserStatus } from "../main/galaxy-user.js";

/**
 * Build the Galaxy status tooltip. The base is always the server URL; when we
 * know who the key authenticates as, we append the identity so the connected
 * Galaxy account is glanceable (not just the server).
 *
 *   no user yet  -> "Galaxy: <url>"
 *   connected    -> "Galaxy: <url> (dannon)"        (username, else email)
 *   auth failed  -> "Galaxy: <url> (sign-in failed)"
 *
 * Type-only import of GalaxyUserStatus -- erased at build, so the renderer never
 * pulls in any main-process runtime code.
 */
export function formatGalaxyTooltip(url: string, user?: GalaxyUserStatus | null): string {
  const base = `Galaxy: ${url}`;
  if (!user) return base;
  if (user.ok) {
    const identity = user.username || user.email;
    return identity ? `${base} (${identity})` : base;
  }
  return user.authFailed ? `${base} (sign-in failed)` : base;
}
