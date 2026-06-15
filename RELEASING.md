# Releasing Orbit

This repo ships Orbit as platform-specific installer artifacts via electron-forge,
triggered by pushing a git tag. Current packaged targets are macOS (arm64 + x64),
Linux (x64 + arm64), and Windows (x64, remote-only).

## Quick path

```bash
# 1. Bump the version in app/package.json (semver).
#    Use `0.1.0-alpha.N` while the app is in alpha.
$EDITOR app/package.json

# 2. Commit + tag + push.
git add app/package.json
git commit -m "release: v0.1.0-alpha.1"
git tag v0.1.0-alpha.1
git push origin main
git push origin v0.1.0-alpha.1
```

The `release` workflow (`.github/workflows/release.yml`) fires on any pushed
`v*` tag. It runs `electron-forge make` across a build matrix (macOS arm64 +
x64, Linux x64 + arm64, Windows x64) and attaches every installer (DMGs, `.zip`
archives, `.deb`, `.rpm`, Squirrel `Setup.exe`) to a **draft** GitHub Release.
Review the draft and publish manually when ready.

## What gets built

| Runner           | Arch  | Artifacts                                                                                       |
| ---------------- | ----- | ----------------------------------------------------------------------------------------------- |
| macos-latest     | arm64 | `Orbit-<version>-arm64.dmg`, `Orbit-darwin-arm64-<version>.zip`                                 |
| macos-26-intel   | x64   | `Orbit-<version>-x64.dmg`, `Orbit-darwin-x64-<version>.zip`                                     |
| ubuntu-latest    | x64   | `orbit_<version>_amd64.deb`, `orbit-<version>-1.x86_64.rpm`, `Orbit-linux-x64-<version>.zip`    |
| ubuntu-24.04-arm | arm64 | `orbit_<version>_arm64.deb`, `orbit-<version>-1.aarch64.rpm`, `Orbit-linux-arm64-<version>.zip` |
| windows-latest   | x64   | `Orbit-<version> Setup.exe`                                                                     |

The macOS builds run on native GitHub runners — no cross-compilation, no universal binary.
The Linux builds run on `ubuntu-latest` (x64) and `ubuntu-24.04-arm` (arm64); each
produces a `.deb` (Debian/Ubuntu), `.rpm` (Fedora/RHEL/openSUSE), and a `.zip`
tarball. The Linux arm64 leg unblocks arm64 hosts (Jetson, Raspberry Pi, arm64
servers) that can't run the x64 installer or its bundled x64 `uv`.
The Windows build produces a Squirrel installer (`Setup.exe`) -- it runs **remote-only**:
all execution routes to Galaxy and there is no local bash shell. **WSL2 with WSLg**
(via the Linux x64 `.deb`) remains the path for local execution on Windows until a
native local power mode lands.

> **Heads-up:** `macos-26-intel` is the newest standard Intel runner GitHub
> offers (free for public repos), and macOS 26 is expected to be the last
> Intel-capable macOS release. When this runner sunsets, the Intel mac row
> above stops working. Options at that point: drop x64-native builds, cross-
> compile from arm64, or build x64 on a self-hosted Intel runner. Worth
> re-evaluating based on x64 download share once we have release telemetry.

## Code signing

**Current state: unsigned.** Both DMGs ship without an Apple Developer ID
signature, so first-launch on a tester's Mac triggers Gatekeeper:

> "Orbit can't be opened because Apple cannot check it for malicious software."

Workaround documented in [INSTALL.md](INSTALL.md): right-click the app in
Applications → Open → confirm. Gatekeeper then remembers the choice.

This is acceptable for alpha distribution. When the project takes on an
Apple Developer ID ($99/yr), we will wire `osxSign` + `osxNotarize` blocks
into `app/forge.config.ts` and add the matching secrets to the release
workflow.

## Local make (developer sanity check)

To produce an installer locally without going through CI, run electron-forge
make on a host that matches the target platform (no cross-platform packaging):

```bash
cd app
npm ci
# macOS: produces a .dmg + .zip
npx electron-forge make --arch=arm64    # or --arch=x64
# Linux: produces .deb + .rpm + .zip
npx electron-forge make --arch=arm64    # or --arch=x64; needs `fakeroot` + `rpm`
```

Output lands in `app/out/make/`. macOS installers built this way are
unsigned. The bundled per-arch Node + `uv` (see `forge.config.ts`) are pulled
on first run and cached in `.loom-stage/cache/`.

## Version-check banner

Orbit reads `https://api.github.com/repos/galaxyproject/loom/releases/latest`
on startup, caches the result for 24h in `~/.orbit/version-check.json`, and
shows a non-blocking banner if the latest tag is newer than
`app.getVersion()`. The banner has a per-version dismiss that clears once a
newer release lands.

Cutting a new release therefore automatically prompts existing users to
upgrade — no auto-install (unsigned macOS apps can't be patched by
Squirrel.Mac), just a link to the Releases page.

## Cutting a test release

To exercise the release workflow without burning a real version, push a tag
on a throwaway pattern and delete it after:

```bash
git tag v0.0.0-mac-test
git push origin v0.0.0-mac-test
# Watch .github/workflows/release.yml run. Verify every matrix leg's
# installer attaches to the draft Release.
git tag -d v0.0.0-mac-test
git push origin :refs/tags/v0.0.0-mac-test
# Then delete the draft Release in the GitHub UI.
```
