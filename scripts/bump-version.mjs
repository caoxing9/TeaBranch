#!/usr/bin/env node
// Stamp a release version into every file that carries one. Run by @semantic-release/exec.
//
// package.json is semantic-release's version anchor; app/package.json is what electron-builder puts
// in the bundle and in the DMG filename; swift/Resources/Info.plist keeps the earlier native build
// in step. None is generated, so each has to be written explicitly.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("Usage: bump-version.mjs <version>");
  process.exit(1);
}

function bumpJson(path) {
  const original = readFileSync(path, "utf8");
  const trailing = original.endsWith("\n") ? "\n" : "";
  const data = JSON.parse(original);
  data.version = version;
  writeFileSync(path, JSON.stringify(data, null, 2) + trailing);
}

function bumpInfoPlist(path) {
  const content = readFileSync(path, "utf8");
  const updated = ["CFBundleShortVersionString", "CFBundleVersion"].reduce(
    (accumulator, key) =>
      accumulator.replace(
        new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`),
        `$1${version}$2`
      ),
    content
  );
  if (updated === content) {
    console.error(`Failed to bump version keys in ${path}`);
    process.exit(1);
  }
  writeFileSync(path, updated);
}

bumpJson("package.json");
bumpJson("app/package.json");
bumpInfoPlist("swift/Resources/Info.plist");

console.log(`Bumped version to ${version}`);
