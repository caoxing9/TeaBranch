import type { LogLine } from '@shared/types'
import { emit } from './events'

const knownSources = ['backend', 'frontend', 'dev']

/**
 * What a terminal would show for a line: colour (SGR) escapes kept, every other control sequence
 * dropped. `pnpm install` and friends redraw a progress line with "clear line / move cursor"
 * escapes and carriage returns, which a log view would otherwise print as `[2K[1G` garbage.
 */
export function sanitize(raw: string): string {
  let text = raw
  // A carriage return overwrites the line: what remains visible is the last segment written.
  if (text.includes('\r')) {
    const segments = text.split('\r').filter((segment) => segment.length > 0)
    text = segments[segments.length - 1] ?? ''
  }
  // oxlint-disable no-control-regex -- stripping terminal control sequences is the point
  return (
    text
      // OSC (window titles, hyperlinks): ESC ] … BEL | ESC \\
      .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
      // CSI sequences other than SGR (`m`): cursor movement, erase, mode switches.
      .replace(/\u001B\[[0-9;?]*[ -/]*[@-ln-~]/g, '')
      // Lone two-byte escapes (ESC 7, ESC 8, ESC =, …).
      .replace(/\u001B[^[\]]/g, '')
      // Remaining C0 controls except tab and ESC (ESC still starts colour codes).
      .replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g, '')
  )
}

/** The `[label]` prefix of a line, when it names a known process. */
export function sourceOf(text: string): string | undefined {
  if (!text.startsWith('[')) return undefined
  const close = text.indexOf(']')
  const label = close > 0 ? text.slice(1, close) : ''
  return knownSources.includes(label) ? label : undefined
}

/**
 * Per-branch log buffers, capped per *source* — a global cap let a chatty backend push the much
 * sparser frontend lines out. New lines reach the renderer in 150 ms batches: a dev server logs
 * far faster than a UI wants to re-render.
 */
class LogStore {
  static readonly perSourceCap = 5000

  private buffers = new Map<string, LogLine[]>()
  private counts = new Map<string, Map<string, number>>()
  private nextId = 0
  private outbox = new Map<string, LogLine[]>()
  private flushTimer: NodeJS.Timeout | null = null

  append(branch: string, raw: string): void {
    const text = sanitize(raw)
    const source = sourceOf(text)
    const line: LogLine = { id: ++this.nextId, at: Date.now(), text, source }

    const buffer = this.buffers.get(branch) ?? []
    buffer.push(line)
    this.buffers.set(branch, buffer)

    const key = source ?? ''
    const counts = this.counts.get(branch) ?? new Map<string, number>()
    counts.set(key, (counts.get(key) ?? 0) + 1)
    this.counts.set(branch, counts)
    if ((counts.get(key) ?? 0) > LogStore.perSourceCap) {
      // The oldest line of this source is near the front, so this scan is short.
      const index = buffer.findIndex((candidate) => (candidate.source ?? '') === key)
      if (index >= 0) buffer.splice(index, 1)
      counts.set(key, (counts.get(key) ?? 1) - 1)
    }

    const pending = this.outbox.get(branch) ?? []
    pending.push(line)
    this.outbox.set(branch, pending)
    this.flushTimer ??= setTimeout(() => this.flush(), 150)
  }

  private flush(): void {
    this.flushTimer = null
    for (const [branch, lines] of this.outbox) emit('logs', { branch, lines })
    this.outbox.clear()
  }

  snapshot = (branch: string): LogLine[] => [...(this.buffers.get(branch) ?? [])]

  clear(branch: string): void {
    this.buffers.set(branch, [])
    this.counts.set(branch, new Map())
  }

  remove(branch: string): void {
    this.buffers.delete(branch)
    this.counts.delete(branch)
  }
}

export const logs = new LogStore()
export const ngrokLogs = new LogStore()
