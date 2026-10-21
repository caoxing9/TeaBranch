import type { EventName, Events } from '@shared/types'

declare global {
  interface Window {
    teabranch: {
      invoke(method: string, args: unknown[]): Promise<unknown>
      on<K extends EventName>(name: K, listener: (payload: Events[K]) => void): () => void
    }
  }
}

export {}
