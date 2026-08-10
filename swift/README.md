# TeaBranch — native Swift

A native rewrite of TeaBranch: SwiftUI + AppKit, no web view, no Rust, no Node runtime.
Same features, same on-disk state, same menu bar behaviour.

## Build & run

There is no Xcode project — this machine has only the Command Line Tools, so `xcodebuild`
isn't available. SwiftPM builds the binary and a script lays out the bundle by hand.

```bash
cd swift
./scripts/build_app.sh                    # host arch → build/TeaBranch.app (ad-hoc signed)
./scripts/build_app.sh --universal        # arm64 + x86_64, lipo'd into one binary
./scripts/build_app.sh --universal --dmg  # ...and build/TeaBranch-native-<version>-universal.dmg
open build/TeaBranch.app

swift build                               # plain debug build, no bundle
```

Requirements: macOS 14+, Swift 6 toolchain (`swift --version`).

`--universal` builds each slice with its own `--triple` and merges them with `lipo`, rather
than SwiftPM's `--arch a --arch b`. The latter routes through xcbuild and fails outright
without a full Xcode install; the triple path needs only the Command Line Tools, so the same
command runs here and in CI.

## Release

`.github/workflows/release.yml` has a `build-swift` job that runs on every release semantic-release
publishes: it builds universal, packages the DMG, and uploads it alongside the two Tauri DMGs.
The three assets are named distinctly, so a release carries both builds and you can pick one.

The version comes from `Resources/Info.plist` — there is no generated manifest to derive it from.
`scripts/bump-version.mjs` stamps it there along with `package.json` / `Cargo.toml` /
`tauri.conf.json`, and `.releaserc.json` commits it, so the plist can't drift from the tag.

Both DMGs are **ad-hoc signed and not notarized**, so a downloaded build is quarantined on first
launch: right-click → Open, or `xattr -d com.apple.quarantine /Applications/TeaBranch.app`.
Escaping that needs a paid Developer ID, and applies to the Tauri build exactly the same way.

## Layout

```
swift/
├── Package.swift
├── Resources/                  Info.plist, AppIcon.icns, TrayIcon.png
├── scripts/build_app.sh        swift build + bundle assembly + codesign
└── Sources/TeaBranch/
    ├── App/                    AppKit entry point
    │   ├── main.swift              NSApplication bootstrap
    │   ├── AppDelegate.swift       lifecycle, main menu, cleanup on quit
    │   ├── MainWindowController.swift  vibrancy window, hide-on-close, anchor under the status item
    │   └── StatusItemController.swift  menu bar icon, left-click toggle, right-click menu
    ├── Core/
    │   ├── Shell.swift             login-shell PATH resolution + blocking command capture
    │   ├── Spawn.swift             posix_spawn with its own process group, piped line streaming
    │   ├── Ports.swift             bind probes, lsof lookups, graceful port reclaim
    │   ├── EnvFile.swift           .env read/rewrite, Postgres URL surgery
    │   ├── Models.swift            Branch, BranchEnvironment, AppSettings, DbMode, …
    │   ├── AppState.swift          lock-protected shared state + change notifications
    │   ├── LogStore.swift          per-branch, per-source capped log buffers
    │   ├── SettingsStore.swift     settings.json / categories.json persistence
    │   └── Log.swift               stderr diagnostics
    ├── Services/
    │   ├── GitService.swift        worktree list parsing, branch enumeration, managed detection
    │   ├── WorktreeService.swift   create/remove worktree, slot allocation, env generation
    │   ├── ProcessManager.swift    start/stop dev servers, health watchdog, orphan reconcile
    │   ├── DatabaseService.swift   psql provisioning
    │   ├── NgrokService.swift      tunnel lifecycle + 4040 API recovery
    │   └── TerminalService.swift   open a worktree in a terminal tab / VS Code
    └── UI/
        ├── Theme.swift             design tokens from the old global.css, appearance-aware
        ├── AppModel.swift          main-actor view model
        ├── RootView.swift          shell, title bar, onboarding
        ├── BranchListView.swift    search / filter / sort toolbars
        ├── BranchCardView.swift    branch row
        ├── SwimLaneBoardView.swift kanban lanes with drag & drop
        ├── BranchDetailView.swift  info grid, env override editor, ngrok control
        ├── LogPaneView.swift       tabbed log viewer with search, copy, auto-scroll
        ├── AnsiText.swift          ANSI SGR → AttributedString
        ├── StatusBadgeView.swift   status dot + category picker
        ├── CreateWorktreeSheet.swift
        └── SettingsSheet.swift
```

