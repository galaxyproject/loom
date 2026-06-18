/**
 * GUI smoke for the Preferences -> Skills -> "Refresh skills" path.
 * Drives the packaged Electron app and asserts the wired behavior:
 *  1. Clicking Refresh clears the per-repo skills cache (a seeded
 *     galaxy-skills@* marker dir is removed).
 *  2. The agent is restarted -- the renderer posts the
 *     "Skills refreshing ... agent restarted" confirmation, which the IPC
 *     only returns after agent.stop()/start() ran without throwing.
 *  3. The Refresh button re-arms (the handler's finally{} re-enable).
 *
 * Out of scope here: the catalog *re-walk* that recreates _catalog.json.
 * That runs in before_agent_start (next agent turn), so it needs a live
 * LLM session -- not something this credless smoke drives.
 *
 * Same isolation as smoke.spec.ts: fresh tmp HOME / cwd / userData, scrubbed
 * Galaxy creds. Run after `npm run package`. Set SKILLS_E2E_SHOTS to a dir to
 * capture before/after screenshots.
 */

import { test, expect, _electron as electron } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

function packagedExecutablePath(): string {
  const root = path.resolve(__dirname, "../..");
  const arch = process.arch;
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
  if (process.platform === "linux") {
    return path.join(root, "out", `Orbit-linux-${arch}`, "orbit");
  }
  if (process.platform === "win32") {
    return path.join(root, "out", `Orbit-win32-${arch}`, "orbit.exe");
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

test("Refresh skills clears the catalog cache and restarts the agent", async () => {
  const shotDir = process.env.SKILLS_E2E_SHOTS;
  const errors: string[] = [];

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-skills-e2e-"));
  const fakeHome = path.join(tmpRoot, "home");
  const fakeCwd = path.join(tmpRoot, "cwd");
  const userDataDir = path.join(tmpRoot, "userData");
  await Promise.all([
    fs.mkdir(fakeHome, { recursive: true }),
    fs.mkdir(fakeCwd, { recursive: true }),
    fs.mkdir(userDataDir, { recursive: true }),
  ]);

  // Seed a config with the default galaxy-skills repo so the Skills section is
  // populated and skills:refresh has a repo whose cache it can clear.
  const loomDir = path.join(fakeHome, ".loom");
  await fs.mkdir(loomDir, { recursive: true });
  await fs.writeFile(
    path.join(loomDir, "config.json"),
    JSON.stringify(
      {
        skills: {
          repos: [
            {
              name: "galaxy-skills",
              url: "https://github.com/galaxyproject/galaxy-skills",
              branch: "main",
              enabled: true,
            },
          ],
        },
      },
      null,
      2,
    ),
  );

  // Pre-seed a marker cache dir. The handler clears any galaxy-skills@* dir, so
  // this is removed on Refresh -- deterministic evidence of the clear.
  const cacheBase = path.join(loomDir, "cache", "skills");
  const markerDir = path.join(cacheBase, "galaxy-skills@e2e-marker");
  await fs.mkdir(markerDir, { recursive: true });
  await fs.writeFile(
    path.join(markerDir, "_catalog.json"),
    JSON.stringify({ generatedAt: 0, skills: [] }),
  );

  const isolatedEnv = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    GALAXY_URL: "",
    GALAXY_API_KEY: "",
    LOOM_FRESH_SESSION: "1",
    LOOM_DISABLE_SAFE_STORAGE: "1",
  };

  const app = await electron.launch({
    executablePath: packagedExecutablePath(),
    args: [`--user-data-dir=${userDataDir}`, "--password-store=basic"],
    env: isolatedEnv,
    cwd: fakeCwd,
  });

  try {
    const page = await app.firstWindow();
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    });

    await expect(page.locator("#input")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#agent-status")).toBeVisible();
    await expect(page.locator("#agent-status")).not.toHaveText(/connecting/i, { timeout: 30_000 });

    // First-run welcome overlay (no provider configured in the isolated HOME)
    // sits on top and intercepts clicks -- skip it.
    const welcome = page.locator("#welcome-overlay");
    if (await welcome.isVisible().catch(() => false)) {
      await page.locator("#welcome-skip").click();
      await expect(welcome).toBeHidden({ timeout: 5_000 });
    }

    // Marker present before refresh.
    expect(existsSync(markerDir)).toBe(true);

    // Open Preferences via the exact channel the "Preferences..." menu item
    // (CmdOrCtrl+,) uses -- the native menu isn't Playwright-clickable, and the
    // model-indicator shortcut is hidden until a model is configured.
    await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.webContents.send("menu:open-preferences");
    });
    await expect(page.locator("#prefs-overlay")).toBeVisible();
    await page.locator("#prefs-section-skills").scrollIntoViewIfNeeded();
    await expect(page.locator("#prefs-section-skills")).toBeVisible();
    // The seeded repo renders as an editable row (name is an <input value>, not
    // text), so assert the row exists via its Remove action + the name input.
    await expect(page.locator("#prefs-skills-rows").getByText("Remove")).toBeVisible();
    await expect(
      page.locator("#prefs-skills-rows").locator('input[type="text"]').first(),
    ).toHaveValue("galaxy-skills");
    await expect(page.locator("#prefs-skills-refresh")).toBeVisible();
    if (shotDir) await page.screenshot({ path: path.join(shotDir, "01-prefs-skills.png") });

    // Click Refresh.
    await page.locator("#prefs-skills-refresh").click();

    // Prefs closes, cache cleared, confirmation posted.
    await expect(page.locator("#prefs-overlay")).toBeHidden({ timeout: 10_000 });
    await expect
      .poll(() => existsSync(markerDir), {
        timeout: 10_000,
        message: "marker cache dir should be cleared",
      })
      .toBe(false);
    await expect(page.getByText(/Skills refreshing/i)).toBeVisible({ timeout: 10_000 });

    // The handler disables the button then re-enables in a finally{}; after the
    // action it must be re-armed (not stuck disabled) so a user can refresh again.
    await expect(page.locator("#prefs-skills-refresh")).toBeEnabled();

    if (shotDir) await page.screenshot({ path: path.join(shotDir, "02-after-refresh.png") });

    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
