import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: "src/renderer",
  // electron-forge's plugin-vite defaults outDir to `.vite/renderer/<name>`
  // relative to vite root. Because we override root to `src/renderer`, the
  // default would land at `src/renderer/.vite/renderer/main_window/` -- but
  // the packaged loader (and MAIN_WINDOW_VITE_NAME) looks under the app dir.
  // Pin outDir to an absolute path to keep the two sides in agreement.
  build: {
    outDir: path.resolve(__dirname, ".vite/renderer/main_window"),
    emptyOutDir: true,
  },
  plugins: [react()],
  server: {
    port: 5199,
    strictPort: false,
    // HMR disabled: after a macOS display sleep, Vite's HMR client detects a
    // dropped WebSocket and unconditionally calls location.reload(), wiping
    // all renderer state (chat, plan, steps, results) while the agent
    // subprocess keeps running. location.reload is [LegacyUnforgeable], so
    // patching it fails. Disabling HMR removes the WebSocket entirely.
    hmr: false,
  },
});
