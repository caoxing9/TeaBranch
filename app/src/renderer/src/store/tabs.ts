import { create } from 'zustand'
import { useIssues } from './issues'

/**
 * Open chat tabs, grouped by issue: the tab bar shows the selected issue's own conversation and
 * the chats opened under it; with no issue selected, the free-standing chats. Which chats are open
 * (and their order) is a per-viewer convenience, so it lives in localStorage.
 */

const KEY = 'teabranch.issueTabs'

const load = (): string[] => {
  try {
    const ids = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    // Older versions kept issue tabs here too; issues are groups now, not tabs.
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id.startsWith('chat:')) : []
  } catch {
    return []
  }
}

const save = (ids: string[]): void => {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids))
  } catch {
    // Storage blocked: tabs just won't survive a restart.
  }
}

/** Tab ids: an issue's record id for its own conversation, `chat:<id>` for a chat. */
export const chatTab = (chatId: string): string => `chat:${chatId}`
export const chatIdOf = (tab: string): string | null => (tab.startsWith('chat:') ? tab.slice(5) : null)

/** The issue whose tabs are showing, or null for the free-standing chats. */
export const currentGroup = (selection: Set<string>): string | null => (selection.size === 1 ? [...selection][0] : null)

interface TabsStore {
  /** Open chat tabs across every group, in display order. */
  ids: string[]
  /** The chat in front, or null for the group's issue conversation (or the empty state). */
  activeChat: string | null
  /** Per group, the chat that was in front when you left it. */
  lastChat: Record<string, string | null>
  openChat(chatId: string): void
  activate(tab: string | undefined): void
  /** Close a chat tab; `fallback` is the tab to bring forward when it was in front. */
  close(id: string, fallback?: string): void
  closeOthers(id: string, group: string[]): void
  move(id: string, before: string | null): void
}

export const useTabs = create<TabsStore>((set, get) => ({
  ids: load(),
  activeChat: null,
  lastChat: {},

  openChat(chatId) {
    const { ids, activeChat } = get()
    const id = chatTab(chatId)
    if (!ids.includes(id)) {
      // Right of the tab in front, like a browser.
      const at = activeChat ? ids.indexOf(chatTab(activeChat)) : -1
      const next = at < 0 ? [...ids, id] : [...ids.slice(0, at + 1), id, ...ids.slice(at + 1)]
      set({ ids: next })
      save(next)
    }
    set({ activeChat: chatId })
  },

  activate(tab) {
    set({ activeChat: tab ? chatIdOf(tab) : null })
  },

  close(id, fallback) {
    const next = get().ids.filter((tab) => tab !== id)
    set({ ids: next })
    save(next)
    if (get().activeChat === chatIdOf(id)) get().activate(fallback)
  },

  closeOthers(id, group) {
    const next = get().ids.filter((tab) => tab === id || !group.includes(tab))
    set({ ids: next })
    save(next)
    get().activate(id)
  },

  move(id, before) {
    const rest = get().ids.filter((tab) => tab !== id)
    const at = before ? rest.indexOf(before) : -1
    const next = at < 0 ? [...rest, id] : [...rest.slice(0, at), id, ...rest.slice(at)]
    set({ ids: next })
    save(next)
  },
}))

// Switching issue swaps the whole tab row; come back to whichever tab you left in front.
useIssues.subscribe((state, previous) => {
  if (state.selection === previous.selection) return
  const from = currentGroup(previous.selection) ?? ''
  const to = currentGroup(state.selection) ?? ''
  if (from === to) return
  const { activeChat, lastChat, ids } = useTabs.getState()
  const back = lastChat[to]
  useTabs.setState({
    lastChat: { ...lastChat, [from]: activeChat },
    activeChat: back && ids.includes(chatTab(back)) ? back : null,
  })
})

/** How your own messages sit in the transcript: MonoCode's full-width document blocks, or chat bubbles. */
type Layout = 'document' | 'chat'
const LAYOUT_KEY = 'teabranch.transcriptLayout'

export const useTranscriptLayout = create<{ layout: Layout; setLayout(layout: Layout): void }>((set) => ({
  layout: (() => {
    try {
      return localStorage.getItem(LAYOUT_KEY) === 'chat' ? 'chat' : 'document'
    } catch {
      return 'document'
    }
  })(),
  setLayout(layout) {
    set({ layout })
    try {
      localStorage.setItem(LAYOUT_KEY, layout)
    } catch {
      // Not persisted; fine for this window.
    }
  },
}))
