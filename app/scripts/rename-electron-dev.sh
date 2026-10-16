#!/usr/bin/env bash
# Dev-only: macOS reads the app menu bar name from the running binary's
# Info.plist. In dev mode that's node_modules/electron/dist/Electron.app,
# so the menu shows "Electron". Patch CFBundleName/CFBundleDisplayName to
# "Orbit" and re-sign ad-hoc. Idempotent; safe to re-run after npm install.
set -e
[ "$(uname)" = "Darwin" ] || exit 0
PLIST="node_modules/electron/dist/Electron.app/Contents/Info.plist"
[ -f "$PLIST" ] || exit 0
CURRENT=$(/usr/libexec/PlistBuddy -c "Print :CFBundleName" "$PLIST" 2>/dev/null || echo "")
MIC=$(/usr/libexec/PlistBuddy -c "Print :NSMicrophoneUsageDescription" "$PLIST" 2>/dev/null || echo "")
[ "$CURRENT" = "Orbit" ] && [ -n "$MIC" ] && exit 0
if [ "$CURRENT" != "Orbit" ]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleName Orbit" "$PLIST"
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Orbit" "$PLIST"
fi
if [ -z "$MIC" ]; then
  /usr/libexec/PlistBuddy -c "Add :NSMicrophoneUsageDescription string Orbit uses your microphone to transcribe speech locally into the prompt." "$PLIST"
fi
codesign --force --deep --sign - node_modules/electron/dist/Electron.app >/dev/null 2>&1 || true
