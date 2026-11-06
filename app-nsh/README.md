# TeaBranch on nsh

The app itself: TSX on [nsh](https://nsh.dev) (a Rust core with an AppKit host on macOS), with a Rust crate of its own in
`native/` for what TSX can't reach — processes with the login shell's PATH, PTYs, an HTTP server, the keychain, dialogs,
file access, power assertions. `nsh.json` names the app, its bundle id, version, icon and capabilities.

```
App.tsx                 the window's root: boots the services, loads preferences, mounts src/ui
src/boot.ts             the app's life (menu, locale, reconcile loop, autopilot) and shutdown
src/api.ts              everything the UI calls, one typed object
src/core, src/services  state, settings, git, worktrees, processes, agents, Teable, Feishu, GitHub, autopilot
src/node/*              Node and SDK shims over the Rust crate (fs, os, http, lark)
src/shared              types, i18n and pure logic shared by the services and the UI
src/ui                  the screens: stores (signals), features/{autopilot,branches,issues,settings,terminal}, components
native/                 the Rust crate, imported as `teabranch/native`
assets/                 the app icon, the tray icon, the UI icons (`node scripts/gen-icons.mjs <lucide-name>…` adds one)
e2e/                    tests that drive the whole app; screenshots land in .nsh/shots
```

## Commands

```sh
nsh run --target macos          # the app in a window, with hot reload (TSX in ms, Rust rebuilds)
nsh check                       # cargo check, then TypeScript
nsh test                        # cargo test, then every *.test.ts(x), headless
nsh test --target macos e2e     # the e2e tests in the real host (WebKit, screenshots)
nsh package --target macos      # → .nsh/out/TeaBranch.app, ad hoc signed, with the icon
```

Requirements: Rust 1.93 or later and nsh 0.4 (`curl -fsSL https://nsh.dev/install.sh | NSH_VERSION=v0.4.0 sh`). The
`nsh-*` crates in `native/Cargo.toml` stay at the CLI's version.

## Running beside the installed app

The app keeps its state in `~/Library/Application Support/com.teabranch.dev`, and the installed TeaBranch owns that
directory while it runs. Run a development build against another home:

```sh
mkdir -p /tmp/teabranch-home
HOME=/tmp/teabranch-home RUSTUP_HOME=~/.rustup CARGO_HOME=~/.cargo nsh run --target macos
```

Seed `/tmp/teabranch-home/Library/Application Support/com.teabranch.dev/settings.json` with a `projectPath` and an
`agentCommand` to get past onboarding. The e2e tests under `e2e/` expect this too (`branches.test.tsx` looks for the
repository's own branch), which is why CI runs the unit tests and `App.test.tsx` only.

## Notes

- Chinese is the source language for UI text; English lives in `src/shared/i18n/en/`, and a test fails on any `t()` key
  without an entry.
- Formatting: `../app/node_modules/.bin/oxfmt <files>` with the `.oxfmtrc.json` here.
- `app/` beside this directory is the previous Electron build, kept as the reference for what is still being ported (the
  terminal's VT grid, tray and notifications, the browser screenshot, the login item).
