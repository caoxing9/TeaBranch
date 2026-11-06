import { Process, Sys } from 'teabranch/native'

export type Signal = 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP'
export type ExitReason = { code: number | null; signal: string | null }

export const exitDescription = ({ code, signal }: ExitReason): string =>
  signal ? `terminated by signal ${signal}` : code === 0 ? 'exited cleanly' : `exited with code ${code}`

export const isCleanExit = ({ code, signal }: ExitReason): boolean => code === 0 && !signal

export interface Child {
  pid: number
  process: Process
  /** Resolves once the process has exited and both streams have drained. */
  exited: Promise<ExitReason>
}

/**
 * Run `command` under `/bin/sh` from `cwd`, as the leader of a fresh process group.
 *
 * The group is what lets `pnpm dev`'s whole tree of node processes be taken down with one signal
 * (`killpg`). stdin is /dev/null — `next dev` turns on keypress handling when it looks like a TTY
 * and exits the moment that input hits EOF — unless `stdin` asks for a pipe, for a process that is
 * talked to while it runs.
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
  const child = new Process('/bin/sh', ['-c', script], {
    env: Object.entries(env).map(([name, value]) => ({ name, value })),
    stdin: options.stdin ?? false,
  })
  if (onLine) {
    child.onStdout((line) => onLine(line, 'stdout'))
    child.onStderr((line) => onLine(line, 'stderr'))
  }
  const pid = child.start()
  // `wait` delivers every line before the exit, so the streams are drained by then.
  const exited = child.wait().then((exit) => (exit.error ? { code: -1, signal: null } : { code: exit.code ?? null, signal: exit.signal ?? null }))
  return { pid: pid || -1, process: child, exited }
}

/** Signal a whole process group. Swallows ESRCH: an already-dead group is the goal. */
export function signalGroup(pgid: number, signal: Signal | 0): boolean {
  if (pgid <= 0) return false
  return Sys.signalGroup(pgid, signal === 0 ? 'NONE' : signal)
}

export const groupAlive = (pgid: number): boolean => signalGroup(pgid, 0)

/** SIGTERM the group, then SIGKILL what is left after `graceMs`. */
export function killGroup(pgid: number, graceMs = 300): void {
  signalGroup(pgid, 'SIGTERM')
  setTimeout(() => signalGroup(pgid, 'SIGKILL'), graceMs)
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
