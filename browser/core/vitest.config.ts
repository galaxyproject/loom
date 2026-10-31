/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

import { orbitBrowserVite } from "./vite";

export default defineConfig({
  ...orbitBrowserVite({
    command: "serve",
    mode: "test",
    flavorRoot: fileURLToPath(new URL(".", import.meta.url)),
  }),
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["src/**/*.test.{js,ts}"],
  },
});
