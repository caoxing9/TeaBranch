import { create } from 'zustand'
import type { Chat, ConversationEntry } from '@shared/types'
import { api, on } from '@/lib/api'

/** Free-standing AI conversations and their transcripts, mirrored from the main process. */
interface ChatsStore {
  chats: Chat[]
  transcripts: Record<string, ConversationEntry[]>
  init(): Promise<void>
  loadTranscript(id: string): Promise<void>
}

let listening = false

export const useChats = create<ChatsStore>((set, get) => ({
  chats: [],
  transcripts: {},

  async init() {
    set({ chats: await api.listChats() })
    if (listening) return
    listening = true
    on('chatsChanged', async () => set({ chats: await api.listChats() }))
    on('chatTranscript', ({ chatId, entries }) => {
      const current = get().transcripts[chatId]
      // Not loaded yet: the full load will include these.
      if (current) set({ transcripts: { ...get().transcripts, [chatId]: [...current, ...entries] } })
    })
  },

  async loadTranscript(id) {
    if (get().transcripts[id]) return
    const entries = await api.chatTranscript(id)
    set({ transcripts: { ...get().transcripts, [id]: entries } })
  },
}))
