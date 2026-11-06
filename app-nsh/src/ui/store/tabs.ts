import { pref, setPref } from '../prefs'
import { createStore } from './base'
import { issues } from './issues'

/**
 * Open chat tabs, grouped by issue: the tab bar shows the selected issue's own conversation and
 * the chats opened under it; with no issue selected, the free-standing chats. Which chats are open
 * (and their order) is a per-viewer convenience, so it lives in the preferences.
 */
const KEY = 'teabranch.issueTabs'

const load = (): string[] => {
  const ids = pref<unknown>(KEY, [])
  // Older versions kept issue tabs here too; issues are groups now, not tabs.
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.startsWith('chat:')) : []
}
const save = (ids: string[]): void => setPref(KEY, ids)

/** Tab ids: an issue's record id for its own conversation, `chat:<id>` for a chat. */
export const chatTab = (chatId: string): string => `chat:${chatId}`
export const chatIdOf = (tab: string): string | null => (tab.startsWith('chat:') ? tab.slice(5) : null)

/** The issue whose tabs are showing, or null for the free-standing chats. */
export const currentGroup = (selection: Set<string>): string | null => (selection.size === 1 ? [...selection][0] : null)

interface TabsState {
  /** Open chat tabs across every group, in display order. */
  ids: string[]
  /** The chat in front, or null for the group's issue conversation (or the empty state). */
  activeChat: string | null
  /** Per group, the chat that was in front when you left it. */
  lastChat: Record<string, string | null>
}

const fields = createStore<TabsState>({ ids: load(), activeChat: null, lastChat: {} })

export const tabs = {
  ...fields,

  openChat(chatId: string): void {
    const ids = fields.ids()
    const activeChat = fields.activeChat()
    const id = chatTab(chatId)
    if (!ids.includes(id)) {
      // Right of the tab in front, like a browser.
      const at = activeChat ? ids.indexOf(chatTab(activeChat)) : -1
      const next = at < 0 ? [...ids, id] : [...ids.slice(0, at + 1), id, ...ids.slice(at + 1)]
      fields.set({ ids: next })
      save(next)
    }
    fields.set({ activeChat: chatId })
  },

  activate(tab: string | undefined): void {
    fields.set({ activeChat: tab ? chatIdOf(tab) : null })
  },

  /** Close a chat tab; `fallback` is the tab to bring forward when it was in front. */
  close(id: string, fallback?: string): void {
    const next = fields.ids().filter((tab) => tab !== id)
    fields.set({ ids: next })
    save(next)
    if (fields.activeChat() === chatIdOf(id)) tabs.activate(fallback)
  },

  closeOthers(id: string, group: string[]): void {
    const next = fields.ids().filter((tab) => tab === id || !group.includes(tab))
    fields.set({ ids: next })
    save(next)
    tabs.activate(id)
  },

  move(id: string, before: string | null): void {
    const rest = fields.ids().filter((tab) => tab !== id)
    const at = before ? rest.indexOf(before) : -1
    const next = at < 0 ? [...rest, id] : [...rest.slice(0, at), id, ...rest.slice(at)]
    fields.set({ ids: next })
    save(next)
  },
}

// Switching issue swaps the whole tab row; come back to whichever tab you left in front.
issues.onSelect((previous, next) => {
  const from = currentGroup(previous) ?? ''
  const to = currentGroup(next) ?? ''
  if (from === to) return
  const activeChat = fields.activeChat()
  const lastChat = fields.lastChat()
  const back = lastChat[to]
  fields.set({
    lastChat: { ...lastChat, [from]: activeChat },
    activeChat: back && fields.ids().includes(chatTab(back)) ? back : null,
  })
})

/** How your own messages sit in the transcript: MonoCode's full-width document blocks, or chat bubbles. */
export type Layout = 'document' | 'chat'
const LAYOUT_KEY = 'teabranch.transcriptLayout'

const layoutFields = createStore<{ layout: Layout }>({ layout: pref<string>(LAYOUT_KEY, 'document') === 'chat' ? 'chat' : 'document' })

export const transcriptLayout = {
  ...layoutFields,
  setLayout(layout: Layout): void {
    layoutFields.set({ layout })
    setPref(LAYOUT_KEY, layout)
  },
}
