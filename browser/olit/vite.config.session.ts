import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";

function buildCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

// The agent as one Node module, for the evaluation harness.
export default defineConfig({
  build: {
    ssr: "src/agent/node.ts",
    // Inside the package; the workspace root's build:session copies it to browser/dist, where
    // the agents repo looks for it.
    outDir: "dist",
    emptyOutDir: false,
    target: "node22",
    // One file: a lazy chunk importing back from an entry that is still in its top-level
    // await never resolves, and the entry awaits the chunk.
    rollupOptions: { output: { entryFileNames: "session.mjs", inlineDynamicImports: true } },
  },
  define: {
    // Inlined here, a CLI script's `if (import.meta.main)` (lessons/validate.mjs) would see the
    // bundle's own entry and run: nothing bundled is ever the entry.
    "import.meta.main": "false",
    "process.env.build_commit": JSON.stringify(buildCommit()),
    "process.env.build_built": JSON.stringify(new Date().toISOString()),
  },
  // vega's Node build calls require(), which an ES module bundle cannot; Node loads it itself.
  ssr: { noExternal: true, external: ["pyodide", "vega", "vega-lite"] },
});
