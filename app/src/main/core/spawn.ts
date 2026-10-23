import { type ChildProcess, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { childEnvironment } from './shell'

export type ExitReason = { code: number | null; signal: NodeJS.Signals | null }

export const exitDescription = ({ code, signal }: ExitReason): string =>
  signal ? `terminated by signal ${signal}` : code === 0 ? 'exited cleanly' : `exited with code ${code}`

export const isCleanExit = ({ code, signal }: ExitReason): boolean => code === 0 && !signal

export interface Child {
  pid: number
  process: ChildProcess
  /** Resolves once the process has exited and both streams have drained. */
  exited: Promise<ExitReason>
}

/**
 * Run `command` under `/bin/sh` from `cwd`, as the leader of a fresh process group.
 *
 * `detached` is what makes the group: `pnpm dev` forks a tree of node processes, and only a signal
 * to the whole group (`kill(-pgid)`) takes all of it down. stdin is /dev/null — `next dev` turns
 * on keypress handling when it looks like a TTY and exits the moment that input hits EOF — unless
 * `stdin` asks for a pipe, for a process that is talked to while it runs.
 *
 * The descriptor limit is raised inside the shell: a GUI app inherits launchd's 256, which is far
 * too low for webpack/swc/chokidar — dev servers hang silently on first compile with EMFILE.
 */
export function spawnShell(
  command: string,
  cwd: string,
  env: Record<string, string> = {},
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
  options: { stdin?: boolean } = {},
): Child {
  const script = `ulimit -n 65536 2>/dev/null || ulimit -n 10240 2>/dev/null; cd -- '${cwd.replace(/'/g, `'\\''`)}' || exit 127\n${command}`
  const child = spawn('/bin/sh', ['-c', script], {
    detached: true,
    stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    env: childEnvironment(env),
  })

  const drained: Promise<void>[] = []
  for (const stream of ['stdout', 'stderr'] as const) {
    const source = child[stream]
    if (!source) continue
    const reader = createInterface({ input: source, crlfDelay: Infinity })
    drained.push(new Promise((resolve) => reader.once('close', () => resolve())))
    if (onLine) reader.on('line', (line) => onLine(line, stream))
  }

  const exited = new Promise<ExitReason>((resolve) => {
    child.once('error', () => resolve({ code: -1, signal: null }))
    child.once('exit', (code, signal) => {
      // Give the readers their last lines before reporting the exit.
      void Promise.race([Promise.all(drained), new Promise((r) => setTimeout(r, 500))]).then(() => resolve({ code, signal }))
    })
  })

  return { pid: child.pid ?? -1, process: child, exited }
}

/** Signal a whole process group. Swallows ESRCH: an already-dead group is the goal. */
export function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  if (pgid <= 0) return false
  try {
    process.kill(-pgid, signal)
    return true
  } catch {
    return false
  }
}

export const groupAlive = (pgid: number): boolean => signalGroup(pgid, 0)

/** SIGTERM the group, then SIGKILL what is left after `graceMs`. */
export function killGroup(pgid: number, graceMs = 300): void {
  signalGroup(pgid, 'SIGTERM')
  setTimeout(() => signalGroup(pgid, 'SIGKILL'), graceMs)
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
