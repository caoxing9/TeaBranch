import { contextBridge, ipcRenderer } from 'electron'
import type { EventName, Events } from '@shared/types'
import { IPC_EVENT, IPC_INVOKE } from '@shared/types'

/**
 * The renderer's whole view of the main process. Only plain functions cross the bridge — a Proxy
 * can't be cloned — so the typed `Api` facade is built on the renderer side from `invoke`.
 */
contextBridge.exposeInMainWorld('teabranch', {
  invoke: (method: string, args: unknown[]) => ipcRenderer.invoke(IPC_INVOKE, method, args),
  on<K extends EventName>(name: K, listener: (payload: Events[K]) => void): () => void {
    const handler = (_event: unknown, event: EventName, payload: unknown): void => {
      if (event === name) listener(payload as Events[K])
    }
    ipcRenderer.on(IPC_EVENT, handler)
    return () => ipcRenderer.removeListener(IPC_EVENT, handler)
  },
})
