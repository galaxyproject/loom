/**
 * Orbit smoke test — launches the packaged Electron app and asserts:
 *  1. The renderer mounts (the chat textarea exists).
 *  2. The agent-status badge eventually flips off the "connecting…" HTML
 *     placeholder. This is exactly the regression class that bit us with
 *     the DOMPurify-import bug — a top-level renderer throw left the badge
 *     stuck.
 *  3. No uncaught console errors fired during boot.
 *
 * Run after `npm run package` so the bundled app is on disk.
 */

import { test, expect, _electron as electron } from "@playwright/test";
import path from "node:path";

function packagedExecutablePath(): string {
  const root = path.resolve(__dirname, "../..");
  const arch = process.arch;
  if (process.platform === "linux") {
    return path.join(root, "out", `Orbit-linux-${arch}`, "orbit");
  }
  if (process.platform === "darwin") {
    return path.join(
      root,
      "out",
      `Orbit-darwin-${arch}`,
      "Orbit.app",
      "Contents",
      "MacOS",
      "Orbit",
    );
  }
  if (process.platform === "win32") {
    return path.join(root, "out", `Orbit-win32-${arch}`, "Orbit.exe");
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

test("Orbit launches and the renderer initializes without errors", async () => {
  const errors: string[] = [];

  const app = await electron.launch({
    executablePath: packagedExecutablePath(),
    args: [],
  });

  const page = await app.firstWindow();
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });

  // App shell mounted
  await expect(page.locator("#input")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#agent-status")).toBeVisible();

  // Status flips off the initial "connecting…" HTML — the brain may emit
  // running or error depending on environment, but ANY change proves the
  // renderer's IPC + listener wiring is alive.
  await expect(page.locator("#agent-status")).not.toHaveText(/connecting/i, {
    timeout: 30_000,
  });

  // No uncaught renderer errors during boot
  expect(errors).toEqual([]);

  await app.close();
});
