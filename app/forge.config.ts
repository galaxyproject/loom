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
  "CHANGELOG.md",
  "package.json",
  "package-lock.json",
  "README.md",
  "LICENSE",
];

function stageLoomBundle(platform: string, arch: string): void {
  fs.rmSync(LOOM_STAGE_DIR, { recursive: true, force: true });
  fs.mkdirSync(LOOM_STAGE_DIR, { recursive: true });

  for (const item of LOOM_BUNDLE_FILES) {
    const src = path.join(REPO_ROOT, item);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(LOOM_STAGE_DIR, item), { recursive: true });
  }

  // Loom's root prepare script runs `husky`, which is a devDependency.
  // `npm ci --omit=dev` skips installing husky but still fires the prepare
  // lifecycle → `sh -c husky` → exit 127. Strip prepare from the staged
  // copy before installing. Other install/postinstall hooks (native module
  // prebuild downloads) stay intact.
  execSync("npm pkg delete scripts.prepare", { cwd: LOOM_STAGE_DIR, stdio: "inherit" });

  // Install runtime deps only (no devDependencies) into the staged bundle.
  // npm ci is faster + deterministic when the lockfile is present.
  const installCmd = fs.existsSync(path.join(LOOM_STAGE_DIR, "package-lock.json"))
    ? "npm ci --omit=dev --no-audit --no-fund"
    : "npm install --omit=dev --omit=optional --no-audit --no-fund";
  execSync(installCmd, { cwd: LOOM_STAGE_DIR, stdio: "inherit" });

  pruneLoomNodeModules(platform, arch);
}

// Trim runtime-irrelevant chunks from the staged Loom node_modules. Targets
// only known-safe heavy directories; keeps everything that might be loaded.
function pruneLoomNodeModules(platform: string, arch: string): void {
  // koffi ships prebuilt .node binaries for ~18 platforms (darwin/linux/
  // win32/freebsd/openbsd/musl x ia32/x64/arm64/...). We only need the
  // target platform's. Keeping just `<platform>_<arch>` saves ~30MB, and
  // -- importantly for the rpm build -- avoids rpmbuild's brp-strip step
  // choking on foreign-arch ELF/Mach-O binaries it can't parse.
  // npm hoists most copies to the top-level node_modules but pi-coding-agent
  // pins its own koffi, so the package can appear nested too. Walk for any.
  const keepDir = `${platform}_${arch}`;
  for (const koffiBuild of findKoffiBuildDirs(path.join(LOOM_STAGE_DIR, "node_modules"))) {
    for (const entry of fs.readdirSync(koffiBuild)) {
      if (entry !== keepDir) {
        fs.rmSync(path.join(koffiBuild, entry), { recursive: true, force: true });
      }
    }
  }

  // pi-coding-agent bundles an examples/ tree (demo extensions, including a
  // DOOM WASM overlay) that Loom never loads at runtime -- ~1.2MB of dead
  // weight that also drags out codesign, since notarization gives every file
  // an individual --timestamp round-trip. Drop it. (force: true no-ops if the
  // path is ever absent.)
  fs.rmSync(
    path.join(LOOM_STAGE_DIR, "node_modules", "@earendil-works", "pi-coding-agent", "examples"),
    { recursive: true, force: true },
  );
}

function findKoffiBuildDirs(root: string): string[] {
  // Visits every package under a node_modules tree (including nested
  // node_modules and scoped packages) and records koffi build dirs. Avoids
  // walking package internals (src/, dist/, lib/, ...) since koffi can only
  // live at a package root.
  const out: string[] = [];
  function visitNodeModules(nm: string): void {
    if (!fs.existsSync(nm)) return;
    for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith("@")) {
        // Scoped: each child is itself a package.
        const scope = path.join(nm, e.name);
        for (const child of fs.readdirSync(scope, { withFileTypes: true })) {
          if (child.isDirectory()) visitPackage(path.join(scope, child.name));
        }
      } else {
        visitPackage(path.join(nm, e.name));
      }
    }
  }
  function visitPackage(pkgRoot: string): void {
    if (path.basename(pkgRoot) === "koffi") {
      const buildDir = path.join(pkgRoot, "build", "koffi");
      if (fs.existsSync(buildDir)) out.push(buildDir);
      // koffi has no nested node_modules worth walking.
      return;
    }
    visitNodeModules(path.join(pkgRoot, "node_modules"));
  }
  visitNodeModules(root);
  return out;
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

