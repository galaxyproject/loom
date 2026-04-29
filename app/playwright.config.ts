import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  // Electron tests serialize naturally — single instance per spec
  fullyParallel: false,
  workers: 1,
  // Single retry on CI to absorb flaky brain-spawn timing; none locally
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  // 60s per test — Electron cold-start + first-window can be slow on CI
  timeout: 60_000,
});
