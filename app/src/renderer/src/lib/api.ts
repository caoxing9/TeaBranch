import type { Api, EventName, Events } from '@shared/types'

/** Typed facade over the one IPC channel: `api.startBranch(name)` → invoke('startBranch', [name]). */
export const api = new Proxy({} as Api, {
  get:
    (_target, method: string) =>
    (...args: unknown[]) =>
      window.teabranch.invoke(method, args),
})

export const on = <K extends EventName>(name: K, listener: (payload: Events[K]) => void): (() => void) =>
  window.teabranch.on(name, listener)

/** IPC rejections arrive as "Error invoking remote method '…': Error: <message>"; keep the message. */
export function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const match = /Error invoking remote method '[^']+': (?:\w*Error: )?([\s\S]*)$/.exec(raw)
  return match ? match[1] : raw
}