## How this maps to the Tauri build

| Tauri | Native |
|---|---|
| `#[tauri::command]` + `invoke()` | direct calls into `Services/`, dispatched off the main actor |
| `app.emit("environment-updated")` | `NotificationCenter` (`.environmentsChanged`, `.ngrokChanged`) |
| `emit("branch-log:<branch>")` per line | `LogStore` + a 150 ms polling `LogFeed` (coalesced) |
| `Mutex<AppState>` | `AppState` behind an `NSRecursiveLock` |
| `std::process::Command` + `pre_exec(setpgid)` | `posix_spawn` with `POSIX_SPAWN_SETPGROUP` |
| `pre_exec` raising `RLIMIT_NOFILE` | raised once at launch; children inherit |
| `localStorage` (theme, categories) | `UserDefaults` + `categories.json` |
| React `useState` / `useMemo` | `@Observable` models |
| `window-vibrancy` | `NSVisualEffectView` behind the hosting view |
| `anser` | `AnsiText.swift` |
| `react-window` | `LazyVStack` + `ScrollViewReader` |

State lives where it always did — `~/Library/Application Support/com.teabranch.dev/settings.json`
— so the native app picks up an existing project path with no re-onboarding.

## Deliberate differences

- **Swipe-to-delete → hover + confirm.** Swiping a row is a touch idiom; the native card
  reveals a trash button on hover (and offers Delete in the context menu), then asks once.
- **Lane resizing is an `HSplitView`** instead of hand-rolled drag handles.
- **File watcher dropped.** It only ever emitted `file-changed:<branch>`, which nothing but the
  embedded preview iframe consumed — and that window was unreachable from the UI.
- **Split-preview window dropped.** `open_preview_window` / `SplitPreview` had no call site in
  the React app; "Preview" opens the branch in the default browser, as it did before.
- **Auto-scroll is a toggle only.** The web build turned it off when you scrolled away from the
  bottom; detecting that needs macOS 15 scroll-geometry APIs, and the deployment floor is 14.

## Terminal integration

"Open in Terminal" opens a **new tab** in the running instance wherever that's possible:

| App | Mechanism | Permission |
|---|---|---|
| Warp | `warp://action/new_tab?path=…` | none |
| iTerm | AppleScript `create tab with default profile` | Automation |
| Terminal | AppleScript ⌘T + `do script … in front window` | Accessibility |
| Ghostty, Kero | activate → ⌘T → type `cd <path> && clear` | Accessibility |
| Alacritty, Kitty, Hyper, custom | `open -a <App> <path>` | none (opens a window) |

Kero is a Ghostty fork (`sh.kero`): same `--working-directory` flag, and like Ghostty it exposes
no IPC or URL scheme, so tabs go through the keystroke path. When the app isn't running yet,
it's launched with `--working-directory=<path>` instead.

Accessibility permission is granted in System Settings → Privacy & Security → Accessibility.

## Gotcha: descriptor ownership in `Shell`

`Process` closes the child-side ends of the pipes you hand it, but the parent's read ends —
and any `/dev/null` handle you set as stdin — are yours to close. Nothing else ever does.
`Shell.capture` closes all three in a `defer`; drop that and every command leaks three
descriptors. That is fatal, not untidy: the reconcile loop runs several commands every six
seconds and a GUI app starts with a 256 descriptor budget, so within a minute every spawn
fails with `Bad file descriptor`, including the `git worktree list` behind the branch list.

Never use `FileHandle.nullDevice` here either — it's a process-wide singleton, so closing it
would break every other caller.

## Verifying the service layer

The services are plain Swift with no UI dependency, so they can be exercised headlessly by
compiling every source except `App/main.swift` together with a `main.swift` of your own:

```bash
find Sources/TeaBranch -name '*.swift' ! -path '*/App/main.swift' -print0 \
  | xargs -0 swiftc -o /tmp/verify /path/to/your/harness/main.swift
/tmp/verify
```
