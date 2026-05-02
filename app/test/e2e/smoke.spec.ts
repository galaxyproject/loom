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
 *
 * Isolation: each test gets a fresh tmpdir for HOME, cwd, and Electron's
 * userData. Without this, the launched binary reads the developer's real
 * ~/.loom/config.json (LLM keys, Galaxy creds) and ~/.orbit state, and the
 * test side-effects on real analysis directories. The inherited env is also
 * scrubbed of GALAXY_* so a developer with creds set in their shell doesn't
 * accidentally launch the test against a real Galaxy server.
 */

import { test, expect, _electron as electron } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

function packagedExecutablePath(): string {
  const root = path.resolve(__dirname, "../..");
  const arch = process.arch;
  if (process.platform === "linux") {
    return path.join(root, "out", `Orbit-linux-${arch}`, "orbit");
  }
  if (process.platform === "darwin") {
    // Inner binary name follows forge.config.ts `executableName: "orbit"`
    // (lowercase), not the .app bundle's display name.
    return path.join(
      root,
      "out",
      `Orbit-darwin-${arch}`,
      "Orbit.app",
      "Contents",
      "MacOS",
      "orbit",
    );
  }
  if (process.platform === "win32") {
    return path.join(root, "out", `Orbit-win32-${arch}`, "orbit.exe");
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

test("Orbit launches and the renderer initializes without errors", async () => {
  const errors: string[] = [];

  // Per-test temp tree. HOME redirect covers ~/.loom and ~/.orbit; the
  // Electron --user-data-dir flag covers app.getPath("userData") which on
  // macOS lives outside HOME (~/Library/Application Support).
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-e2e-"));
  const fakeHome = path.join(tmpRoot, "home");
  const fakeCwd = path.join(tmpRoot, "cwd");
  const userDataDir = path.join(tmpRoot, "userData");
  await Promise.all([
    fs.mkdir(fakeHome, { recursive: true }),
    fs.mkdir(fakeCwd, { recursive: true }),
    fs.mkdir(userDataDir, { recursive: true }),
  ]);

  const isolatedEnv = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    // Scrub any Galaxy creds inherited from the developer's shell so we
    // don't accidentally launch a real connection during the smoke test.
    GALAXY_URL: "",
    GALAXY_API_KEY: "",
    // Force a fresh session so the brain doesn't try to --continue from
    // an unrelated prior session if one happened to exist on disk.
    LOOM_FRESH_SESSION: "1",
    // Skip the safeStorage keychain probe -- on macOS it pops a system
    // "keychain cannot be found" dialog under a redirected HOME and
    // blocks the test indefinitely.
    LOOM_DISABLE_SAFE_STORAGE: "1",
  };

  const app = await electron.launch({
    executablePath: packagedExecutablePath(),
    args: [
      `--user-data-dir=${userDataDir}`,
      // Linux-only: tells Chromium to skip libsecret/kwallet and use a
      // plaintext file backend. Has no effect on macOS or Windows --
      // those are covered by LOOM_DISABLE_SAFE_STORAGE above. Defensive
      // on Linux CI runners that don't have a secret service daemon.
      "--password-store=basic",
    ],
    env: isolatedEnv,
    cwd: fakeCwd,
  });

  try {
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
  } finally {
    await app.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
