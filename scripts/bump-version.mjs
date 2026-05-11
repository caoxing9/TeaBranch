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

bumpJson("package.json");
bumpJson("src-tauri/tauri.conf.json");
bumpCargoToml("src-tauri/Cargo.toml");
bumpCargoLock("src-tauri/Cargo.lock");

console.log(`Bumped version to ${version}`);
