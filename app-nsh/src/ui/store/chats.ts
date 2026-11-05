import type { Chat, ConversationEntry } from '../../shared/types'
import { api, on } from '../lib/api'
import { createStore } from './base'

/** Free-standing AI conversations and their transcripts, mirrored from the services. */
interface ChatsState {
  chats: Chat[]
  transcripts: Record<string, ConversationEntry[]>
}

const fields = createStore<ChatsState>({ chats: [], transcripts: {} })
let listening = false

export const chats = {
  ...fields,

  async init(): Promise<void> {
    fields.set({ chats: await api.listChats() })
    if (listening) return
    listening = true
    on('chatsChanged', async () => fields.set({ chats: await api.listChats() }))
    on('chatTranscript', ({ chatId, entries }) => {
      const current = fields.transcripts()[chatId]
      // Not loaded yet: the full load will include these.
      if (current) fields.set({ transcripts: { ...fields.transcripts(), [chatId]: [...current, ...entries] } })
    })
  },

  async loadTranscript(id: string): Promise<void> {
    if (fields.transcripts()[id]) return
    const entries = await api.chatTranscript(id)
    fields.set({ transcripts: { ...fields.transcripts(), [id]: entries } })
  },
}
