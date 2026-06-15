# Orbit Windows -- remote-only desktop design

## Background

Until this work, the only Windows story for Orbit was WSL2: install a Linux
distribution, run the Loom CLI inside it via WSLg or a terminal, and optionally
surface Orbit's Electron UI through WSLg's X11 forwarding. That works, but it's
a friction wall -- not a reasonable first-run path for a Windows user who just
wants to run analyses against Galaxy.

The good news is that the Loom runtime is already almost entirely OS-neutral.
The `extensions/loom/` brain, the Galaxy MCP surface, the renderer, and the
Electron shell all build and run on Windows without modification. The one hard
blocker is the local bash path: Orbit spawns a brain subprocess that exposes a
`Bash` tool, and there's no bash on a plain Windows box. If the app tries to
spawn `bash.exe` on a machine without WSL2 installed, it either crashes at
startup or fails silently at tool-call time.

"Remote-only on Windows" is therefore mostly already true at runtime -- the
primary execution path is Galaxy MCP calls, the brain is shell-neutral, and
workspace file I/O is guarded by exec-guard's write-jail regardless of
platform. What was missing was (a) a Windows installer and (b) making the
absent bash path graceful: remove the bash tool from the model entirely rather
than trying to spawn it, and update the rest of the app to reflect that the
shell isn't there.

This work builds on PR #113 (the web/container remote-only shell), which
introduced `LOOM_LOCAL_EXEC` and the web-mode gate. Windows reuses the env-var
signaling idea but is a distinct deployment shape: a single-user desktop with
real Galaxy/LLM config, full filesystem access via exec-guard, and a human
present at the machine. That's meaningfully different from a headless
multi-tenant container.

## Non-goals (v1)

- Native PowerShell or cmd execution. The bash tool is removed; no replacement
  shell surface is wired in.
- A local "power mode" implementation. The seam for a future WSL/container
  execution backend is in place (`isLocalShellAvailable`, `LOOM_LOCAL_SHELL`),
  but resolving that backend is out of scope here.
- Windows-specific exec-guard risk patterns. Exec-guard's workspace write-jail
  works the same on Windows as on macOS/Linux; no Windows-specific policy is
  added.
- Authenticode signing. The beta installer is unsigned -- SmartScreen will show
  an "Unknown publisher" prompt. A code-signing certificate is a fast-follow.
- True Squirrel in-place auto-update. Windows gets the same notify-link banner
  as Linux (a "new version available" link to the GitHub releases page). Squirrel
  in-place update pairs badly with unsigned installers anyway, so this is deferred
  alongside the Authenticode work.

## Architecture

Same brain, same renderer, same Electron shell. What changes:

- `app/src/main/local-shell.ts` resolves whether the host has a local bash
  shell (`win32` → false, everything else → true). It also emits the spawn
  extras (args + env deltas) needed to remove bash from the model on no-shell
  platforms.
- `app/src/main/agent.ts` applies those extras at brain spawn time
  (`--exclude-tools bash` + `LOOM_LOCAL_SHELL=off`).
- `extensions/loom/local-exec.ts` gains `isLocalShellDisabled`, which reads the
  `LOOM_LOCAL_SHELL` env var and is used by the init-gate.
- `extensions/loom/init-gate.ts` rejects `local`/`hybrid`/`unknown`-tagged
  plans at `/execute` and `/run` when `LOOM_LOCAL_SHELL=off`.
- `app/src/main/ipc-handlers.ts` adds `localShellAvailable` to the `config:get`
  response.
- `app/src/renderer/app.ts` reads `localShellAvailable` and sets
  `body.remote-desktop` to hide local-exec-only affordances.

