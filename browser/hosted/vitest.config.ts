import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Tests share one local Postgres; each file uses its own database or schema.
    testTimeout: 60_000,
  },
});
