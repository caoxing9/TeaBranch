#!/usr/bin/env node
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

function bumpCargoToml(path) {
  const content = readFileSync(path, "utf8");
  const updated = content.replace(
    /^version\s*=\s*"[^"]*"$/m,
    `version = "${version}"`
  );
  writeFileSync(path, updated);
}

function bumpCargoLock(path) {
  const content = readFileSync(path, "utf8");
  const updated = content.replace(
    /(\[\[package\]\]\nname = "teabranch"\nversion = ")[^"]+(")/,
    `$1${version}$2`
  );
  writeFileSync(path, updated);
}

/// The native build has no generated manifest — Info.plist is hand-maintained and is what
/// build_app.sh stamps into the bundle and the DMG filename, so it has to move in lockstep.
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
bumpJson("src-tauri/tauri.conf.json");
bumpCargoToml("src-tauri/Cargo.toml");
bumpCargoLock("src-tauri/Cargo.lock");
bumpInfoPlist("swift/Resources/Info.plist");

console.log(`Bumped version to ${version}`);
