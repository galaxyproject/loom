/**
 * The Vite config a flavor builds Orbit's browser shell with: the dev proxies to Galaxy and the
 * model, the compile-time settings, the worker and SQLite handling, and Pyodide copied beside the
 * bundle. A flavor spreads it and adds its own entry points.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchForWorkspaceRoot, type Plugin, type UserConfig } from "vite";

import { readEnv as readOrbitEnv } from "../../shared/orbit-env.js";
import { defaultEndpoint, PROVIDERS } from "./src/agent/providers";

const DEFAULTS = {
  GALAXY_KEY: "",
  GALAXY_ROOT: "http://127.0.0.1:8080",
  // Names a built-in provider (galaxy | gemini | deepseek | openrouter | local). Setting it is
  // enough; LLM_ROOT/LLM_PATH below are only for an endpoint the registry lacks.
  LLM_PROVIDER: "",
  LLM_ROOT: "",
  // Path the /llm proxy rewrites to; Gemini's native API is /v1beta.
  LLM_PATH: "",
  // Provider key, kept in the environment because the manifest is committed.
  LLM_KEY: "",
  // Overrides <ai_model> for a dev run; empty means use the manifest.
  LLM_MODEL: "",
  // The context window that decides when the agent compacts; lower it for a small model.
  LLM_CONTEXT_WINDOW: "",
  // How much recent conversation compaction keeps; clamped to what the window holds.
  LLM_KEEP_RECENT_TOKENS: "",
};

type Env = typeof DEFAULTS;

/** The dev settings as the environment gives them when the config is made, not when imported. */
function readEnv(): { env: Env; missing: string[] } {
  const env = { ...DEFAULTS };
  const missing: string[] = [];
  for (const key of Object.keys(env) as (keyof Env)[]) {
    if (process.env[key]) env[key] = process.env[key] as string;
    else missing.push(key);
  }
  return { env, missing };
}

const proxyGalaxy = (env: Env) => ({
  changeOrigin: true,
  rewrite: (path: string) => {
    if (env.GALAXY_KEY) {
      const separator = path.includes("?") ? "&" : "?";
      return `${path}${separator}key=${env.GALAXY_KEY}`;
    }
    return path;
  },
  target: env.GALAXY_ROOT,
});

/**
 * The /llm proxy's origin and path for each provider: the agent's endpoint, or pi's for its own.
 */
async function llmTargets(): Promise<Record<string, { root: string; path: string }>> {
  const endpoints = await Promise.all(PROVIDERS.map(async (p) => [p.id, await defaultEndpoint(p)]));
  return Object.fromEntries(
    endpoints
      .filter((entry): entry is [string, string] => !!entry[1])
      .map(([id, endpoint]) => {
        const url = new URL(endpoint);
        return [id, { root: url.origin, path: url.pathname === "/" ? "/v1" : url.pathname }];
      }),
  );
}

