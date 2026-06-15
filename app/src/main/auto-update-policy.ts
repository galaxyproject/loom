// Pure decision for whether Orbit should run the in-place auto-updater.
// macOS only for now. Windows ships a native remote-only build but, like Linux,
// stays on the GitHub-releases notify-link banner -- true Squirrel in-place
// auto-update is a fast-follow (and pairs badly with shipping unsigned). No
// electron imports here so the decision is unit-testable from the root suite.

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