// Bundle the Node runtime so native module ABI stays aligned at runtime.
// Targets the package platform/arch (passed by electron-forge's prePackage
// hook), which lets a single host produce arch-specific artifacts.
async function stageNodeBundle(platform: string, arch: string): Promise<void> {
  const nodeVersion = process.versions.node;
  const nodePlatform = platform === "win32" ? "win" : platform;
  const ext = platform === "win32" ? "zip" : "tar.xz";
  const distName = `node-v${nodeVersion}-${nodePlatform}-${arch}`;
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
  if (platform === "win32") {
    execSync(
      `powershell -Command "Expand-Archive -Path '${tarballPath}' -DestinationPath '${LOOM_STAGE_PARENT}'"`,
      { stdio: "inherit" },
    );
  } else {
    execSync(`tar -xf "${tarballPath}" -C "${LOOM_STAGE_PARENT}"`, { stdio: "inherit" });
  }

  const extractedPath = path.join(LOOM_STAGE_PARENT, distName);
  fs.renameSync(extractedPath, NODE_STAGE_DIR);

  pruneNodeBundle();
}

// Drop pieces of the Node distribution that aren't used at runtime: C/C++
// headers for native module compilation (~60MB), man pages, top-level docs.
// `lib/node_modules/{npm,corepack}` stays so Pi's bash tool can still run
// `npm install` if a user/agent invokes it.
function pruneNodeBundle(): void {
  for (const subdir of ["include", "share"]) {
    fs.rmSync(path.join(NODE_STAGE_DIR, subdir), { recursive: true, force: true });
  }
  for (const file of ["CHANGELOG.md", "README.md"]) {
    fs.rmSync(path.join(NODE_STAGE_DIR, file), { force: true });
  }
}

// Bundle uv/uvx so Galaxy MCP (`uvx galaxy-mcp>=1.8.0`) doesn't need a
// system-installed uv. Pulls the latest release tarball from astral-sh/uv.
// "latest" resolves to a specific tag at fetch time -- the cached tarball
// won't auto-refresh; remove `.loom-stage/cache/` to pick up newer uv.
async function stageUvBundle(platform: string, arch: string): Promise<void> {
  const key = `${platform}-${arch}`;
  const target = UV_TARGETS[key];
  if (!target) {
    throw new Error(`[loom-stage] no uv target mapping for ${key}; add it to UV_TARGETS.`);
  }
  const isWin = platform === "win32";
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
    execSync(`tar -xzf "${tarballPath}" -C "${UV_STAGE_DIR}" --strip-components=1`, {
      stdio: "inherit",
    });
  }
}

type PackagerOptions = NonNullable<ForgeConfig["packagerConfig"]>;

// macOS code signing + notarization, gated entirely on the CI secrets being
// present so local builds -- and any CI run before the secrets are added --
// stay unsigned and keep working exactly as before. APPLE_SIGNING_IDENTITY
// turns on Developer ID signing; the App Store Connect API key trio
// (APPLE_API_KEY_PATH/_ID/_ISSUER) additionally turns on notarization. The
// CI workflow imports the cert into a keychain and stages the .p8 before the
// make step. See docs/macos-codesigning.md for the exact secrets + one-time
// Apple-side setup.
const ENTITLEMENTS_PLIST = path.join(APP_DIR, "build", "entitlements.mac.plist");