/** The commit this bundle was built from; a deployed copy cannot be identified without it. */
function buildCommit(): string {
  // Pinned when two builds are compared byte for byte (scripts/compare-default-bundle.mjs).
  const pinned = readOrbitEnv("BUILD_COMMIT");
  if (pinned !== undefined) return pinned;
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

// Read while the config module loads: a flavor's `--configLoader runner` closes the module runner
// once the config is evaluated, and the registry's lazy imports would find it gone.
const targets = await llmTargets();

/** Where the dev server's /llm proxy goes; it refuses a provider the registry doesn't know. */
function llmProxy(env: Env): { root: string; path: string } {
  if (env.LLM_PROVIDER && !targets[env.LLM_PROVIDER] && !env.LLM_ROOT) {
    // Falling through to the local default here is the trap that answers with the wrong model.
    const known = Object.keys(targets).sort().join(", ") || "none readable";
    throw new Error(`LLM_PROVIDER=${env.LLM_PROVIDER} is not in the agent's registry (${known}).`);
  }
  const target = targets[env.LLM_PROVIDER] || { root: "http://127.0.0.1:11434", path: "/v1" };
  return { root: env.LLM_ROOT || target.root, path: env.LLM_PATH || target.path };
}

/**
 * What the bundle is compiled with. The dev server passes the shell's settings; a build passes
 * none, because a build is what Galaxy serves and a developer's routing must not reach it.
 */
export function defines(settings: Partial<Env> = {}): Record<string, string> {
  return {
    "process.env.credentials": JSON.stringify(settings.GALAXY_KEY ? "omit" : "include"),
    "process.env.build_commit": JSON.stringify(buildCommit()),
    "process.env.build_built": JSON.stringify(
      readOrbitEnv("BUILD_TIME") ?? new Date().toISOString(),
    ),
    // Dev only: route the agent through the /llm proxy above, which attaches the key.
    "process.env.llm_base_url": JSON.stringify(
      settings.LLM_PROVIDER || settings.LLM_ROOT ? "/llm" : "",
    ),
    "process.env.llm_provider": JSON.stringify(settings.LLM_PROVIDER ?? ""),
    "process.env.llm_model": JSON.stringify(settings.LLM_MODEL ?? ""),
    "process.env.llm_context_window": JSON.stringify(settings.LLM_CONTEXT_WINDOW ?? ""),
    "process.env.llm_keep_recent_tokens": JSON.stringify(settings.LLM_KEEP_RECENT_TOKENS ?? ""),
  };
}

export type Brain = "browser" | "orbit";

/**
 * Which brain the agent worker boots: the browser's own runtime, or Orbit's (extensions/orbit)
 * behind pi-host. Read from the environment here rather than in defines(settings), because a
 * build passes no settings and the flag has to reach the bundle Galaxy serves.
 */
export function orbitBrain(): Brain {
  const value = process.env.VITE_ORBIT_BRAIN ?? "browser";
  if (value !== "browser" && value !== "orbit") {
    throw new Error(`VITE_ORBIT_BRAIN=${value} is not a brain (browser | orbit).`);
  }
  return value;
}

const shim = (name: string) =>
  fileURLToPath(new URL(`./src/agent/orbit/shims/${name}`, import.meta.url));
const ROOT_MODULES = fileURLToPath(new URL("../../node_modules", import.meta.url));

/**
 * What Orbit's brain imports that a worker doesn't have. extensions/orbit reaches Node only behind
 * the capability profile, which the worker installs with no shell and no files, so these stand in
 * for modules nothing should call: a call throws and names itself. Vite's worker block has no
 * resolve of its own, so this set is global under the flag; the page imports no Node builtins.
 */
export function orbitAliases(): Array<{ find: RegExp; replacement: string }> {
  const builtin = (name: string, file: string) => ({
    find: new RegExp(`^(node:)?${name}$`),
    replacement: shim(file),
  });
  return [
    builtin("fs", "fs.ts"),
    builtin("fs/promises", "fs-promises.ts"),
    builtin("path", "path.ts"),
    builtin("url", "url.ts"),
    builtin("crypto", "crypto.ts"),
    builtin("os", "os.ts"),
    builtin("child_process", "child-process.ts"),
    builtin("zlib", "zlib.ts"),
    { find: /^@earendil-works\/pi-tui$/, replacement: shim("pi-tui.ts") },
    { find: /^@earendil-works\/pi-coding-agent$/, replacement: shim("pi-coding-agent.ts") },
    { find: /^better-sqlite3$/, replacement: shim("better-sqlite3.ts") },
    { find: /^chokidar$/, replacement: shim("chokidar.ts") },
    { find: /^@anthropic-ai\/sandbox-runtime$/, replacement: shim("sandbox-runtime.ts") },
    { find: /^tus-js-client$/, replacement: shim("tus-js-client.ts") },
  ];
}

/** Packages that must not reach the Orbit worker bundle except as the stubs above. */
export const ORBIT_FORBIDDEN = [
  "pi-tui",
  "pi-coding-agent",
  "better-sqlite3",
  "chokidar",
  "sandbox-runtime",
  "tus-js-client",
];

/** Orbit's own sources, which reach Node only through the aliases above. */
const ORBIT_SOURCE = /\/(extensions|shared|lessons)\/|\/agent\/orbit\//;
const NODE_BUILTIN = /^(node:|(fs|path|url|crypto|os|child_process|zlib)(\/|$))/;

/**
 * Fails the build when a Node builtin slips past the aliases. Vite would otherwise swap in an
 * empty `__vite-browser-external` module and the worker would die at load with "x is not a
 * function", which the page reports only as "worker failed to start".
 */
const orbitGuard: Plugin = {
  name: "orbit-browser-node-guard",
  enforce: "pre",
  resolveId(source, importer) {
    if (importer && ORBIT_SOURCE.test(importer) && NODE_BUILTIN.test(source)) {
      throw new Error(
        `Node builtin "${source}" survived the Orbit aliases (imported by ${importer}).`,
      );
    }
    return null;
  },
};

/** The same failure, for a builtin a package Orbit pulls in imports: Vite only warns. */
const orbitOnwarn = (
  warning: { message: string },
  warn: (warning: { message: string }) => void,
): void => {
  if (/externalized for browser compatibility/.test(warning.message)) {
    throw new Error(`Orbit worker build: ${warning.message}`);
  }
  warn(warning);
};

// Pyodide wherever it was hoisted; the wheels in the core's own temp/, where its install script
// (scripts/install_pyodide.js) puts them.
const PYODIDE = path.dirname(createRequire(import.meta.url).resolve("pyodide/package.json"));
const WHEELS = fileURLToPath(new URL("./temp/pyodide", import.meta.url));

/** Pyodide and the wheels the agent loads beside it, copied next to the bundle Galaxy serves. */
const copyPyodide: Plugin = {
  name: "orbit-browser-pyodide-copy",
  writeBundle(options) {
    const dest = path.join(options.dir!, "pyodide");
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(PYODIDE, dest, { recursive: true });
    for (const wheel of fs.readdirSync(WHEELS).filter((f) => f.endsWith(".whl"))) {
      fs.copyFileSync(path.join(WHEELS, wheel), path.join(dest, wheel));
    }
  },
};

/** Pyodide's files as they are, as Galaxy serves them: the dev server would transform its scripts. */
const servePyodide = (flavorRoot: string): Plugin => ({
  name: "orbit-browser-pyodide",
  configureServer(server) {
    const root = path.resolve(flavorRoot, "static/pyodide");
    server.middlewares.use("/static/pyodide", (req, res, next) => {
      const file = path.join(root, decodeURIComponent((req.url || "").split("?")[0]));
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        return next();
      }
      const types: Record<string, string> = {
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".json": "application/json",
      };
      res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
      fs.createReadStream(file).pipe(res);
    });
  },
});