```text
Electron main process (win32)
  ↓
local-shell.ts  →  isLocalShellAvailable("win32") = false
                   noLocalShellSpawnExtras()       = { args: ["--exclude-tools", "bash"],
                                                       env: { LOOM_LOCAL_SHELL: "off" } }
  ↓ agent.ts spawns
bin/loom.js --mode rpc --exclude-tools bash (brain subprocess)
  env: { LOOM_LOCAL_SHELL: "off", LOOM_LOCAL_EXEC: "on", ... }
  ↓
pi-ai session constructor (applies excludeTools before rpc/interactive split)
  bash tool NOT in the tool registry the model ever sees
  ↓
extensions/loom/ (brain, shell-neutral)
  init-gate: local/hybrid/unknown plans hard-fail → "re-tag [galaxy]/[remote]"
  exec-guard: workspace write-jail ON (file tool authority stays)
  ↓
Galaxy MCP (primary execution path)

Renderer
  config:get → { localShellAvailable: false }
  app.ts → document.body.classList.add("remote-desktop")
  styles.css → hides exec-mode-toggle, sandbox-banner, prefs-safety, prefs-analysis
```

## Decisions made, and why

**Keep `LOOM_LOCAL_EXEC=on`; remove only the bash tool via `--exclude-tools bash`.**

The natural first instinct was to reuse PR #113's web-mode gate: flip
`LOOM_LOCAL_EXEC=off` and let the init-gate block everything. That would have
been a mistake.

Exec-guard (PRs #146, #151) is not a bash-only safety layer. It's the workspace
file write-jail -- it intercepts the brain's file-write tools (`Edit`, `Write`)
and requires the desktop user to confirm writes outside the trusted workspace.
Disabling it on Windows via `LOOM_LOCAL_EXEC=off` would have silently dropped
that protection, treating a single-user desktop like a headless container where
a separate path-gate extension handles containment.

The correct framing: a single-user Windows desktop has a human present. The
exec-guard write-jail is exactly what you want for that deployment shape -- a
desktop user answers the prompts; the file surface stays available. What's
genuinely absent is a shell. So the right move is to remove just the bash tool
from the model via pi's `--exclude-tools` flag (which pi applies before the
rpc/interactive split, so the model never sees bash at all -- true removal, not
a block-on-call), and leave exec-guard intact.

This choice also avoids several coupling problems the alternative would have
created: adding a `LOOM_LOCAL_EXEC=off` path to the desktop would have required
either an additional gate extension loaded by Orbit (bringing web/ → Orbit
coupling) or parameterizing the init-gate's file-policy, which is the web
shell's job. Keeping `LOOM_LOCAL_EXEC=on` leaves those seams clean.

**Separate `body.remote-desktop` class rather than reusing web's `_mode:"remote"`.**

The web shell's `_mode:"remote"` is detected by `checkFirstRun` and causes an
early return that skips the first-run flow entirely. That's correct for the
container (no user present, no `/connect` flow, creds env-injected). It's wrong
for the Windows desktop, which has real Galaxy/LLM config, a first-run flow, and
a cwd bar. A separate `body.remote-desktop` class hides only the local-exec
affordances (exec-mode toggle, sandbox banner, Safety prefs, Analysis prefs)
without interfering with the desktop's config surface.

## The capability seam

One host predicate drives everything:

```typescript
// app/src/main/local-shell.ts
export function isLocalShellAvailable(platform = process.platform): boolean {
  return platform !== "win32";
}
```

It feeds two downstream signals:

1. **`LOOM_LOCAL_SHELL=off`** (env var, brain subprocess) -- read by
   `isLocalShellDisabled()` in `extensions/loom/local-exec.ts`, used by the
   init-gate to reject local-leg plans. Fail-safe: only the exact string `"off"`
   disables it, so an unset var (mac/linux) keeps plans runnable.

2. **`localShellAvailable`** (IPC, `config:get` response) -- read by the
   renderer to set `body.remote-desktop`.

And one spawn-time mechanism:

3. **`--exclude-tools bash`** (pi CLI flag) -- passed to the brain subprocess by
   `agent.ts` via `noLocalShellSpawnExtras()`. Pi applies `excludeTools` during
   session construction, before the rpc/interactive split, so the model never
   receives bash in its tool registry.

A future WSL/container local power mode resolves a real bash backend on Windows,
stops passing `--exclude-tools bash`, and clears `LOOM_LOCAL_SHELL`. Exec-guard
(already on) re-wraps the new shell surface as it does on macOS/Linux.

