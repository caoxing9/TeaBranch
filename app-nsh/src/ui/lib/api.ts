import type { EventName, Events } from '../../shared/types'
import { onEvent } from '../../core/events'

/** The services' facade, the same `Api` the renderer had over IPC; one realm now, so a plain call. */
export { api } from '../../api'

export const on = <K extends EventName>(name: K, listener: (payload: Events[K]) => void): (() => void) => onEvent(name, listener)

/** An error's message, whatever threw it. */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