const macCodesign: Partial<Pick<PackagerOptions, "osxSign" | "osxNotarize">> =
  process.platform === "darwin" && process.env.APPLE_SIGNING_IDENTITY
    ? {
        osxSign: {
          identity: process.env.APPLE_SIGNING_IDENTITY,
          // Same Hardened Runtime entitlements for every Mach-O in the bundle
          // (app + helpers + bundled node/uv + native modules).
          optionsForFile: () => ({
            entitlements: ENTITLEMENTS_PLIST,
            hardenedRuntime: true,
          }),
        },
        ...(process.env.APPLE_API_KEY_PATH &&
        process.env.APPLE_API_KEY_ID &&
        process.env.APPLE_API_ISSUER
          ? {
              osxNotarize: {
                appleApiKey: process.env.APPLE_API_KEY_PATH,
                appleApiKeyId: process.env.APPLE_API_KEY_ID,
                appleApiIssuer: process.env.APPLE_API_ISSUER,
              },
            }
          : {}),
      }
    : {};

const config: ForgeConfig = {
  packagerConfig: {
    name: "Orbit",
    // @electron/packager derives CFBundleDisplayName (the name Finder shows
    // under the app icon) from executableName, not from `name` above -- so a
    // lowercase value here makes the macOS app read "orbit" even though the
    // bundle is Orbit.app. The lowercase binary is only wanted for the Linux
    // deb/rpm CLI command; macOS has no need for it. Use the proper-cased name
    // on darwin and keep lowercase elsewhere. Each platform builds on its own
    // native runner (same assumption the codesign gate below relies on), so
    // process.platform reflects the target OS family here.
    executableName: process.platform === "darwin" ? "Orbit" : "orbit",
    icon: "resources/icon",
    appBundleId: "org.galaxyproject.orbit",
    appCategoryType: "public.app-category.developer-tools",
    // Copies the staged Loom bundle, Node runtime, and uv binary to
    // Contents/Resources/ in the packaged app. agent.ts resolves
    // process.resourcesPath/{loom,node,uv}/... at brain spawn time.
    extraResource: [LOOM_STAGE_DIR, NODE_STAGE_DIR, UV_STAGE_DIR],
    ...macCodesign,
  },
  hooks: {
    // electron-forge passes (config, platform, arch) so cross-arch
    // packaging (e.g. `make --arch=x64` on an arm64 host) stages the
    // matching Node + uv binaries.
    prePackage: async (_forgeConfig, platform, arch) => {
      stageLoomBundle(platform, arch);
      await stageNodeBundle(platform, arch);
      await stageUvBundle(platform, arch);
    },
  },
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin", "linux", "win32"],
    },
    {
      name: "@electron-forge/maker-dmg",
      config: {
        format: "ULFO",
      },
    },
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "Orbit",
        // electron-winstaller writes this into the generated Orbit.nuspec as the
        // required <authors> field (and it's the publisher shown in Windows'
        // installed-programs list). package.json has no `author`, so without this
        // the Squirrel maker hard-fails with "Authors is required". Matches the
        // maintainer string the deb maker uses.
        authors: "Galaxy Project contributors",
        setupIcon: "resources/icon.ico",
        // Squirrel is happy unsigned for dev/internal builds; production
        // distribution will need a code-signing cert configured here.
      },
    },
    {
      name: "@electron-forge/maker-deb",
      config: {
        options: {
          maintainer: "Galaxy Project contributors",
          homepage: "https://galaxyproject.org",
          // electron-installer-debian's computed default depends omit ALSA, but
          // Electron links libasound.so.2 -- without it Orbit fails to launch on
          // Ubuntu/WSL2 with "error while loading shared libraries". depends is
          // unioned with the defaults, so this only adds the missing lib.
          // libasound2t64 on newer Ubuntu satisfies libasound2 via Provides.
          depends: ["libasound2"],
          // Runtime prerequisites for the opt-in bash sandbox (ASRT shells out to
          // these on Linux): ripgrep -> rg, socat -> socat, bubblewrap -> bwrap.
          // recommends (not depends) because the sandbox is off by default -- apt
          // pulls them on a normal install, but a vanilla box that never enables
          // the toggle isn't forced to. recommends is unioned with the defaults
          // like depends. See #305.
          recommends: ["ripgrep", "socat", "bubblewrap"],
        },
      },
    },
    {
      name: "@electron-forge/maker-rpm",
      config: {
        options: {
          homepage: "https://galaxyproject.org",
        },
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
