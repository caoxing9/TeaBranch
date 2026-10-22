# TeaBranch

A macOS app for working on [Teable](https://github.com/teableio/teable) in parallel. Every branch lives in its own Git worktree with its own dev server, ports, database and environment. Point it at a Teable issue table and it goes one step further: a local agent triages each issue, fixes it in its own worktree, opens the PR and gets it reviewed. What's left for you is the review.

![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)
![Architecture](https://img.shields.io/badge/arch-Apple%20Silicon-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)

## What is TeaBranch?

Teable is a large full-stack project, and switching branches means restarting everything. TeaBranch keeps each branch checked out in its own worktree, so switching is a click and nothing has to restart. With several branches running side by side, issue fixing parallelises as well: each issue gets a worktree named after its ID, with its own agent conversation and its own terminal.

The window has two sections: **Branches** (⌘1) and **Issues** (⌘2).

## Issues: agent-driven fixing

**From the issue table**

- Sign in to Teable (teable.ai by default) and point TeaBranch at your issue table. It maps the title, description, status, assignee and ID fields.
- By default it shows **only your issues**, filtered server-side. Teable-style field filters narrow them further.
- Issues are grouped by where they stand: needs you, awaiting review, in progress, not started. Descriptions, comments and attachments render inline, and images open in a lightbox.

**Fixing**

- **自动修复** creates a worktree whose branch is exactly the issue ID (e.g. `T2312`), then hands the agent the full issue, attachments included.
- **Triage first** (on by default). Before touching code, the agent checks whether the issue was already fixed (git log, open PRs) and tries to reproduce it locally with a minimal failing test. It then decides whether it's a bug at all. Only a confirmed bug is fixed automatically. Anything else stops with its verdict (already fixed / not a bug / needs info), and you can still press **仍然修复** to fix it anyway.
- The agent finds the root cause, fixes it, and opens a PR that carries the issue ID.
- **Review**: Codex, or a local model through Magpie, reviews the PR. Its findings go back to the issue's agent, which addresses them for a configurable number of rounds.
- **Batches**: select several issues (or 全部修复) and they queue up N at a time. A notification arrives when the whole batch is done.

**Conversations**

- Each issue has its own Claude Code conversation, and you can interject at any point. The composer picks the model, effort level and access mode, and takes attachments.
- **+** opens another chat in the issue's worktree, building the worktree first if there isn't one. Chat tabs are grouped per issue, so switching issues switches tabs. You can also open free-standing chats in any worktree.
- A built-in terminal dock (⌘J to show or hide, ⌘\` for a new terminal) opens shells in the issue's worktree. Terminals are grouped per issue like the chats.
- The menu-bar icon animates while agents are running.

**Requirements:** [Claude Code](https://claude.com/claude-code) (`claude`) and the GitHub CLI (`gh`, signed in) on your `PATH`. Codex (`codex`) or Magpie are needed for review.

## Branches: worktrees and dev servers

**Worktrees**

- One-click creation (⌘N). It makes the worktree, generates an isolated `.env.development.local`, installs dependencies, provisions the database and runs migrations.
- Ports are allocated in blocks. Deleted worktrees' gaps are reused, and the allocator skips ports that predictably belong to something else (Postgres, Redis, macOS AirPlay's 5000 and 7000).
- A database can be created fresh, cloned from another worktree, or shared with one. By default new worktrees share the main checkout's database, which is what a branch cut from `develop` usually wants, and it skips the slowest steps.

**Running them**

- Each branch starts and stops independently.
- **Stop actually stops.** It kills by process group *and* by port, waits until the ports are really free, and tells you which PID is still holding one when they're not.
- A health watchdog supervises by port, not just by PID, so a dev-server wrapper that outlives its crashed inner app gets restarted.
- Dev servers still running after a force-quit are picked up again. Each branch shows CPU, memory, uptime and its process list.
- Logs show per source (backend, frontend) with ANSI colour and in-place search.

**Working on them**

- **Agent**, **Terminal** and **Code** open the worktree in your terminal or VS Code. With [Otty](https://otty.app) no Accessibility permission is needed.
- **Preview** opens the branch on a `<branch>.localhost` subdomain, so each branch gets its own cookie jar.
- Edit any variable in the worktree's env file; saving restarts the branch. An ngrok tunnel can be opened per branch.
- Lanes (developing / todo / done) keep the sidebar organised. Closing the window keeps the app running in the menu bar.

## Install

### Homebrew

```bash
brew tap caoxing9/teabranch https://github.com/caoxing9/TeaBranch
brew trust --cask caoxing9/teabranch/teabranch
brew install --cask teabranch
```

Upgrade with `brew upgrade --cask teabranch`. The tap is added by URL because the cask lives in this repository.

The build is ad-hoc signed and not notarized. The cask strips the quarantine attribute in a `postflight`, so the app launches without right-click → Open. As a result, Gatekeeper doesn't vet it on your machine. Notarizing with a paid Developer ID would remove the need for that.

### Manual

Download `TeaBranch-<version>-arm64.dmg` from [Releases](https://github.com/caoxing9/TeaBranch/releases) and drag the app to Applications. Apple Silicon only. Because the build isn't notarized, either right-click → Open the first time, or run:

```bash
xattr -d com.apple.quarantine /Applications/TeaBranch.app
```

## Build from source

The app is Electron + React, in [`app/`](app):

```bash
git clone git@github.com:caoxing9/TeaBranch.git
cd TeaBranch/app
pnpm install
pnpm dev            # run with hot reload
pnpm dist           # → dist/TeaBranch-<version>-arm64.dmg
```

Requirements: Node 22 and pnpm 10.

| Command | What it does |
|---------|--------------|
| `pnpm lint` | oxlint; warnings fail too |
| `pnpm format` / `pnpm format:check` | oxfmt |
| `pnpm typecheck` | TypeScript, main + renderer |
| `pnpm test` | Vitest |

CI runs all of the above plus a production build on every pull request.

Stack: Electron, electron-vite (Vite), React 19, TypeScript, Tailwind 4, shadcn/ui on Base UI, zustand, xterm.js + node-pty. The main process (`src/main`) owns git, processes, ports, agents and Teable. The renderer (`src/renderer`) talks to it over a single typed IPC channel, whose contract is in `src/shared/types.ts`.

The earlier native build is in [`swift/`](swift).

## How worktree isolation works

Creating a worktree:

1. **Fetches** the latest `origin/develop`.
2. **Creates** a Git worktree in a sibling directory (`<repo>-worktree/<branch-name>`).
3. **Generates** a `.env.development.local` with a unique port block, a database and a Redis DB index.
4. **Installs** dependencies via `pnpm install`.
5. **Provisions** the database: new, cloned, or shared with another worktree.
6. **Runs** migrations.

Ports come from a "slot" that fixes the whole block (`3000 + slot*100`). Slot assignment reads the real port values off disk rather than trusting the `# WORKTREE_SLOT=` markers. The two drift apart whenever a derived port was already taken, and trusting the marker hands the same port to two worktrees, which then kill each other's dev servers. The search starts from the first slot, so a deleted worktree's block gets reused.

## Configuration

Everything lives in `~/Library/Application Support/com.teabranch.dev/`. That's the same directory the earlier builds used, so an existing install keeps its state. Settings are edited in the app: ⌘, for branches, and **Issue 设置…** for issues.

| File | Holds |
|------|-------|
| `settings.json` | Repository path, base port, default start command, terminal app, agent command |
| `categories.json` | Lane assignments |
| `teable.json` | Issue table and field mapping, triage, models, review engine, batch size |

Teable credentials are kept encrypted with the macOS keychain (Electron `safeStorage`), not in these files.

## Contributing

1. Fork the repository and create a feature branch.
2. Commit using [Conventional Commits](https://www.conventionalcommits.org/). `feat:` and `fix:` drive the release version.
3. Open a pull request. CI lints, typechecks, tests and builds the app.

**Title the PR with a Conventional Commits prefix.** Merges are squashed, and GitHub uses the *PR title* as the commit subject. A PR called "Rebuild the interface" lands on `main` as a commit semantic-release doesn't recognise, so no release is cut.

## License

MIT
