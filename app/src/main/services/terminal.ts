import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { shell } from 'electron'
import type { TerminalPreset } from '@shared/types'
import { TeaBranchError } from '../core/log'
import { run, shellQuote } from '../core/shell'

/**
 * Opening a worktree in a terminal tab or an editor.
 *
 * Otty has a real control CLI (cwd and command supplied up front, failures reported); Warp has a
 * URL scheme; iTerm a real AppleScript dictionary; Terminal, Ghostty and Kero only take ⌘T through
 * System Events, which needs Accessibility permission; anything else falls back to `open -a`.
 */
export const presets: TerminalPreset[] = [
  { value: 'Otty', label: 'Otty', supportsTabs: true, supportsCommands: true },
  { value: undefined, label: 'System Default (Terminal)', supportsTabs: true, supportsCommands: false },
  { value: 'Warp', label: 'Warp', supportsTabs: true, supportsCommands: false },
  { value: 'iTerm', label: 'iTerm', supportsTabs: true, supportsCommands: true },
  { value: 'Ghostty', label: 'Ghostty', supportsTabs: true, supportsCommands: false },
  { value: 'Kero', label: 'Kero', supportsTabs: true, supportsCommands: false },
  { value: 'Alacritty', label: 'Alacritty', supportsTabs: false, supportsCommands: false },
  { value: 'Kitty', label: 'Kitty', supportsTabs: false, supportsCommands: false },
  { value: 'Hyper', label: 'Hyper', supportsTabs: false, supportsCommands: false },
]

const ghosttyFamily = ['ghostty', 'kero']
const same = (a?: string, b?: string): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase()

export const isOtty = (app?: string): boolean => same(app, 'Otty')

// MARK: - Otty

/** The bundled control CLI — always present and always matching the installed app. */
function ottyCLI(): string | undefined {
  for (const base of ['/Applications', join(process.env.HOME ?? '', 'Applications')]) {
    const cli = join(base, 'Otty.app/Contents/MacOS/otty-cli')
    if (existsSync(cli)) return cli
  }
  return undefined
}

export const ottyInstalled = (): boolean => !!ottyCLI()

async function isRunning(app: string): Promise<boolean> {
  const result = await run('pgrep', ['-ix', app])
  return result.ok && result.out.length > 0
}

async function ottyOpen(path: string, title: string, command?: string): Promise<void> {
  const cli = ottyCLI()
  if (!cli) throw new TeaBranchError('Otty is not installed.')
  // A cold Otty has no control socket yet, so it gets `open` (a window) instead of `tab new`.
  const args = (await isRunning('Otty'))
    ? ['tab', 'new', '--cwd', path, '--title', title]
    : ['open', path, '--title', title]
  if (command) args.push('--command', command)
  const result = await run(cli, args)
  if (!result.ok) throw new TeaBranchError(`Otty refused the request: ${result.stderr.trim()}`)
  await run('open', ['-a', 'Otty'])
}

/** Worktrees with at least one Otty tab open on them — or in a subdirectory of them. */
export async function ottyOpenWorktrees(worktrees: string[]): Promise<Set<string>> {
  const cli = ottyCLI()
  if (!cli || !(await isRunning('Otty'))) return new Set()
  const result = await run(cli, ['tab', 'list', '--json'])
  if (!result.ok) return new Set()
  let cwds: string[]
  try {
    cwds = (JSON.parse(result.stdout).data as { cwd?: string }[]).map((tab) => resolvePath(tab.cwd ?? ''))
  } catch {
    return new Set()
  }
  return new Set(
    worktrees.filter((worktree) => {
      const root = resolvePath(worktree)
      return cwds.some((cwd) => cwd === root || cwd.startsWith(`${root}/`))
    }),
  )
}

const resolvePath = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

// MARK: - Terminals

export const canRunCommands = (app?: string): boolean =>
  isOtty(app) ? ottyInstalled() : (presets.find((p) => same(p.value, app))?.supportsCommands ?? false)

export async function open(path: string, app: string | undefined, title: string, command?: string): Promise<void> {
  if (!existsSync(path)) throw new TeaBranchError(`Path does not exist: ${path}`)
  if (isOtty(app)) return ottyOpen(path, title, command)
  if (!app) return openSystemTerminal(path, command)
  if (same(app, 'Warp')) {
    await shell.openExternal(`warp://action/new_tab?path=${encodeURIComponent(path)}`)
    return
  }
  if (same(app, 'iTerm') || same(app, 'iTerm2')) return openITerm(path, command)
  if (ghosttyFamily.includes(app.toLowerCase())) return openGhosttyLike(app, path, command)
  const result = await run('open', ['-a', app, path])
  if (!result.ok) throw new TeaBranchError(`Failed to open ${app}: ${result.stderr}`)
}

const cdCommand = (path: string, command?: string): string =>
  command?.trim() ? `cd ${shellQuote(path)} && clear && ${command}` : `cd ${shellQuote(path)} && clear`

const appleScriptLiteral = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

async function runAppleScript(script: string, hint: string): Promise<void> {
  const result = await run('osascript', ['-e', script])
  if (!result.ok) {
    throw new TeaBranchError(
      `Failed to drive ${hint}: ${result.stderr.trim()} (grant Accessibility permission to TeaBranch in System Settings → Privacy & Security)`,
    )
  }
}

function openSystemTerminal(path: string, command?: string): Promise<void> {
  const line = appleScriptLiteral(cdCommand(path, command))
  return runAppleScript(
    `tell application "Terminal"
      activate
      if (count of windows) is 0 then
        do script "${line}"
      else
        tell application "System Events" to keystroke "t" using {command down}
        delay 0.2
        do script "${line}" in front window
      end if
    end tell`,
    'Terminal',
  )
}

function openITerm(path: string, command?: string): Promise<void> {
  return runAppleScript(
    `tell application "iTerm"
      activate
      if (count of windows) is 0 then
        create window with default profile
      else
        tell current window to create tab with default profile
      end if
      tell current session of current window to write text "${appleScriptLiteral(cdCommand(path, command))}"
    end tell`,
    'iTerm',
  )
}

async function openGhosttyLike(app: string, path: string, command?: string): Promise<void> {
  if (!(await isRunning(app))) {
    const result = await run('open', ['-na', app, '--args', `--working-directory=${path}`])
    if (!result.ok) throw new TeaBranchError(`Failed to open ${app}: ${result.stderr}`)
    return
  }
  await runAppleScript(
    `tell application "${appleScriptLiteral(app)}" to activate
    delay 0.15
    tell application "System Events"
      keystroke "t" using {command down}
      delay 0.12
      keystroke "${appleScriptLiteral(cdCommand(path, command))}"
      keystroke return
    end tell`,
    app,
  )
}

// MARK: - Editor

/** VS Code, preferring a `.code-workspace` in the worktree root. */
export async function openInVSCode(path: string): Promise<void> {
  let target = path
  try {
    const workspace = readdirSync(path).find((name) => name.endsWith('.code-workspace'))
    if (workspace) target = join(path, workspace)
  } catch {
    // Fall back to the folder.
  }
  const result = await run('code', ['-n', target])
  if (!result.ok) {
    throw new TeaBranchError(`Failed to open VS Code: ${result.stderr || 'is the `code` command installed?'}`)
  }
}
