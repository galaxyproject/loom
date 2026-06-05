// Pure decision for whether Orbit should run the in-place auto-updater.
// macOS only: the forge-native path (Electron autoUpdater + update.electronjs.org)
// supports macOS/Windows only, and Orbit ships no native Windows -- so Linux
// stays on the GitHub-releases notify-link banner. No electron imports here so
// the decision is unit-testable from the root Vitest suite.

export interface AutoUpdateInputs {
  platform: NodeJS.Platform | string;
  isPackaged: boolean;
  updateCheck: boolean;
}

export function shouldEnableAutoUpdate({
  platform,
  isPackaged,
  updateCheck,
}: AutoUpdateInputs): boolean {
  return platform === "darwin" && isPackaged && updateCheck;
}
