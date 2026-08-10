# TeaBranch

A lightweight macOS menubar app for managing parallel branch development environments for [Teable](https://github.com/teableio/teable), powered by **Git worktrees**. Native SwiftUI + AppKit — no web view, no Rust, no Node runtime.

![Platform](https://img.shields.io/badge/platform-macOS%2014%2B-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)

<p align="center">
  <img src="docs/screenshot-list.png" width="360" alt="TeaBranch branch list" />
  <img src="docs/screenshot.png" width="600" alt="TeaBranch branch detail" />
</p>

## What is TeaBranch?

Teable is a complex full-stack project — when developing multiple features simultaneously, switching branches and restarting services is slow and error-prone. TeaBranch solves this by using Git worktrees to let you run **multiple branches in parallel**, each with its own isolated dev server, port, database, and environment — all managed from a single menubar app.

### Key Features

- **One-click worktree creation** — Creates a Git worktree, generates isolated `.env` files, installs dependencies, and runs database migrations automatically
- **Parallel dev servers** — Start/stop dev servers for each branch independently with automatic port allocation
- **Health watchdog** — Supervises by *port*, not just by PID, so a dev-server wrapper that outlives its crashed inner app gets restarted instead of sitting there looking alive
- **Orphan recovery** — Reattaches to dev servers still running after a force-quit by probing their ports on startup
- **Swim lane board** — Organize branches into "Developing", "Todo", and "Done" categories with drag-and-drop
- **Menubar integration** — Left-click the icon to toggle the window under it, right-click for Show / Quit
- **Real-time logs** — Per-branch, per-source stdout/stderr with ANSI colour, search, and copy
- **Open in Terminal / VS Code** — Opens a *new tab* in the running terminal where the app allows it (Warp, iTerm, Terminal, Ghostty, Kero)
- **ngrok tunnels** — One-command public tunnel for a branch, written back into its env file
- **Isolated environments** — Each worktree gets its own ports, database, and Redis DB index

## Install

Grab `TeaBranch-<version>-universal.dmg` from [Releases](https://github.com/caoxing9/TeaBranch/releases) and drag it to Applications. Universal binary — Apple Silicon and Intel.

The build is **ad-hoc signed and not notarized**, so macOS quarantines it on first launch. Either right-click → Open, or:

```bash
xattr -d com.apple.quarantine /Applications/TeaBranch.app
```

Escaping that step needs a paid Apple Developer ID.

## Build from source

```bash
git clone git@github.com:caoxing9/TeaBranch.git
cd TeaBranch/swift
./scripts/build_app.sh                    # host arch → build/TeaBranch.app
./scripts/build_app.sh --universal --dmg  # universal + build/TeaBranch-<version>-universal.dmg
open build/TeaBranch.app
```

Requirements: macOS 14+ and a Swift 6 toolchain. Command Line Tools are enough — there is no
Xcode project, and nothing in the build path needs `xcodebuild`.

See [swift/README.md](swift/README.md) for the source layout, the terminal-integration matrix,
and the things worth knowing before touching the process or descriptor handling.

## Usage

1. **Select a project** — On first launch, pick the Teable Git repository directory
2. **Browse branches** — Every branch-backed worktree is listed with its status
3. **Create worktree** — "New Branch" builds an isolated worktree for a branch
4. **Start a branch** — "Start" spins up the dev server with isolated ports
5. **Open in Terminal / VS Code** — "Term" or "Code" to jump into the worktree
6. **Preview** — Opens the running branch in your browser on a `<branch>.localhost` subdomain, so each branch gets its own cookie jar
7. **Organize** — Board view drags branches between "Developing", "Todo", and "Done" lanes
8. **Delete** — Hover a card for the trash button, or right-click → Delete Worktree. Confirms once.
9. **Menubar** — Closing the window hides it; the app keeps running. Quit with ⌘Q or the icon's right-click menu.

## How Worktree Isolation Works

When you create a worktree through TeaBranch, it:

1. **Fetches** the latest from `origin/develop`
2. **Creates** a Git worktree in a sibling directory (`<repo>-worktree/<branch-name>`)
3. **Generates** a `.env.development.local` with unique ports (PORT, SOCKET_PORT, SERVER_PORT), a dedicated PostgreSQL database, and isolated Redis DB index
4. **Installs** dependencies via `pnpm install`
5. **Runs** database migrations

Each environment is fully isolated — no port conflicts, no shared databases.

Ports come from a "slot" that fixes a worktree's whole block (`3000 + slot*100`). Slot assignment
reads the real `PORT` values off disk and probes the machine, not just the slot markers — the two
drift apart whenever a derived port was already taken (macOS AirPlay owns 7000), and a
marker-only `max+1` would hand the same port to two worktrees.

## Configuration

Settings live in `~/Library/Application Support/com.teabranch.dev/settings.json`. The terminal app
is configurable from the Settings sheet (gear icon in the title bar).

| Setting | Default | Description |
|---------|---------|-------------|
| `projectPath` | — | Root Git repository path |
| `basePort` | `3001` | Starting port for allocation |
| `defaultStartCommand` | `npm run dev` | Fallback when `package.json` names no dev script |
| `terminalApp` | System Terminal | Preferred terminal app (Warp, iTerm, Ghostty, …) |

Branch → swim-lane assignments live alongside it in `categories.json`.

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes — the repo uses [Conventional Commits](https://www.conventionalcommits.org/); `feat:` and `fix:` drive the release version
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request — CI builds the app universal, so an Intel-only compile error can't land

## License

MIT
