#!/usr/bin/env bash
# Assemble TeaBranch.app (and optionally a DMG) from the SwiftPM build product.
#
# There is no Xcode project on purpose: the dev machine only has the Command Line Tools,
# so `xcodebuild` is unavailable. SwiftPM produces the binary and we lay out the bundle
# by hand, then ad-hoc sign it so macOS will run it.
#
# Usage:
#   ./scripts/build_app.sh                    debug-free release build, host architecture
#   ./scripts/build_app.sh debug              debug build
#   ./scripts/build_app.sh --universal        arm64 + x86_64, lipo'd into one binary
#   ./scripts/build_app.sh --universal --dmg  ...and packaged as build/TeaBranch-<v>-universal.dmg
#
# `--universal` builds each slice with its own `--triple` and merges them with `lipo`,
# rather than SwiftPM's `--arch a --arch b`. The latter routes through xcbuild, which
# needs a full Xcode install; the triple path works with Command Line Tools alone, so
# the same command runs locally and in CI.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="release"
UNIVERSAL=0
MAKE_DMG=0

for argument in "$@"; do
    case "$argument" in
        release|debug) CONFIG="$argument" ;;
        --universal) UNIVERSAL=1 ;;
        --dmg) MAKE_DMG=1 ;;
        *) echo "unknown argument: $argument" >&2; exit 2 ;;
    esac
done

APP="$ROOT/build/TeaBranch.app"
# Keep this in step with `platforms:` in Package.swift and LSMinimumSystemVersion.
DEPLOYMENT_TARGET="14.0"

# MARK: - Build

BIN="$ROOT/build/TeaBranch-binary"
mkdir -p "$ROOT/build"

if [ "$UNIVERSAL" -eq 1 ]; then
    SLICES=()
    for arch in arm64 x86_64; do
        triple="$arch-apple-macosx$DEPLOYMENT_TARGET"
        echo "==> swift build -c $CONFIG --triple $triple"
        swift build -c "$CONFIG" --package-path "$ROOT" --triple "$triple"
        slice="$(swift build -c "$CONFIG" --package-path "$ROOT" --triple "$triple" --show-bin-path)/TeaBranch"
        [ -x "$slice" ] || { echo "build product missing: $slice" >&2; exit 1; }
        SLICES+=("$slice")
    done
    echo "==> lipo -create (${#SLICES[@]} slices)"
    lipo -create "${SLICES[@]}" -output "$BIN"
else
    echo "==> swift build -c $CONFIG"
    swift build -c "$CONFIG" --package-path "$ROOT"
    built="$(swift build -c "$CONFIG" --package-path "$ROOT" --show-bin-path)/TeaBranch"
    [ -x "$built" ] || { echo "build product missing: $built" >&2; exit 1; }
    cp "$built" "$BIN"
fi

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
    SUFFIX=$([ "$UNIVERSAL" -eq 1 ] && echo "universal" || uname -m)
    DMG="$ROOT/build/TeaBranch-$VERSION-$SUFFIX.dmg"

    echo "==> packaging $DMG"
    STAGING="$(mktemp -d)"
    trap 'rm -rf "$STAGING"' EXIT
    cp -R "$APP" "$STAGING/TeaBranch.app"
    ln -s /Applications "$STAGING/Applications"
    rm -f "$DMG"
    hdiutil create -volname "TeaBranch" -srcfolder "$STAGING" -ov -format UDZO "$DMG" >/dev/null

    echo "built: $DMG"
fi
