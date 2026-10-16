import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

test("offline microphone dictation fills the editable draft without sending", async ({
  browserName: _browserName,
}, testInfo) => {
  test.setTimeout(90_000);
  const root = path.resolve(__dirname, "../..");
  const speech = path.join(root, ".speech-stage", "speech");
  const manifest = JSON.parse(await fs.readFile(path.join(speech, "runtime.json"), "utf8"));
  const fixture = path.join(
    root,
    ".speech-stage",
    "cache",
    `source-${manifest.commit}`,
    "samples",
    "jfk.wav",
  );
  const binary =
    process.platform === "darwin"
      ? path.join(
          root,
          "out",
          `Orbit-darwin-${process.arch}`,
          "Orbit.app",
          "Contents",
          "MacOS",
          "Orbit",
        )
      : path.join(
          root,
          "out",
          `Orbit-${process.platform}-${process.arch}`,
          process.platform === "win32" ? "orbit.exe" : "orbit",
        );
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-speech-e2e-"));
  const isolatedHome = path.join(scratch, "home");
  const cwd = path.join(scratch, "project");
  await fs.mkdir(isolatedHome, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  const app = await electron.launch({
    executablePath: binary,
    args: [
      `--user-data-dir=${path.join(scratch, "userData")}`,
      "--password-store=basic",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${fixture}`,
    ],
    env: {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      GALAXY_URL: "",
      GALAXY_API_KEY: "",
      LOOM_DISABLE_SAFE_STORAGE: "1",
      LOOM_FRESH_SESSION: "1",
      ORBIT_FRESH_SESSION: "1",
    },
    cwd,
  });
  try {
    const page = await app.firstWindow();
    await page.route(/^https?:\/\//, (route) => route.abort());
    await fs.mkdir(path.dirname(testInfo.outputPath("recording.png")), { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.text().includes("[dictation]")) console.log(message.text());
    });
    await expect(page.locator("#input")).toBeVisible();
    await page.waitForTimeout(1500);
    if (await page.locator("#welcome-overlay").isVisible())
      await page.locator("#welcome-skip").click();
    await expect(page.locator("#dictation-btn")).toBeEnabled();
    const status = await page.evaluate(() => window.orbit.dictationStatus!());
    expect(status.available).toBe(true);
    const before = await page.evaluate(() => document.querySelectorAll(".message.user").length);
    await page.locator("#input").fill("Draft prefix");
    await page.locator("#dictation-btn").click();
    await expect(page.locator("#dictation-status")).toContainText("Recording", { timeout: 15_000 });
    await expect(page.locator("#send-btn")).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("recording.png") });
    await page.waitForTimeout(12_000);
    await page.locator("#dictation-btn").click();
    await expect(page.locator("#dictation-status")).toContainText("Transcribing locally");
    await page.screenshot({ path: testInfo.outputPath("transcribing.png") });
    await expect(page.locator("#dictation-status")).toContainText("Dictation added", {
      timeout: 30_000,
    });
    const draft = await page.locator("#input").inputValue();
    expect(draft).toMatch(/^Draft prefix /);
    expect(draft).toMatch(/ask not what your country can do for you/i);
    expect(await page.evaluate(() => document.querySelectorAll(".message.user").length)).toBe(
      before,
    );
    await expect(page.locator("#send-btn")).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("draft-ready.png") });
    // Start another capture, cancel it, and confirm that the first draft survives.
    await page.locator("#dictation-btn").click();
    await expect(page.locator("#dictation-status")).toContainText("Recording");
    await page.keyboard.press("Escape");
    await expect(page.locator("#dictation-status")).toContainText("cancelled");
    expect(await page.locator("#input").inputValue()).toBe(draft);
    expect(errors).toEqual([]);
    await fs.writeFile(
      testInfo.outputPath("e2e-result.json"),
      JSON.stringify(
        {
          model: status.model,
          draft,
          sentMessages: 0,
          cancelPreservedDraft: true,
          rendererErrors: errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
    await fs.rm(scratch, { recursive: true, force: true });
  }
});
