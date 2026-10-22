import { create } from 'zustand'
import type { AppSettings, Branch, BranchUsage, DbMode, DevCategory, NgrokTunnel } from '@shared/types'
import { isLive } from '@shared/types'
import { api, messageOf, on } from '@/lib/api'

export type Section = 'branches' | 'issues'
export type Theme = 'system' | 'light' | 'dark'
export type SortKey = 'name' | 'status' | 'category'

const statusRank = { running: 0, building: 1, error: 2, stopped: 3 }
const categoryRank: Record<DevCategory, number> = { developing: 0, todo: 1, done: 2 }

const stored = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
const store = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage unavailable: the preference just won't survive a relaunch.
  }
}

interface AppStore {
  ready: boolean
  settings: AppSettings | null
  section: Section
  branches: Branch[]
  categories: Record<string, DevCategory>
  selectedBranch: string | null
  search: string
  sortKey: SortKey
  sortAscending: boolean
  collapsedLanes: DevCategory[]
  busy: Set<string>
  usage: Record<string, BranchUsage>
  withTerminal: Set<string>
  ngrok: NgrokTunnel | null
  error: string | null
  theme: Theme
  showCreate: boolean
  showSettings: boolean
  pendingDelete: string | null
  /** Most recently started first — what the "running" ordering leans on. */
  recency: string[]
  /** Worktrees being created, by branch → the step it is on. Creation takes minutes; it runs in
   *  the background so nothing else has to wait behind a modal. */
  creating: Record<string, { step: string; message: string }>
  createWorktree(branch: string, dbMode: DbMode): void

  init(): Promise<void>
  refresh(): Promise<void>
  set(patch: Partial<AppStore>): void
  run(branch: string | null, work: () => Promise<unknown>): Promise<void>
  toggle(branch: Branch): Promise<void>
  restart(branch: string): Promise<void>
  remove(branch: string): Promise<void>
  setCategory(branch: string, category: DevCategory): Promise<void>
  toggleLane(lane: DevCategory): void
  chooseProject(): Promise<void>
  updateSettings(patch: Partial<AppSettings>): Promise<void>
  setTheme(theme: Theme): void
  refreshUsage(): Promise<void>
  refreshTerminals(): Promise<void>
}

