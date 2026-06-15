# Installing Orbit

Installers ship from the
[Releases page](https://github.com/galaxyproject/loom/releases) — pick the
latest release and download the artifact for your machine.

The macOS build is Developer ID signed and notarized by Apple, so it opens
with a normal double-click. Linux ships `.deb` / `.rpm` / `.zip`. Windows ships
a native `Setup.exe` installer (remote-only) -- see the
[Windows (native, remote-only)](#windows-native-remote-only) section below.

## macOS

The macOS installer is built for Apple Silicon:

| File                        | When to pick it                                                   |
| --------------------------- | ----------------------------------------------------------------- |
| `Orbit-<version>-arm64.dmg` | Apple Silicon Macs (M1/M2/M3/M4) — anything from late 2020 onward |

Intel Macs aren't packaged yet — use the developer install (build from source)
in the [README](README.md#developer-install-build-from-source). Not sure which
you have? Apple menu → About This Mac: "Chip: Apple M..." is Apple Silicon.

### Install

1. Download the matching `.dmg` from the Releases page.
2. Double-click the DMG, drag **Orbit** to the **Applications** folder.
3. Eject the DMG (drag its icon to the trash).

### First launch

The build is **Developer ID signed and notarized by Apple**, so it opens like
any other app — double-click **Orbit** in Applications. No Gatekeeper warning,
no right-click dance, no Terminal commands.

### Updates

Orbit checks for new releases on startup. When a newer version is
available, a banner appears at the top of the window with a link to the
Releases page. Click the link, download the new DMG, and replace the old
app in Applications (drag-and-drop will prompt you to overwrite).

Auto-update isn't wired up yet, so the download is manual — one click after
the banner appears.

### Uninstall

Drag **Orbit** from **Applications** to the **Trash**. Per-user state
lives under:

- `~/.orbit/` — window position, version-check cache.
- `~/.loom/` — agent configuration, API keys (encrypted via macOS
  Keychain), session history.

Remove those directories to fully reset the app.

## Linux

Two package formats are published per release:

| File                            | When to pick it                                          |
| ------------------------------- | -------------------------------------------------------- |
| `orbit_<version>_amd64.deb`     | Debian, Ubuntu, Linux Mint, Pop!\_OS, and derivatives    |
| `orbit-<version>.x86_64.rpm`    | Fedora, RHEL, CentOS, openSUSE                           |
| `Orbit-linux-x64-<version>.zip` | Any distro — extract and run the `orbit` binary directly |

### Install (.deb — Debian/Ubuntu)

```bash
sudo dpkg -i orbit_<version>_amd64.deb
sudo apt-get install -f   # resolves any missing dependencies
orbit                     # launch from terminal, or find it in your app launcher
```

Not showing up in your application menu? Some desktop environments don't
refresh their app database right after a `dpkg` install, so the Orbit icon can
be missing even though the install worked. Run `sudo update-desktop-database
/usr/share/applications` (or just log out and back in) and it'll appear. Either
way, `orbit` from the terminal always launches it.

### Install (.rpm — Fedora/RHEL)

```bash
sudo rpm -i orbit-<version>.x86_64.rpm
orbit
```

### Install (.zip — any distro)

```bash
unzip Orbit-linux-x64-<version>.zip -d ~/orbit
~/orbit/orbit
```

### Uninstall

```bash
sudo dpkg -r orbit          # Debian/Ubuntu
sudo rpm -e orbit           # Fedora/RHEL
```

Per-user state lives under `~/.orbit/` and `~/.loom/` — remove those to fully reset.

---

## Windows (native, remote-only)

Download `Orbit-<version> Setup.exe` from the
[Releases page](https://github.com/galaxyproject/loom/releases) and run it.
The installer is a standard Squirrel setup -- it installs and launches Orbit
automatically.

### SmartScreen warning

The beta build is unsigned. Windows SmartScreen will show "Windows protected
your PC -- Unknown publisher". This is expected.

1. Click **More info**.
2. Click **Run anyway**.

Signing the installer with an Authenticode certificate (planned, not yet in
place) would remove this prompt.

### What works

- Connect to a Galaxy server and run tools and workflows via the Galaxy provider.
- Read and write workspace files from your Windows filesystem.

### What doesn't (yet)

- **No local bash shell.** There is no local execution path -- all computation
  routes to Galaxy. A native local power mode is planned.

### Updates

Orbit shows a banner when a newer release is available. Click the link to go
to the Releases page, download the new `Setup.exe`, and run it to update.

---

## Windows local execution (WSL2)

For local bash execution today, run the Linux `.deb` build inside WSL2 --
WSLg provides native GUI support with no X server setup required. This remains
the path for local execution until a native Windows local power mode lands.

### Prerequisites

1. **WSL2** -- run `wsl --install` in an elevated PowerShell if not already set up.
2. **WSLg** -- bundled with WSL2 on Windows 11 (build 22000+). Run `wsl --update` to ensure it's current.
3. **Ubuntu** (or another Debian-based distro) inside WSL2.

### Install inside WSL2

Open your WSL2 terminal and run:

```bash
# Download the .deb from the Releases page, then:
sudo dpkg -i orbit_<version>_amd64.deb
sudo apt-get install -f
orbit
```

The Orbit window opens on your Windows desktop via WSLg -- no further configuration needed.

### Notes

- File paths inside WSL2 are at `/mnt/c/...` from within the terminal. Point Orbit's working directory at a path inside WSL2 (`~/analyses/`) for best performance -- cross-filesystem I/O over `/mnt/c` is slower.
- Keychain-based API key encryption is not available in WSL2 (no `safeStorage`). API keys are stored in plaintext in `~/.loom/config.json` inside the WSL2 filesystem. Use filesystem permissions (`chmod 600`) to restrict access.

---

## Reporting installer issues

If the DMG won't open, the app crashes on launch, or Gatekeeper behaves
differently than described, please file an issue at
[github.com/galaxyproject/loom/issues](https://github.com/galaxyproject/loom/issues)
with: macOS version, Mac model (Apple menu → About This Mac), the exact
filename downloaded, and any error text.
