import { Process, Shell } from 'teabranch/native'
import { log } from './log'

export interface CommandResult {
  status: number
  stdout: string
  stderr: string
  ok: boolean
  out: string
}

/**
 * The user's PATH as their login shell reports it.
 *
 * A bundled app inherits launchd's minimal PATH, so `git`, `pnpm`, `psql`, `ngrok`, `claude` would
 * all be missing. The Rust base resolves it once, on the first child; every child gets it.
 */
export async function resolveUserPath(): Promise<void> {
  const path = Shell.path()
  if (path.includes('/')) log.info(`Resolved user PATH from ${Shell.env('SHELL') ?? '/bin/zsh'}`)
  else log.warn('Could not resolve user PATH, using the inherited one')
}

/** The login shell's PATH, for a child that puts its own directory in front. */
export const userPATH = (): string => Shell.path()

/** A variable of the app's own environment. */
export const env = (name: string): string | undefined => Shell.env(name) ?? undefined

/** Run an executable through PATH and capture its output. Never rejects. */
export function run(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = new Process('/usr/bin/env', [executable, ...args], {
      cwd: options.cwd ?? null,
      env: Object.entries(options.env ?? {}).map(([name, value]) => ({ name, value })),
    })
    let stdout = ''
    let stderr = ''
    child.onStdout((line) => {
      stdout += line + '\n'
    })
    child.onStderr((line) => {
      stderr += line + '\n'
    })
    const pid = child.start()
    const timer = options.timeoutMs && pid ? setTimeout(() => child.kill(200), options.timeoutMs) : undefined
    void child.wait().then((exit) => {
      if (timer) clearTimeout(timer)
      const status = exit.error ? -1 : exit.signal ? -1 : (exit.code ?? -1)
      resolve({
        status,
        stdout,
        stderr: stderr || (exit.error ?? (exit.signal ? `terminated by ${exit.signal}` : '')),
        ok: status === 0,
        out: stdout.trim(),
      })
    })
  })
}

/** `sh -c` a command string. */
export const sh = (command: string, cwd?: string, env?: Record<string, string>): Promise<CommandResult> =>
  run('/bin/sh', ['-c', command], { cwd, env })

export const git = (args: string[], cwd: string): Promise<CommandResult> => run('git', args, { cwd })

/** Quote for safe interpolation into an `sh -c` string. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