export const useApp = create<AppStore>((set, get) => ({
  ready: false,
  settings: null,
  section: stored<Section>('teabranch.section', 'issues'),
  branches: [],
  categories: {},
  selectedBranch: null,
  search: '',
  sortKey: 'name',
  sortAscending: true,
  collapsedLanes: stored<DevCategory[]>('teabranch.collapsedLanes', []),
  busy: new Set(),
  usage: {},
  withTerminal: new Set(),
  ngrok: null,
  error: null,
  theme: stored<Theme>('teabranch.theme', 'system'),
  showCreate: false,
  showSettings: false,
  pendingDelete: null,
  recency: [],
  creating: {},

  createWorktree(branch, dbMode) {
    set({ creating: { ...get().creating, [branch]: { step: 'start', message: '准备中…' } }, selectedBranch: branch, section: 'branches' })
    const finish = () => {
      const creating = { ...get().creating }
      delete creating[branch]
      set({ creating })
    }
    api
      .createWorktree(branch, dbMode)
      .then(async () => {
        await get().refresh()
        await api.setCategory(branch, 'developing')
        await get().refresh()
      })
      .catch((error) => set({ error: `创建 ${branch} 失败：${messageOf(error)}` }))
      .finally(finish)
  },

  async init() {
    applyTheme(get().theme)
    const [settings, ngrok] = await Promise.all([api.getSettings(), api.ngrok()])
    set({ settings, ngrok, ready: true })
    on('branchesChanged', () => void get().refresh())
    on('ngrokChanged', (tunnel) => set({ ngrok: tunnel }))
    on('worktreeProgress', ({ branch, progress }) => {
      if (!get().creating[branch]) return
      set({ creating: { ...get().creating, [branch]: { step: progress.step, message: progress.message } } })
      // The branch exists in git once `worktree add` ran; show it in the list from then on.
      if (progress.step === 'env') void get().refresh()
    })
    on('menu', (action) => {
      if (action === 'newBranch') set({ section: 'branches', showCreate: true })
      if (action === 'settings') set({ showSettings: true })
      if (action === 'showBranches') get().set({ section: 'branches' })
      if (action === 'showIssues') get().set({ section: 'issues' })
    })
    await get().refresh()
    // Resource usage and terminal presence are polled, not pushed: both cost a subprocess.
    setInterval(() => void get().refreshUsage(), 3000)
    setInterval(() => void get().refreshTerminals(), 5000)
    void get().refreshTerminals()
  },

  async refresh() {
    if (!get().settings?.projectPath) return
    try {
      const [branches, categories] = await Promise.all([api.listBranches(), api.getCategories()])
      set({ branches, categories, error: null })
    } catch (error) {
      set({ branches: [], error: messageOf(error) })
    }
  },

  set(patch) {
    if (patch.section) store('teabranch.section', patch.section)
    set(patch)
  },

  async run(branch, work) {
    if (branch) set({ busy: new Set(get().busy).add(branch) })
    try {
      await work()
    } catch (error) {
      set({ error: messageOf(error) })
    } finally {
      if (branch) {
        const busy = new Set(get().busy)
        busy.delete(branch)
        set({ busy })
      }
      await get().refresh()
    }
  },

  async toggle(branch) {
    const live = isLive(branch.environment?.status ?? 'stopped')
    if (!live) set({ recency: [branch.name, ...get().recency.filter((name) => name !== branch.name)] })
    await get().run(branch.name, () => (live ? api.stopBranch(branch.name) : api.startBranch(branch.name)))
    void get().refreshUsage()
  },

  restart: (branch) => get().run(branch, () => api.restartBranch(branch)),

  async remove(branch) {
    await get().run(branch, () => api.deleteBranch(branch))
    if (get().selectedBranch === branch && !get().branches.some((b) => b.name === branch)) {
      set({ selectedBranch: null })
    }
  },

  async setCategory(branch, category) {
    set({ categories: { ...get().categories, [branch]: category } })
    await api.setCategory(branch, category)
  },

  toggleLane(lane) {
    const lanes = get().collapsedLanes
    const next = lanes.includes(lane) ? lanes.filter((l) => l !== lane) : [...lanes, lane]
    store('teabranch.collapsedLanes', next)
    set({ collapsedLanes: next })
  },

  async chooseProject() {
    try {
      const settings = await api.chooseProject()
      if (settings) {
        set({ settings, selectedBranch: null, error: null })
        await get().refresh()
      }
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async updateSettings(patch) {
    set({ settings: await api.updateSettings(patch) })
  },

  setTheme(theme) {
    store('teabranch.theme', theme)
    applyTheme(theme)
    set({ theme })
  },

  async refreshUsage() {
    if (!get().branches.some((branch) => isLive(statusOf(branch)))) {
      if (Object.keys(get().usage).length) set({ usage: {} })
      return
    }
    try {
      set({ usage: await api.usage() })
    } catch {
      // Sampling is best effort.
    }
  },

  async refreshTerminals() {
    try {
      set({ withTerminal: new Set(await api.branchesWithTerminal()) })
    } catch {
      // Best effort.
    }
  },
}))

const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

/** shadcn's dark mode is a `.dark` class on <html>; follow the system unless the user picked one. */
function applyTheme(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && systemDark.matches)
  document.documentElement.classList.toggle('dark', dark)
}

systemDark.addEventListener('change', () => applyTheme(useApp.getState().theme))

export const statusOf = (branch: Branch) => branch.environment?.status ?? 'stopped'

export const categoryOf = (categories: Record<string, DevCategory>, branch: string): DevCategory => categories[branch] ?? 'todo'

/** Search + sort. */
export function visibleBranches(state: Pick<AppStore, 'branches' | 'search' | 'sortKey' | 'sortAscending' | 'categories'>) {
  const query = state.search.trim().toLowerCase()
  const list = query ? state.branches.filter((branch) => branch.name.toLowerCase().includes(query)) : [...state.branches]
  const direction = state.sortAscending ? 1 : -1
  return list.sort((a, b) => {
    const byName = a.name.localeCompare(b.name, undefined, { numeric: true })
    if (state.sortKey === 'status') {
      const delta = statusRank[statusOf(a)] - statusRank[statusOf(b)]
      if (delta) return direction * delta
    } else if (state.sortKey === 'category') {
      const delta = categoryRank[categoryOf(state.categories, a.name)] - categoryRank[categoryOf(state.categories, b.name)]
      if (delta) return direction * delta
    } else {
      return direction * byName
    }
    return byName
  })
}
