import path from "node:path";
import fs from "node:fs";
import https from "node:https";
import { pipeline } from "node:stream/promises";
import { execSync } from "node:child_process";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { VitePlugin } from "@electron-forge/plugin-vite";

const APP_DIR = __dirname;
const REPO_ROOT = path.resolve(APP_DIR, "..");
const LOOM_STAGE_PARENT = path.resolve(APP_DIR, ".loom-stage");
const LOOM_STAGE_DIR = path.join(LOOM_STAGE_PARENT, "loom");
const NODE_STAGE_DIR = path.join(LOOM_STAGE_PARENT, "node");
const UV_STAGE_DIR = path.join(LOOM_STAGE_PARENT, "uv");
const TARBALL_CACHE_DIR = path.join(LOOM_STAGE_PARENT, "cache");

// uv release target triple per (platform, arch). Mirrors astral-sh/uv's
// asset names on its GitHub releases.
const UV_TARGETS: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
};

// Files copied verbatim from the Loom repo root into the staged bundle.
// Mirrors the npm `files` allowlist plus package-lock.json (used by npm ci).
const LOOM_BUNDLE_FILES = [
  "bin",
  "extensions",
  "shared",
  "package.json",
  "package-lock.json",
  "README.md",
  "LICENSE",
];

function stageLoomBundle(): void {
  fs.rmSync(LOOM_STAGE_DIR, { recursive: true, force: true });
  fs.mkdirSync(LOOM_STAGE_DIR, { recursive: true });

  for (const item of LOOM_BUNDLE_FILES) {
    const src = path.join(REPO_ROOT, item);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(LOOM_STAGE_DIR, item), { recursive: true });
  }

  // Install runtime deps only (no devDependencies) into the staged bundle.
  // npm ci is faster + deterministic when the lockfile is present.
  const installCmd = fs.existsSync(path.join(LOOM_STAGE_DIR, "package-lock.json"))
    ? "npm ci --omit=dev --no-audit --no-fund"
    : "npm install --omit=dev --omit=optional --no-audit --no-fund";
  execSync(installCmd, { cwd: LOOM_STAGE_DIR, stdio: "inherit" });
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        const status = res.statusCode ?? 0;
        if (status === 301 || status === 302 || status === 307 || status === 308) {
          const redirect = res.headers.location;
          if (!redirect) {
            reject(new Error(`redirect without Location header: ${url}`));
            return;
          }
          res.resume();
          downloadFile(redirect, dest).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          reject(new Error(`HTTP ${status} for ${url}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        pipeline(res, file).then(resolve, reject);
      })
      .on("error", reject);
  });
}

// Bundle the Node runtime that ran `npm ci` so native module ABI stays
// aligned with what we just built. Targeting the build platform/arch only;
// cross-platform packaging will need a per-target hook or download matrix.
async function stageNodeBundle(): Promise<void> {
  const nodeVersion = process.versions.node;
  const platform = process.platform === "win32" ? "win" : process.platform;
  const arch = process.arch;
  const ext = process.platform === "win32" ? "zip" : "tar.xz";
  const distName = `node-v${nodeVersion}-${platform}-${arch}`;
  const filename = `${distName}.${ext}`;
  const url = `https://nodejs.org/dist/v${nodeVersion}/${filename}`;

  fs.rmSync(NODE_STAGE_DIR, { recursive: true, force: true });
  fs.mkdirSync(TARBALL_CACHE_DIR, { recursive: true });

  const tarballPath = path.join(TARBALL_CACHE_DIR, filename);

  if (fs.existsSync(tarballPath)) {
    console.log(`[loom-stage] reusing cached ${filename}`);
  } else {
    console.log(`[loom-stage] downloading ${url}`);
    await downloadFile(url, tarballPath);
  }

  console.log(`[loom-stage] extracting ${filename}`);
  if (process.platform === "win32") {
    execSync(
      `powershell -Command "Expand-Archive -Path '${tarballPath}' -DestinationPath '${LOOM_STAGE_PARENT}'"`,
      { stdio: "inherit" },
    );
  } else {
    execSync(`tar -xf "${tarballPath}" -C "${LOOM_STAGE_PARENT}"`, { stdio: "inherit" });
  }

  const extractedPath = path.join(LOOM_STAGE_PARENT, distName);
  fs.renameSync(extractedPath, NODE_STAGE_DIR);
}

// Bundle uv/uvx so Galaxy MCP (`uvx galaxy-mcp>=1.4.0`) doesn't need a
// system-installed uv. Pulls the latest release tarball from astral-sh/uv.
// "latest" resolves to a specific tag at fetch time -- the cached tarball
// won't auto-refresh; remove `.loom-stage/cache/` to pick up newer uv.
async function stageUvBundle(): Promise<void> {
  const key = `${process.platform}-${process.arch}`;
  const target = UV_TARGETS[key];
  if (!target) {
    throw new Error(
      `[loom-stage] no uv target mapping for ${key}; add it to UV_TARGETS.`,
    );
  }
  const isWin = process.platform === "win32";
  const ext = isWin ? "zip" : "tar.gz";
  const filename = `uv-${target}.${ext}`;
  const url = `https://github.com/astral-sh/uv/releases/latest/download/${filename}`;

  fs.rmSync(UV_STAGE_DIR, { recursive: true, force: true });
  fs.mkdirSync(UV_STAGE_DIR, { recursive: true });
  fs.mkdirSync(TARBALL_CACHE_DIR, { recursive: true });

  const tarballPath = path.join(TARBALL_CACHE_DIR, filename);

  if (fs.existsSync(tarballPath)) {
    console.log(`[loom-stage] reusing cached ${filename}`);
  } else {
    console.log(`[loom-stage] downloading ${url}`);
    await downloadFile(url, tarballPath);
  }

  console.log(`[loom-stage] extracting ${filename}`);
  if (isWin) {
    execSync(
      `powershell -Command "Expand-Archive -Path '${tarballPath}' -DestinationPath '${UV_STAGE_DIR}'"`,
      { stdio: "inherit" },
    );
  } else {
    // Tarball lays out as uv-<target>/uv + uv-<target>/uvx; --strip-components=1
    // flattens that into UV_STAGE_DIR/uv + UV_STAGE_DIR/uvx.
    execSync(
      `tar -xzf "${tarballPath}" -C "${UV_STAGE_DIR}" --strip-components=1`,
      { stdio: "inherit" },
    );
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    name: "Orbit",
    executableName: "orbit",
    icon: "resources/icon",
    // Copies the staged Loom bundle, Node runtime, and uv binary to
    // Contents/Resources/ in the packaged app. agent.ts resolves
    // process.resourcesPath/{loom,node,uv}/... at brain spawn time.
    extraResource: [LOOM_STAGE_DIR, NODE_STAGE_DIR, UV_STAGE_DIR],
  },
  hooks: {
    prePackage: async () => {
      stageLoomBundle();
      await stageNodeBundle();
      await stageUvBundle();
    },
  },
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin", "linux"],
    },
    {
      name: "@electron-forge/maker-dmg",
      config: {
        format: "ULFO",
      },
    },
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
  ],
};

export default config;
