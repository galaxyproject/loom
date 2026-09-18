/**
 * Dashboard layout persistence -- main-process IPC.
 *
 * One file per analysis, beside notebook.md. Neither handler takes a path: the
 * filename is fixed, so there is no traversal surface to guard, and the cwd
 * clamp is still applied through `resolveWithin` for the same reason the files
 * sidebar applies it.
 *
 * Text in, text out. Validation is the renderer's job through
 * shared/dashboard-contract, so there is exactly one implementation of it.
 *
 * The reading and writing itself lives in `shared/dashboard-layout-store.ts`,
 * shared with the web server and the brain, because three hand-mirrored copies
 * of "lstat, read, check the revision, stage, rename" had already drifted apart
 * and none of them was actually a compare-and-swap. This file is now just the
 * cwd clamp plus the IPC shape.
 */

import { ipcMain } from "electron";
import { createIdempotentIpc } from "./ipc-registry.js";
import { resolveWithin } from "./files-handler.js";
import { DASHBOARD_FILENAME, DASHBOARD_MAX_BYTES } from "../../../shared/dashboard-contract.js";
import { casWriteLayoutFile, readLayoutFile } from "../../../shared/dashboard-layout-store.js";

export function registerDashboardIpc(getCwd: () => string): void {
  // Idempotent for the same reason files-handler is: a macOS reopen-after-close
  // re-runs registration for the new window (#311).
  const ipc = createIdempotentIpc(ipcMain);

  ipc.handle("dashboard:load", async () => {
    try {
      return await readLayoutFile(resolveWithin(getCwd(), DASHBOARD_FILENAME), DASHBOARD_MAX_BYTES);
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipc.handle("dashboard:save", async (_e, raw: string, baseRevision?: string | null) => {
    try {
      return await casWriteLayoutFile(
        resolveWithin(getCwd(), DASHBOARD_FILENAME),
        raw,
        baseRevision,
        DASHBOARD_MAX_BYTES,
      );
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
