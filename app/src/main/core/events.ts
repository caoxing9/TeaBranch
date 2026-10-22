import type { BrowserWindow } from 'electron'
import { type EventName, type Events, IPC_EVENT } from '@shared/types'

let target: BrowserWindow | null = null

export const setEventTarget = (window: BrowserWindow | null): void => {
  target = window
}

/** Push an event to the renderer. Dropped while the window is gone — the UI reloads on reopen. */
export function emit<K extends EventName>(name: K, payload: Events[K]): void {
  if (target && !target.isDestroyed()) target.webContents.send(IPC_EVENT, name, payload)
}

/** Coalesce bursts of the same event: one start posts "changed" three or four times. */
const pending = new Map<EventName, NodeJS.Timeout>()
export function emitSoon(name: 'branchesChanged' | 'issueRunsChanged', delayMs = 150): void {
  if (pending.has(name)) return
  pending.set(
    name,
    setTimeout(() => {
      pending.delete(name)
      emit(name, undefined)
    }, delayMs),
  )
}
