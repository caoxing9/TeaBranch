import { Pty } from 'teabranch/native'
import { existsSync } from '../node/fs'
import { homedir } from '../node/os'
import { basename } from 'path'
import { emit } from '../core/events'
import { log } from '../core/log'
import { env } from '../core/shell'

/**
 * The built-in terminals: one login shell per tab, owned here so a tab survives its view being
 * unmounted (switching issue, hiding the dock). Recent output is kept so a view that reattaches
 * can replay it. The pty itself is the Rust base's.
 */

const REPLAY_LIMIT = 256 * 1024

interface Session {
  pty: Pty
  /** Recent output, newest last, capped at REPLAY_LIMIT characters. */
  replay: string
  /** Chunks emitted so far; a reattaching view drops live chunks the replay already holds. */
  seq: number
  title: string
  exited: boolean
}

const sessions = new Map<string, Session>()

/** Start the shell for `id`, or reattach to it: either way the output so far comes back for replay. */
export function open(id: string, cwd: string, cols: number, rows: number): { replay: string; seq: number; title: string; exited: boolean } {
  const existing = sessions.get(id)
  if (existing) {
    if (!existing.exited) existing.pty.resize(Math.max(cols, 2), Math.max(rows, 1))
    return { replay: existing.replay, seq: existing.seq, title: existing.title, exited: existing.exited }
  }
  const shell = env('SHELL') || '/bin/zsh'
  const pty = new Pty(shell, ['-l'], existsSync(cwd) ? cwd : homedir(), Math.max(cols, 2), Math.max(rows, 1), [
    { name: 'TERM', value: 'xterm-256color' },
    { name: 'COLORTERM', value: 'truecolor' },
    { name: 'TERM_PROGRAM', value: 'TeaBranch' },
  ])
  const session: Session = { pty, replay: '', seq: 0, title: basename(shell), exited: false }
  sessions.set(id, session)
  pty.onData((data) => {
    session.replay = (session.replay + data).slice(-REPLAY_LIMIT)
    session.seq += 1
    emit('terminalData', { id, data, seq: session.seq })
  })
  pty.start()
  void pty.wait().then((code) => {
    session.exited = true
    emit('terminalExit', { id, code })
  })
  return { replay: '', seq: 0, title: session.title, exited: false }
}

export function write(id: string, data: string): void {
  const session = sessions.get(id)
  if (session && !session.exited) session.pty.write(data)
}

export function resize(id: string, cols: number, rows: number): void {
  const session = sessions.get(id)
  if (session && !session.exited) session.pty.resize(Math.max(cols, 2), Math.max(rows, 1))
}

export function kill(id: string): void {
  const session = sessions.get(id)
  sessions.delete(id)
  if (!session || session.exited) return
  try {
    session.pty.kill()
  } catch (error) {
    log.warn(`terminal ${id}: ${String(error)}`)
  }
}

export function killAll(): void {
  for (const id of sessions.keys()) kill(id)
}

// The foreground process names the tab (zsh, node, claude, vim…), like Terminal.app's title.
setInterval(() => {
  for (const [id, session] of sessions) {
    if (session.exited) continue
    const title = session.pty.processName()
    if (title && title !== session.title) {
      session.title = title
      emit('terminalTitle', { id, title })
    }
  }
}, 1000)
