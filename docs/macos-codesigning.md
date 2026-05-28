# macOS code signing & notarization

Orbit's macOS builds need to be signed with an Apple **Developer ID Application**
certificate and **notarized** by Apple. Without that, anything a user downloads
carries a quarantine flag and Gatekeeper refuses to open it -- on recent macOS
(Sequoia) it shows the blunt "Orbit is damaged and can't be opened" dialog, and
the old right-click -> Open bypass is gone. Notarization is the only path to a
clean double-click install.

The release workflow already has the signing scaffolding wired in
(`.github/workflows/release.yml` + `app/forge.config.ts` + the entitlements at
`app/build/entitlements.mac.plist`). It is **gated on secrets**: with none set,
the build runs unsigned exactly as before. Add the secrets below and the next
tagged release signs + notarizes + staples automatically. Nothing else changes.

## What you need (one-time, Apple side)

Requires an **Apple Developer Program** membership ($99/yr). Enroll as an
individual for the fastest turnaround -- organization enrollment needs a D-U-N-S
number and manual review. (If Galaxy already has a Developer team, join it and
skip the fee.)

### 1. Developer ID Application certificate

1. In Keychain Access -> Certificate Assistant -> "Request a Certificate From a
   Certificate Authority", save a CSR to disk.
2. At developer.apple.com -> Certificates -> `+` -> **Developer ID Application**,
   upload the CSR, download the resulting `.cer`, and double-click to install it
   (it pairs with the private key in your login keychain).
3. In Keychain Access, find "Developer ID Application: <name> (TEAMID)", export
   **the cert + its private key** as a `.p12` and set an export password.
4. Base64 it for the secret:
   ```
   base64 -i developer-id.p12 | pbcopy
   ```

The exact identity string ("Developer ID Application: <name> (TEAMID)") is what
goes in `APPLE_SIGNING_IDENTITY`. The `TEAMID` is your 10-char Team ID.

### 2. App Store Connect API key (for notarization)

At appstoreconnect.apple.com -> Users and Access -> Integrations -> App Store
Connect API -> `+`. Give it the **Developer** role. Download the `.p8` (you only
get one chance), and note the **Key ID** and **Issuer ID**.

```
base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy
```

## GitHub repo secrets

Settings -> Secrets and variables -> Actions. All six are required for a fully
signed + notarized build; set only the first three to sign without notarizing.

| Secret                       | Value                                       |
| ---------------------------- | ------------------------------------------- |
| `MACOS_CERTIFICATE_BASE64`   | base64 of the Developer ID `.p12`           |
| `MACOS_CERTIFICATE_PASSWORD` | the `.p12` export password                  |
| `APPLE_SIGNING_IDENTITY`     | `Developer ID Application: <name> (TEAMID)` |
| `APPLE_API_KEY_BASE64`       | base64 of the App Store Connect `.p8`       |
| `APPLE_API_KEY_ID`           | the API key's Key ID                        |
| `APPLE_API_ISSUER`           | the API key's Issuer ID (UUID)              |

## How the gating works

- `APPLE_SIGNING_IDENTITY` present -> the build is Developer ID signed.
- The API key trio additionally present -> the signed app is also notarized and
  the ticket is stapled.
- None present -> unsigned build (current behavior). Local `npm run make` is
  always unsigned -- the gate checks `process.platform === "darwin"` plus the
  env vars, neither of which a normal dev machine has.

## Expect a little friction on the first signed build

The app bundles its own native binaries (the staged `node` + `uv`, plus native
modules like `koffi` and `better-sqlite3`). Notarization requires every Mach-O
in the bundle to be signed with Hardened Runtime, which the entitlements file
handles -- but bundled binaries are the usual spot where a first notarization
attempt surfaces a missing-signature or entitlement error. Budget for an
iteration round or two; the notary log (printed in the failed run) names the
exact offending file.

Note also that electron-forge notarizes and staples the **`.app`**, then wraps
it in the `.dmg`/`.zip`. That's enough for the drag-to-Applications flow (the
stapled app opens offline). Stapling the `.dmg` itself is a possible follow-up
if we want the disk image to verify before it's even mounted.
