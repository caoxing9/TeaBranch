import { type ActivityItem, APP_THREAD, type AutopilotConfig, type AutopilotStatus } from '../../shared/types'
import { api, messageOf, on } from '../lib/api'
import { pref, setPref } from '../prefs'
import { app } from './app'
import { createStore } from './base'

/** Autopilot's pages, in the order the left rail lists them: overview, the sources, router, workers, the feed. */
export type AutopilotPage = 'overview' | 'teable' | 'feishu' | 'github' | 'router' | 'worker' | 'activity'

interface AutopilotState {
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
}

async function load(): Promise<Pick<AutopilotState, 'config' | 'status' | 'activity' | 'chat' | 'hasSecret'>> {
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

const fields = createStore<AutopilotState>({
  page: pref<AutopilotPage>(PAGE_KEY, 'overview'),
  config: null,
  status: null,
  activity: [],
  chat: [],
  hasSecret: false,
  error: null,
  focusKey: 0,
})

export const autopilot = {
  ...fields,

  async init(): Promise<void> {
    on('autopilotStatus', (status) => fields.set({ status }))
    // A new event, or one filled in later (the router's decision): replaced in place by id. The
    // chat takes what is on its thread, and what the router did in answer to something there.
    on('autopilotActivity', (item) => {
      const activity = fields.activity()
      const chat = fields.chat()
      const inChat = item.thread === APP_THREAD || (item.source === 'router' && !!item.causes?.some((id) => chat.some((c) => c.id === id)))
      fields.set({ activity: upsert(activity, item, 300), chat: inChat ? upsert(chat, item, 2000) : chat })
    })
    on('menu', (action) => {
      if (action === 'autopilot') void autopilot.show()
    })
    fields.set(await load())
  },

  /** Open autopilot, at `page` when given, with everything read fresh. */
  async show(page?: AutopilotPage): Promise<void> {
    app.go({ section: 'autopilot' })
    if (page) {
      fields.set({ page })
      setPref(PAGE_KEY, page)
    }
    fields.set(await load())
  },

  /** The home page, with the composer ready to type into. */
  async newProbe(): Promise<void> {
    await autopilot.show('overview')
    fields.set({ focusKey: Date.now() })
  },

  async update(patch: Partial<AutopilotConfig>): Promise<void> {
    try {
      fields.set({ config: await api.updateAutopilotConfig(patch), error: null })
    } catch (error) {
      fields.set({ error: messageOf(error) })
    }
  },

  async setSecret(secret: string): Promise<void> {
    try {
      await api.setFeishuSecret(secret)
      fields.set({ hasSecret: !!secret.trim(), error: null })
    } catch (error) {
      fields.set({ error: messageOf(error) })
    }
  },
}
