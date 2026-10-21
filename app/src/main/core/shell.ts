import { execFile } from 'node:child_process'
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
 * all be missing. Resolved once at startup; every child gets it.
 */
let userPath = process.env.PATH ?? '/usr/bin:/bin'

export async function resolveUserPath(): Promise<void> {
  const shell = process.env.SHELL ?? '/bin/zsh'
  const probe = (bin: string, args: string[]): Promise<string | null> =>
    new Promise((resolve) => {
      execFile(bin, args, { timeout: 10_000, env: process.env }, (error, stdout) => {
        const path = stdout?.toString().trim().split('\n').pop()?.trim()
        resolve(!error && path ? path : null)
      })
    })
  const resolved = (await probe(shell, ['-lic', 'echo $PATH'])) ?? (await probe('/bin/bash', ['-lc', 'echo $PATH']))
  if (resolved) {
    userPath = resolved
    log.info(`Resolved user PATH from ${shell}`)
  } else {
    log.warn('Could not resolve user PATH, using the inherited one')
  }
}

export function childEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, PATH: userPath, ...extra }
}

/** Run an executable through PATH and capture its output. Never rejects. */
export function run(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/env',
      [executable, ...args],
      {
        cwd: options.cwd,
        env: childEnvironment(options.env),
        maxBuffer: 64 * 1024 * 1024,
        timeout: options.timeoutMs,
      },
      (error, stdout, stderr) => {
        const status = error ? (typeof error.code === 'number' ? error.code : -1) : 0
        const out = stdout?.toString() ?? ''
        resolve({
          status,
          stdout: out,
          stderr: stderr?.toString() || (error && status === -1 ? error.message : ''),
          ok: status === 0,
          out: out.trim(),
        })
      },
    )
  })
}

/** `sh -c` a command string. */
export const sh = (command: string, cwd?: string, env?: Record<string, string>): Promise<CommandResult> =>
  run('/bin/sh', ['-c', command], { cwd, env })

export const git = (args: string[], cwd: string): Promise<CommandResult> => run('git', args, { cwd })

/** Quote for safe interpolation into an `sh -c` string. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
