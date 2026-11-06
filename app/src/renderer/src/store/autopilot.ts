import { create } from 'zustand'
import { type ActivityItem, APP_THREAD, type AutopilotConfig, type AutopilotStatus } from '@shared/types'
import { api, messageOf, on } from '@/lib/api'
import { useApp } from '@/store/app'

/** Autopilot's pages, in the order the left rail lists them: overview, the sources, router, workers, the feed. */
export type AutopilotPage = 'overview' | 'teable' | 'feishu' | 'github' | 'router' | 'worker' | 'activity'

interface AutopilotStore {
  page: AutopilotPage
  config: AutopilotConfig | null
  status: AutopilotStatus | null
  activity: ActivityItem[]
  /** Your chat with the router in the app: what you said, what it answered, what it did. */
  chat: ActivityItem[]
  hasSecret: boolean
  error: string | null
  /** Bumped to put the cursor in the home page's composer. */
  focusKey: number
  init(): Promise<void>
  /** Open autopilot, at `page` when given, with everything read fresh. */
  show(page?: AutopilotPage): Promise<void>
  /** The home page, with the composer ready to type into. */
  newProbe(): Promise<void>
  update(patch: Partial<AutopilotConfig>): Promise<void>
  setSecret(secret: string): Promise<void>
}

async function load(): Promise<Pick<AutopilotStore, 'config' | 'status' | 'activity' | 'chat' | 'hasSecret'>> {
  const [config, status, activity, chat, hasSecret] = await Promise.all([
    api.autopilotConfig(),
    api.autopilotStatus(),
    api.autopilotActivity(),
    api.routerChat(),
    api.hasFeishuSecret(),
  ])
  return { config, status, activity, chat, hasSecret }
}

/** A new or updated item into a list, by id; newest last. */
function upsert(list: ActivityItem[], item: ActivityItem, keep: number): ActivityItem[] {
  const index = list.findIndex((candidate) => candidate.id === item.id)
  if (index >= 0) return list.map((candidate, i) => (i === index ? item : candidate))
  return [...list, item].slice(-keep)
}

const PAGE_KEY = 'teabranch.autopilotPage'
const storedPage = (): AutopilotPage => {
  try {
    return (localStorage.getItem(PAGE_KEY) as AutopilotPage | null) ?? 'overview'
  } catch {
    return 'overview'
  }
}

export const useAutopilot = create<AutopilotStore>((set, get) => ({
  page: storedPage(),
  config: null,
  status: null,
  activity: [],
  chat: [],
  hasSecret: false,
  error: null,
  focusKey: 0,

  async init() {
    on('autopilotStatus', (status) => set({ status }))
    // A new event, or one filled in later (the router's decision): replaced in place by id. The
    // chat takes what is on its thread, and what the router did in answer to something there.
    on('autopilotActivity', (item) => {
      const { activity, chat } = get()
      const inChat = item.thread === APP_THREAD || (item.source === 'router' && !!item.causes?.some((id) => chat.some((c) => c.id === id)))
      set({ activity: upsert(activity, item, 300), chat: inChat ? upsert(chat, item, 2000) : chat })
    })
    on('menu', (action) => {
      if (action === 'autopilot') void get().show()
    })
    set(await load())
  },

  async show(page) {
    useApp.getState().set({ section: 'autopilot' })
    if (page) {
      set({ page })
      try {
        localStorage.setItem(PAGE_KEY, page)
      } catch {
        // Remembering the page is a convenience.
      }
    }
    set(await load())
  },

  async newProbe() {
    await get().show('overview')
    set({ focusKey: Date.now() })
  },

  async update(patch) {
    try {
      set({ config: await api.updateAutopilotConfig(patch), error: null })
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async setSecret(secret) {
    try {
      await api.setFeishuSecret(secret)
      set({ hasSecret: !!secret.trim(), error: null })
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },
}))
