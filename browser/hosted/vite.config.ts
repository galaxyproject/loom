/**
 * The hosted page's build: the core shell plus web/, with the provider baked in so the shell never
 * shows its model picker (the host decides the model) and no Pyodide, since nothing runs in the page.
 */
import { fileURLToPath } from "node:url";
import { defines } from "@galaxyproject/orbit-browser/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./web", import.meta.url)),
  base: "/",
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
  },
  define: defines({ LLM_PROVIDER: "hosted", LLM_MODEL: "" } as Parameters<typeof defines>[0]),
  resolve: { dedupe: ["dompurify", "marked"] },
});
