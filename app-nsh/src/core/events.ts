import type { EventName, Events } from '../shared/types'

/**
 * Events from the services to the UI. One realm now, so an event is a call to the listeners the
 * UI registered; nothing crosses a process boundary any more.
 */
type Listener<K extends EventName> = (payload: Events[K]) => void

const listeners = new Map<EventName, Set<Listener<EventName>>>()

/** Listen for `name`; returns the unsubscribe. */
export function onEvent<K extends EventName>(name: K, listener: Listener<K>): () => void {
  let set = listeners.get(name)
  if (!set) {
    set = new Set()
    listeners.set(name, set)
  }
  set.add(listener as Listener<EventName>)
  return () => {
    set.delete(listener as Listener<EventName>)
  }
}

/** Push an event to the UI. A listener that throws does not stop the others. */
export function emit<K extends EventName>(name: K, payload: Events[K]): void {
  for (const listener of listeners.get(name) ?? []) {
    try {
      listener(payload)
    } catch (error) {
      console.error(`[TeaBranch] listener of ${name} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Coalesce bursts of the same event: one start posts "changed" three or four times. */
const pending = new Map<EventName, ReturnType<typeof setTimeout>>()

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
