import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(__dirname, "../app/src/renderer");
const webDir = __dirname;

export default defineConfig({
  root: rendererRoot,
  plugins: [
    react(),
    {
      name: "orbit-shim-injection",
      transformIndexHtml: {
        order: "pre",
        handler(html) {
          return html.replace(
            '<script type="module" src="./app.ts"></script>',
            '<script type="module" src="/orbit-shim.ts"></script>\n  <script type="module" src="./app.ts"></script>',
          );
        },
      },
    },
  ],
  resolve: {
    alias: {
      "../preload/preload.js": resolve(webDir, "orbit-types.ts"),
      "/orbit-shim.ts": resolve(webDir, "orbit-shim.ts"),
    },
  },
  build: {
    outDir: resolve(webDir, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(rendererRoot, "index.html"),
    },
  },
});
