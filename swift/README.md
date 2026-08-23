# TeaBranch — native Swift

The app: SwiftUI + AppKit, no web view, no Rust, no Node runtime.

## Build & run

There is deliberately no Xcode project. SwiftPM builds the binary and a script lays out the
bundle by hand, so the whole build works with just the Command Line Tools — nothing in the
path needs `xcodebuild`.

```bash
cd swift
./scripts/build_app.sh                    # → build/TeaBranch.app (ad-hoc signed)
./scripts/build_app.sh --dmg              # ...and build/TeaBranch-<version>-arm64.dmg
open build/TeaBranch.app

swift build                               # plain debug build, no bundle
```

Requirements: macOS 26+ on Apple Silicon, Swift 6.2 toolchain (`swift --version`).

The build is Apple Silicon only — the app targets macOS 26 for Liquid Glass, so there is no
Intel slice to merge any more. `build_app.sh` lays out the bundle by hand and ad-hoc signs it;
nothing in the path needs `xcodebuild`, so the same command runs here and in CI with only the
Command Line Tools installed.

## Release

`.github/workflows/release.yml` builds and uploads one arm64 DMG per release semantic-release
publishes. It needs a runner image carrying the macOS 26 SDK and Swift 6.2.

The version lives in `Resources/Info.plist` — there is no generated manifest to derive it from,
and it's what ends up in the bundle and the DMG filename. `scripts/bump-version.mjs` stamps it
(alongside `package.json`, which exists only as semantic-release's version anchor) and
`.releaserc.json` commits it, so the plist can't drift from the tag.

The DMG is **ad-hoc signed and not notarized**, so a downloaded build is quarantined on first
launch: right-click → Open, or `xattr -d com.apple.quarantine /Applications/TeaBranch.app`.
Escaping that needs a paid Developer ID.

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
    │   ├── MainWindowController.swift  the window: full-height sidebar, hide-on-close, frame restore
    │   └── StatusItemController.swift  menu bar icon, left-click toggle, right-click menu
    ├── Core/
    │   ├── Shell.swift             login-shell PATH resolution + blocking command capture
    │   ├── Spawn.swift             posix_spawn with its own process group, piped line streaming
    │   ├── Ports.swift             bind probes, lsof lookups, graceful port reclaim
    │   ├── EnvFile.swift           .env read/rewrite (conservative), Postgres URL surgery
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
    │   ├── TerminalService.swift   open a worktree in a terminal tab / VS Code
    │   ├── OttyService.swift       Otty control CLI: open tabs, run the agent, read open cwds
    │   ├── ProcessStats.swift      per-worktree CPU/memory/uptime, grouped by process group
    │   └── AgentScratchService.swift  locate what Claude Code generated for a worktree
    └── UI/
        ├── Theme.swift             Liquid Glass surfaces, semantic colour, type ramp, motion
        ├── AppModel.swift          main-actor view model
        ├── RootView.swift          NavigationSplitView shell, onboarding
        ├── BranchSidebarView.swift persistent branch list, lane sections, row + context menu
        ├── BranchDetailView.swift  identity header, glass action bar, log pane
        ├── BranchInspectorView.swift  Info / Env tabs: resources, ports, worktree, env editor
        ├── LogPaneView.swift       source tabs, search, auto-scroll, jump-to-latest
        ├── LogTextView.swift       the console itself — NSTextView, incremental, ANSI
        ├── AnsiText.swift          ANSI SGR → AttributedString / NSAttributedString
        ├── StatusBadgeView.swift   status dot + category picker
        ├── CreateWorktreeSheet.swift
        └── SettingsSheet.swift
```

## How the pieces fit

Services are plain synchronous Swift and every one of them blocks — `git`, `psql`, `lsof`,
`pnpm install`, waiting on ngrok, sometimes for minutes. Swift concurrency's cooperative pool
is sized to the core count and must not block, so that work goes to the GCD queues in
`Background.swift` and hops back to the main actor explicitly via `onMain`. `AppState` sits
behind an `NSRecursiveLock` rather than an actor for the same reason: the log readers, the
health watchdog and the reconcile loop all live on their own threads and need synchronous reads.

Services announce changes through `NotificationCenter` (`.environmentsChanged`, `.ngrokChanged`)
and `AppModel` refreshes off that. Log lines are the exception — they arrive far faster than
SwiftUI wants to re-render, so `LogStore` keeps capped per-source buffers and `LogFeed` polls a
generation counter every 150 ms, rebuilding only when it actually moved.

State lives in `~/Library/Application Support/com.teabranch.dev/settings.json`, with lane
assignments alongside it in `categories.json`.

Branch reloads are coalesced. A single start posts `.environmentsChanged` three or four times —
once when the environment is claimed, once when it goes running, once from the watchdog — and each
one is a full reload: two `git` subprocesses, a terminal probe, and a managed-ness check across
every worktree. `AppModel.refresh()` debounces; `refreshNow()` is the uncoalesced path for the
first load.

## Behaviour worth knowing

- **Delete is a context-menu item plus an alert.** Sidebar rows are navigation targets first, so
  hover-revealed destructive buttons in a dense list were removed — that is how you mis-click
  Delete.
- **Stop blocks until the ports are actually free.** It holds a suppression flag the reconcile
  loop respects, kills by process group *and* by port, and throws if anything survives SIGKILL.
  Before this, Stop returned immediately and the 6-second reconcile — which reads ports out of
  the worktree env file — saw the still-dying server and set the branch back to Running.
- **The log console is an `NSTextView`, updated incrementally.** A `LazyVStack` of one `Text` per
  line cannot hold a selection across a line boundary. The coordinator tracks the id and rendered
  length of every line in the storage, so the constant eviction past `perSourceCap` is a prefix
  delete rather than a full rebuild — the rebuild it replaced cost 128 ms on a 15k-line buffer and
  ran every 150 ms.
- **Log search is indexed, not rescanned.** `LogLine` precomputes an ANSI-stripped lowercased
  haystack on the reader thread, and the match list is recomputed only when the buffer, needle or
  tab changes. It used to be a computed property evaluated six times per body pass plus once per
  rendered row, which cost roughly a second of main thread per pass. The index must be counted
  over the same text the highlighter searches — including the `[source] ` prefix in the All tab,
  or the two lists disagree and the match stepper walks to the wrong hit.
- **Start/stop run concurrently across branches, serially within one.** `allocationLock` covers
  only port picking; a per-branch recursive lock is what keeps `git worktree remove --force` from
  running alongside an in-flight `pnpm install` in the same directory.
- **Env writes are conservative.** Unchanged lines go back byte for byte, only the assignment that
  *decides* a value is rewritten, duplicates are never dropped, and comments and the
  `# WORKTREE_SLOT=` marker survive — the file is usually under version control.
- **Resource usage is grouped by process group.** Everything spawned leads its own, so a branch's
  whole `pnpm → turbo → next dev` tree shares one pgid. A branch adopted as an orphan has no PIDs
  of ours and is resolved through the port it serves instead.
- **"Preview" opens the default browser**, on a `<branch>.localhost` subdomain so each branch
  gets its own cookie jar. There is no embedded preview.
- **Quitting kills dev servers**, including ones TeaBranch didn't start: `reconcile()` adopts
  anything listening on a worktree's configured ports as a recovered environment, and
  `cleanupAll()` kills by port. That is what makes force-quit recovery work, but it means the
  app is not safe to run alongside hand-started servers on those ports.

## Terminal integration

"Open in Terminal" opens a **new tab** in the running instance wherever that's possible:

| App | Mechanism | Permission |
|---|---|---|
| Otty | `otty-cli tab new --cwd … --command …` over its control socket | none |
| Warp | `warp://action/new_tab?path=…` | none |
| iTerm | AppleScript `create tab with default profile` | Automation |
| Terminal | AppleScript ⌘T + `do script … in front window` | Accessibility |
| Ghostty, Kero | activate → ⌘T → type `cd <path> && clear` | Accessibility |
| Alacritty, Kitty, Hyper, custom | `open -a <App> <path>` | none (opens a window) |

Kero is a Ghostty fork (`sh.kero`): same `--working-directory` flag, and like Ghostty it exposes
no IPC or URL scheme, so tabs go through the keystroke path. When the app isn't running yet,
it's launched with `--working-directory=<path>` instead.

Otty is the default when installed, and the only one that is fully addressable: it takes a cwd
*and* a command up front (which is what the **Agent** button uses to start `claude` in the
worktree), needs no Accessibility permission, reports failure, and answers `tab list --json` —
so the sidebar can show which worktrees already have a terminal open.

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