export function orbitBrowserVite({
  command,
  flavorRoot,
  galaxyPaths = [],
  page = "src/main.ts",
  worker = "src/worker.ts",
}: {
  command: "build" | "serve";
  /** The flavor package's directory: where static/ is built and served from. */
  flavorRoot: string;
  /** More paths the dev server forwards to Galaxy, for what only the flavor fetches. */
  galaxyPaths?: string[];
  /** The flavor's page and agent worker entries, relative to flavorRoot. */
  page?: string;
  worker?: string;
}): UserConfig {
  const { env, missing } = readEnv();
  const brain = orbitBrain();
  const orbit = brain === "orbit";
  // Only the dev server reads these; a build is compiled without them.
  const llm = command === "serve" ? llmProxy(env) : { root: "http://127.0.0.1:11434", path: "/v1" };
  if (command === "serve" && missing.length) {
    console.log(`Not set in the environment, so using defaults: ${missing.join(", ")}.`);
  }
  return {
    base: "./",
    build: {
      // Beside where the dev server serves Pyodide from, whatever directory Vite runs in.
      outDir: path.resolve(flavorRoot, "static"),
      emptyOutDir: true,
      rollupOptions: {
        ...(orbit ? { onwarn: orbitOnwarn } : {}),
        output: {
          manualChunks: () => "app.js",
          entryFileNames: "[name].js",
          chunkFileNames: "[name].js",
          assetFileNames: "[name][extname]",
        },
      },
    },
    define: {
      ...(command === "build" ? defines() : defines(env)),
      "process.env.orbit_brain": JSON.stringify(brain),
    },
    plugins: [
      ...(command === "build" ? [copyPyodide] : [servePyodide(flavorRoot)]),
      ...(orbit ? [orbitGuard] : []),
    ],
    resolve: {
      ...(orbit ? { alias: orbitAliases() } : {}),
      // Orbit's chat UI is imported from ../app/src/renderer, where a bare import would look for
      // app/'s or the repo root's node_modules. Those aren't installed when only browser/ is, and
      // chat-markdown.ts has to configure the same `marked` the chat UI renders with.
      dedupe: ["dompurify", "marked"],
    },
    server: {
      // The workspace, whose node_modules is hoisted above the packages, and the chat UI and the
      // shared contracts it imports, which live outside browser/.
      fs: {
        allow: [
          searchForWorkspaceRoot(flavorRoot),
          fileURLToPath(new URL("../../app/src/renderer", import.meta.url)),
          fileURLToPath(new URL("../../shared", import.meta.url)),
          // Orbit's brain and what it imports, under the flag.
          ...(orbit
            ? [
                fileURLToPath(new URL("../../extensions", import.meta.url)),
                fileURLToPath(new URL("../../lessons", import.meta.url)),
                ROOT_MODULES,
              ]
            : []),
        ],
      },
      proxy: {
        "/api": proxyGalaxy(env),
        // Galaxy serves its OpenAPI spec here; the scoped catalog fetches it.
        "/openapi.json": proxyGalaxy(env),
        // The default launch (currentHistoryLaunch) asks which history is current here.
        "/history/current_history_json": proxyGalaxy(env),
        ...Object.fromEntries(galaxyPaths.map((p) => [p, proxyGalaxy(env)])),
        // Dev LLM proxy; the key is attached here so it never reaches page JS.
        "/llm": {
          changeOrigin: true,
          target: llm.root,
          rewrite: (path: string) => path.replace(/^\/llm/, llm.path),
          // Gemini's native API takes its key in its own header; the rest take a bearer token.
          headers: !env.LLM_KEY
            ? undefined
            : env.LLM_PROVIDER === "google"
              ? { "x-goog-api-key": env.LLM_KEY }
              : { Authorization: `Bearer ${env.LLM_KEY}` },
        },
      },
    },
    worker: {
      format: "es",
      ...(orbit ? { plugins: () => [orbitGuard] } : {}),
      // One file: WebKit runs a worker's entry module again when a chunk imports from it, and
      // the second copy takes over the worker's messages without its state.
      rollupOptions: {
        ...(orbit ? { onwarn: orbitOnwarn } : {}),
        output: { inlineDynamicImports: true },
      },
    },
    // The optimizer moves SQLite's module away from the .wasm it loads beside itself.
    optimizeDeps: {
      // Named outright: the scan doesn't follow a script tag with a query (Olit's
      // main.ts?container=app) or the page's `new URL` to its worker. Whatever it misses is found
      // once the page or the worker loads it, and the dev server then reloads the page under
      // whatever is using it.
      entries: ["index.html", page, worker],
      exclude: ["@sqlite.org/sqlite-wasm"],
      // Orbit's root-installed deps, named so the optimizer doesn't find them mid-drive and reload.
      ...(orbit ? { include: ["@sinclair/typebox", "yaml", "openapi-fetch"] } : {}),
    },
  };
}
