# Releasing Orbit

This repo ships Orbit as platform-specific installer artifacts via electron-forge,
triggered by pushing a git tag. The first packaged targets are macOS (arm64 and
x64). Linux and Windows installers will follow in subsequent passes.

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
`v*` tag. It runs `electron-forge make` on a macOS arm64 runner and a macOS
x64 runner, then attaches both DMGs (and matching `.zip` archives) to a
**draft** GitHub Release. Review the draft and publish manually when ready.

## What gets built

| Runner       | Arch  | Artifacts                                                       |
| ------------ | ----- | --------------------------------------------------------------- |
| macos-latest | arm64 | `Orbit-<version>-arm64.dmg`, `Orbit-darwin-arm64-<version>.zip` |
| macos-13     | x64   | `Orbit-<version>-x64.dmg`, `Orbit-darwin-x64-<version>.zip`     |

The arm64 build runs on Apple Silicon GitHub runners; the x64 build runs on
the last generation of Intel Mac runners (`macos-13`). Both are native — no
cross-compilation, no universal binary.

> **Heads-up:** `macos-13` is the only remaining x64-native runner in GitHub's
> fleet and is on the deprecation track. When it sunsets, the x64 row above
> stops working. Options at that point: drop x64 native builds, cross-compile
> from arm64, or build x64 on a self-hosted Intel runner. Worth re-evaluating
> based on x64 download share once we have release telemetry.

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

To produce a DMG locally on macOS without going through CI:

```bash
cd app
npm ci
npx electron-forge make --arch=arm64    # or --arch=x64
```

Output lands in `app/out/make/`. The DMG is not signed by this path either.

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
# Watch .github/workflows/release.yml run. Verify both DMGs attach to the
# draft Release.
git tag -d v0.0.0-mac-test
git push origin :refs/tags/v0.0.0-mac-test
# Then delete the draft Release in the GitHub UI.
```
