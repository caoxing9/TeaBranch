#!/usr/bin/env bash
# Assemble TeaBranch.app (and optionally a DMG) from the SwiftPM build product.
#
# There is no Xcode project on purpose: the dev machine only has the Command Line Tools,
# so `xcodebuild` is unavailable. SwiftPM produces the binary and we lay out the bundle
# by hand, then ad-hoc sign it so macOS will run it.
#
# Usage:
#   ./scripts/build_app.sh          release build
#   ./scripts/build_app.sh debug    debug build
#   ./scripts/build_app.sh --dmg    ...and packaged as build/TeaBranch-<version>-arm64.dmg
#
# Apple Silicon only: the app targets macOS 26 for Liquid Glass, and macOS 26 does not run on
# Intel, so there is no second slice to lipo in.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="release"
MAKE_DMG=0

for argument in "$@"; do
    case "$argument" in
        release|debug) CONFIG="$argument" ;;
        --dmg) MAKE_DMG=1 ;;
        *) echo "unknown argument: $argument" >&2; exit 2 ;;
    esac
done

APP="$ROOT/build/TeaBranch.app"
# Keep this in step with `platforms:` in Package.swift and LSMinimumSystemVersion.
DEPLOYMENT_TARGET="26.0"

# MARK: - Build

BIN="$ROOT/build/TeaBranch-binary"
mkdir -p "$ROOT/build"

echo "==> swift build -c $CONFIG"
swift build -c "$CONFIG" --package-path "$ROOT"
built="$(swift build -c "$CONFIG" --package-path "$ROOT" --show-bin-path)/TeaBranch"
[ -x "$built" ] || { echo "build product missing: $built" >&2; exit 1; }
cp "$built" "$BIN"

# MARK: - Bundle

echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/TeaBranch"
cp "$ROOT/Resources/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/Resources/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp "$ROOT/Resources/TrayIcon.png" "$APP/Contents/Resources/TrayIcon.png"
printf 'APPL????' > "$APP/Contents/PkgInfo"
rm -f "$BIN"

echo "==> ad-hoc signing"
codesign --force --sign - --timestamp=none "$APP" >/dev/null
codesign --verify --verbose=2 "$APP"

echo "built: $APP ($(lipo -archs "$APP/Contents/MacOS/TeaBranch"))"

# MARK: - DMG

if [ "$MAKE_DMG" -eq 1 ]; then
    VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ROOT/Resources/Info.plist")"
    DMG="$ROOT/build/TeaBranch-$VERSION-$(uname -m).dmg"

    echo "==> packaging $DMG"
    STAGING="$(mktemp -d)"
    trap 'rm -rf "$STAGING"' EXIT
    cp -R "$APP" "$STAGING/TeaBranch.app"
    ln -s /Applications "$STAGING/Applications"
    rm -f "$DMG"
    hdiutil create -volname "TeaBranch" -srcfolder "$STAGING" -ov -format UDZO "$DMG" >/dev/null

    echo "built: $DMG"
fi
