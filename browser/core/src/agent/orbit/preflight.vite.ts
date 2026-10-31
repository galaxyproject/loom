/**
 * Builds the preflight page and worker through the production config (orbitBrowserVite with
 * command "build"), so the flag and the aliases arrive exactly as they will in the bundle Galaxy
 * serves. The one difference: no Pyodide copy, which the preflight doesn't load.
 */
import { fileURLToPath } from "node:url";
import { defineConfig, type PluginOption } from "vite";

import { orbitBrowserVite } from "../../../vite";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ command }) => {
  const base = orbitBrowserVite({
    command,
    flavorRoot: here,
    page: "preflight-page.ts",
    worker: "preflight.worker.ts",
  });
  const plugins = (base.plugins as PluginOption[]).filter(
    (p) => !(p && typeof p === "object" && "name" in p && p.name === "orbit-browser-pyodide-copy"),
  );
  return {
    ...base,
    root: here,
    plugins,
    build: {
      ...base.build,
      outDir: process.env.PREFLIGHT_OUT ?? fileURLToPath(new URL("./dist", import.meta.url)),
      rollupOptions: { ...base.build?.rollupOptions, input: `${here}preflight.html` },
    },
  };
});