## Capability comparison

| Capability                       | macOS / Linux desktop | Windows remote-only desktop       |
| -------------------------------- | --------------------- | --------------------------------- |
| Local bash shell                 | yes                   | no -- removed via --exclude-tools |
| Exec-guard file write-jail       | on                    | on                                |
| Galaxy MCP                       | yes                   | yes                               |
| Workspace file read/write        | yes                   | yes                               |
| Local/cloud exec-mode toggle     | shown                 | hidden (body.remote-desktop)      |
| Sandbox banner                   | shown (when on)       | hidden                            |
| Safety + Analysis prefs          | shown                 | hidden                            |
| `/connect` flow                  | available             | available                         |
| Galaxy/LLM config prefs          | shown                 | shown                             |
| First-run flow                   | runs                  | runs                              |
| `local`/`hybrid`/`unknown` plans | run                   | rejected at init-gate             |
| `galaxy`/`remote` plans          | run                   | run                               |
| In-place auto-update             | yes (macOS Squirrel)  | no -- notify-link banner          |

## Renderer remote-mode on the desktop

When `config:get` returns `localShellAvailable: false`, `app.ts` adds
`remote-desktop` to `document.body.classList` immediately on startup (before
paint, so there's no layout flash). The CSS in `styles.css` then hides four
elements:

```css
body.remote-desktop #exec-mode-toggle,
body.remote-desktop #sandbox-banner,
body.remote-desktop #prefs-section-safety,
body.remote-desktop #prefs-section-analysis {
  display: none !important;
}
```

These are all local-exec concerns (the execution-mode switch, the sandbox opt-in
banner, and the Safety + Analysis preference panels which configure the write-jail
and conda picker). Everything else -- cwd bar, Galaxy/LLM config, the feedback
button, the model picker, the first-run wizard -- is kept. The desktop user needs
it all.

This is intentionally separate from web's `body.remote-mode`. Web's class is
detected by `checkFirstRun` and causes an early return that skips first-run
entirely. Reusing it would have broken config on the desktop.

## Init-gate

`extensions/loom/init-gate.ts` runs as a precondition check for `/execute` and
`/run`. When `LOOM_LOCAL_SHELL=off`, plans whose routing requires a local
execution leg hard-fail before the agent prompt is sent:

```
local    → hard fail  ("re-tag the plan [galaxy]/[remote], or enable local power mode")
hybrid   → hard fail  (same message)
unknown  → hard fail  (untagged plans fall back to local by convention)
galaxy   → pass
remote   → pass
```

The remediation message prompts the user to re-tag the plan's routing bracket
rather than leaving them with a silent failure. This is a user-facing affordance
-- the actual containment that prevents bash execution is the removed bash tool,
not this gate.

## Packaging / Squirrel

A `windows-latest / x64 / win32` leg is added to `.github/workflows/release.yml`
alongside the existing macOS and Linux jobs. Electron Forge's maker-squirrel was
already configured in `app/forge.config.ts`; this just enables the job.

Key details:

- `resources/icon.ico` added (ICO format required by Squirrel's
  `setupIcon` option; the ICO is derived from the existing PNG assets).
- `forge.config.ts` sets `setupIcon: "resources/icon.ico"` in the
  maker-squirrel config.
- The publish step's artifact glob includes `*.exe`, so the `Setup.exe`
  installer is automatically attached to the GitHub release alongside the macOS
  DMG and Linux packages.
- The build is unsigned for beta. Users will see a SmartScreen "Windows
  protected your PC" prompt and need to click "Run anyway." Authenticode signing
  is a fast-follow (see Open questions).

Auto-update: Windows stays on the notify-link banner path (same as Linux). The
`shouldEnableAutoUpdate()` function in `auto-update-policy.ts` returns true only
on `darwin`, so `update-electron-app` is never wired on Windows. Squirrel in-place
auto-update would require the app to be signed to work cleanly, so it's deferred
to after Authenticode.

## Env contract

| Env var            | macOS / Linux desktop | Windows remote-only desktop | Consumed by                                                                  |
| ------------------ | --------------------- | --------------------------- | ---------------------------------------------------------------------------- |
| `LOOM_LOCAL_EXEC`  | `on` (hardcoded)      | `on` (hardcoded)            | `isLocalExecDisabled()` in local-exec.ts; guards exec-guard activation       |
| `LOOM_LOCAL_SHELL` | unset (= available)   | `off`                       | `isLocalShellDisabled()` in local-exec.ts; init-gate rejects local-leg plans |

`LOOM_LOCAL_EXEC=on` is hardcoded by the desktop shell for both platforms so an
ambient `LOOM_LOCAL_EXEC=off` in the launching environment can never silently
disable the exec-guard write-jail.

`LOOM_LOCAL_SHELL` is set to `"off"` only on win32, via `noLocalShellSpawnExtras()`
in `local-shell.ts`. Both vars use an exact-string fail-safe: anything other than
`"off"` is treated as the safe default (local exec/shell available).

Note: `mcp.json` (written by the profiles module at `~/.pi/agent/mcp.json`) is
written with mode `0o600` on POSIX. On Windows/NTFS, the `chmod` call is a no-op
-- file permissions are managed by ACLs, not POSIX mode bits. The desktop Orbit
injects the Galaxy API key via env at spawn time rather than storing it in
`mcp.json` as plaintext, so the credential exposure risk is low; but this is
a note for future NTFS hardening on the CLI path where env-injection isn't
available.

## Validation

- **Unit tests** -- four test files added under `tests/`:
  - `local-shell.test.ts` -- `isLocalShellAvailable` and `noLocalShellSpawnExtras`
    covering win32, darwin, and linux.
  - `local-exec.test.ts` -- `isLocalShellDisabled` fail-safe (only exact `"off"` disables).
  - `init-gate.test.ts` -- `local_exec` hard-fail for `local`/`hybrid`/`unknown` routing
    when `LOOM_LOCAL_SHELL=off`; `galaxy`/`remote` pass; mac/linux unaffected when var unset.
  - `orbit-auto-update-policy.test.ts` -- confirms `shouldEnableAutoUpdate` returns false
    on win32.
- **Existing suite stays green.** The `local-shell.ts` seam returns empty extras on
  darwin/linux, so no behavior changes on existing platforms. Root `npm test` and
  `cd app && npx tsc --noEmit` remain green.
- **CI build.** `build.yml` already packages on `windows-latest` each PR; the
  Windows leg has been green throughout development of this branch.
- **Release.** A `workflow_dispatch` on `release.yml` confirms the win32 leg builds
  and attaches the `Setup.exe` to the draft release.
- **Manual smoke.** A real Windows box install is the only way to confirm the
  SmartScreen dialog, first-run flow, Galaxy connection, and absence of bash.

## Open questions / fast-follows

- **Authenticode certificate.** Without a valid code-signing cert, SmartScreen
  will flag every install. The cert procurement, signing step in the release
  workflow, and timestamp server config are a prerequisite for a non-beta Windows
  release.
- **True Squirrel in-place auto-update.** Once Authenticode is in place, Windows
  can join macOS on `update-electron-app` / `update.electronjs.org`. The
  `shouldEnableAutoUpdate()` predicate in `auto-update-policy.ts` is the only
  change needed on the Orbit side.
- **WSL/container local power mode.** The `isLocalShellAvailable` seam is the
  intentional extension point. A future implementation resolves a bash backend
  (WSL2 `wsl.exe --exec bash` or a bundled container) and stops emitting
  `--exclude-tools bash`. Exec-guard re-wraps the new shell as it does on
  macOS/Linux. Only the seam is in scope here.
- **`mcp.json` `chmod 0o600` on NTFS.** The mode bit is a no-op on Windows.
  Hardening the CLI credential-storage path on Windows (ACL-based restriction,
  or moving to a Windows Credential Store) is a standalone follow-up for the CLI,
  separate from this desktop work.
