#!/bin/sh
# Builds Open Cursor.app for Apple Silicon and wraps it in a DMG.
# Usage: scripts/open-cursor/package-mac.sh [arm64|x64]   Output: ../open-cursor-dist/
set -e
ARCH="${1:-arm64}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$(dirname "$ROOT")/VSCode-darwin-$ARCH"
DIST="$(dirname "$ROOT")/open-cursor-dist"
cd "$ROOT"
(cd extensions/open-cursor && node .esbuild.mts)
npm run gulp "vscode-darwin-$ARCH-min"
APP="$OUT/Open Cursor.app"
# Source maps are only useful for crash symbolication; they double the size of out/.
find "$APP/Contents/Resources/app/out" -name '*.map' -delete
# Unsigned local build: ad-hoc sign so macOS on Apple Silicon will launch it.
codesign --force --deep --sign - "$APP" 2>/dev/null || true
VERSION="$(node -p "require('./extensions/open-cursor/package.json').version")"
mkdir -p "$DIST"
DMG="$DIST/Open-Cursor-$VERSION-$ARCH.dmg"
rm -f "$DMG"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Open Cursor" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
du -sh "$APP" "$DMG"
