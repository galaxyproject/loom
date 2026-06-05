import { app, autoUpdater, BrowserWindow } from "electron";
import { updateElectronApp, UpdateSourceType } from "update-electron-app";
import { loadConfig } from "../../../shared/loom-config.js";
import { shouldEnableAutoUpdate } from "./auto-update-policy.js";

// Wires Orbit's macOS in-place auto-update via Electron's built-in autoUpdater
// + update.electronjs.org. Explicit repo: app/package.json has no `repository`
// field, so auto-detection would mis-target. The service ignores draft +
// prerelease releases, which preserves the manual promote-the-draft QA gate.
export function initAutoUpdate(): void {
  // Read once at startup; toggling updateCheck takes effect on the next launch
  // (consistent with how Orbit picks up other config changes).
  const enabled = shouldEnableAutoUpdate({
    platform: process.platform,
    isPackaged: app.isPackaged,
    updateCheck: loadConfig().updateCheck !== false,
  });
  if (!enabled) return;

  updateElectronApp({
    updateSource: {
      type: UpdateSourceType.ElectronPublicUpdateService,
      repo: "galaxyproject/loom",
    },
    updateInterval: "1 hour",
    notifyUser: false, // we render our own banner instead of the default dialog
  });

  autoUpdater.on("update-downloaded", (_event, _notes, releaseName) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("update:downloaded", { version: releaseName ?? "" });
    }
  });

  autoUpdater.on("error", (err) => {
    // Don't leave the user with nothing: tell the renderer so it can fall back
    // to the existing GitHub-releases notify-link banner.
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("update:error", { message: String(err?.message ?? err) });
    }
  });
}
