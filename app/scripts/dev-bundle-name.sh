#!/bin/sh
# In dev the app runs inside node_modules' Electron.app, so the Dock and ⌘Tab say "Electron".
# Rename that bundle to TeaBranch; packaged builds get the name from electron-builder.
plist=node_modules/electron/dist/Electron.app/Contents/Info.plist
[ -f "$plist" ] || exit 0
/usr/libexec/PlistBuddy -c "Set :CFBundleName TeaBranch" -c "Set :CFBundleDisplayName TeaBranch" "$plist"
