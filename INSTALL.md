# Installing Orbit

Orbit is in alpha. Installers ship from the
[Releases page](https://github.com/galaxyproject/loom/releases) — pick the
latest tag and download the artifact for your machine.

Linux and Windows installers will be added in subsequent releases; for now
the install path below is macOS-only. Linux users can still run Orbit from
source (`cd app && npm start` from a checkout of this repo).

## macOS

Two builds are published per release:

| File                        | When to pick it                                                   |
| --------------------------- | ----------------------------------------------------------------- |
| `Orbit-<version>-arm64.dmg` | Apple Silicon Macs (M1/M2/M3/M4) — anything from late 2020 onward |
| `Orbit-<version>-x64.dmg`   | Intel Macs                                                        |

Not sure which? Open the Apple menu → About This Mac. "Chip: Apple M..." → arm64.
"Processor: Intel..." → x64.

### Install

1. Download the matching `.dmg` from the Releases page.
2. Double-click the DMG, drag **Orbit** to the **Applications** folder.
3. Eject the DMG (drag its icon to the trash).

### First launch (Gatekeeper)

The current alpha builds are **unsigned** — Apple's Gatekeeper will block
the first launch:

> "Orbit can't be opened because Apple cannot check it for malicious software."

To run it the first time:

1. Open the **Applications** folder in Finder.
2. **Right-click** (or Control-click) **Orbit** → choose **Open**.
3. The dialog now offers an **Open** button — click it.

macOS remembers the decision. Subsequent launches work via Spotlight,
Launchpad, or a double-click, with no further prompts.

If you don't see the Open option in the right-click menu, run:

```bash
xattr -dr com.apple.quarantine /Applications/Orbit.app
```

This removes the quarantine attribute Gatekeeper sets on downloads.

### Updates

Orbit checks for new releases on startup. When a newer version is
available, a banner appears at the top of the window with a link to the
Releases page. Click the link, download the new DMG, and replace the old
app in Applications (drag-and-drop will prompt you to overwrite).

There is no auto-installer — unsigned apps can't be patched by macOS's
update mechanism. Manual download is one click after the banner appears.

### Uninstall

Drag **Orbit** from **Applications** to the **Trash**. Per-user state
lives under:

- `~/.orbit/` — window position, version-check cache.
- `~/.loom/` — agent configuration, API keys (encrypted via macOS
  Keychain), session history.

Remove those directories to fully reset the app.

## Reporting installer issues

If the DMG won't open, the app crashes on launch, or Gatekeeper behaves
differently than described, please file an issue at
[github.com/galaxyproject/loom/issues](https://github.com/galaxyproject/loom/issues)
with: macOS version, Mac model (Apple menu → About This Mac), the exact
filename downloaded, and any error text.
