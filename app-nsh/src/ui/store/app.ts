import { setColorScheme } from 'nsh'
import { t } from '../../shared/i18n'
import type { AgentModel, AppSettings, Branch, BranchUsage, DbMode, DevCategory, ModelRules, ModelScene, NgrokTunnel } from '../../shared/types'
import { defaultModelRules, isLive } from '../../shared/types'
import { api, messageOf, on } from '../lib/api'
import { pref, setPref } from '../prefs'
import { createStore } from './base'

export type Section = 'branches' | 'issues' | 'queue' | 'autopilot' | 'settings'
/** The settings' pages, as the settings sidebar lists them. */
export type SettingsPage = 'appearance' | 'repo' | 'terminal' | 'models' | 'issueTeable' | 'issueFix' | 'issueReview' | 'issuePrompt'
export type Theme = 'system' | 'light' | 'dark'
export type SortKey = 'name' | 'status' | 'category'

const statusRank = { running: 0, building: 1, error: 2, stopped: 3 }
const categoryRank: Record<DevCategory, number> = { developing: 0, todo: 1, done: 2 }

interface AppState {
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
  pendingDelete: string | null
  /** The settings page open, or to open next. */
  settingsPage: SettingsPage
  /** Where you were before the settings: the gear takes you back there. */
  lastSection: Section
  /** Most recently started first — what the "running" ordering leans on. */
  recency: string[]
  /** Worktrees being created, by branch → the step it is on. Creation takes minutes; it runs in
   *  the background so nothing else has to wait behind a modal. */
  creating: Record<string, { step: string; message: string }>
  /** Bumped to build every view again (a language change). */
  epoch: number
}

const fields = createStore<AppState>({
  ready: false,
  settings: null,
  // The queue was a section of its own before it became autopilot's workers. The settings never
  // open at launch.
  section: ((section) => (section === 'queue' ? 'autopilot' : section === 'settings' ? 'issues' : section))(pref<Section>('teabranch.section', 'issues')),
  branches: [],
  categories: {},
  selectedBranch: null,
  search: '',
  sortKey: 'name',
  sortAscending: true,
  collapsedLanes: pref<DevCategory[]>('teabranch.collapsedLanes', []),
  busy: new Set(),
  usage: {},
  withTerminal: new Set(),
  ngrok: null,
  error: null,
  theme: pref<Theme>('teabranch.theme', 'system'),
  showCreate: false,
  pendingDelete: null,
  settingsPage: pref<SettingsPage>('teabranch.settingsPage', 'appearance'),
  lastSection: 'issues',
  recency: [],
  creating: {},
  epoch: 0,
})

let listening = false

/** The light or dark look: the system's unless the user picked one. */
function applyTheme(theme: Theme): void {
  setColorScheme(theme === 'system' ? 'system' : theme)
}

export const app = {
  ...fields,

  createWorktree(branch: string, dbMode: DbMode): void {
    fields.set({
      creating: { ...fields.creating(), [branch]: { step: 'start', message: t('准备中…') } },
      selectedBranch: branch,
      section: 'branches',
    })
    const finish = () => {
      const creating = { ...fields.creating() }
      delete creating[branch]
      fields.set({ creating })
    }
    api
      .createWorktree(branch, dbMode)
      .then(async () => {
        await app.refresh()
        await api.setCategory(branch, 'developing')
        await app.refresh()
      })
      .catch((error) => fields.set({ error: t('创建 {branch} 失败：{error}', { branch, error: messageOf(error) }) }))
      .finally(finish)
  },

  async init(): Promise<void> {
    applyTheme(fields.theme())
    const [settings, ngrok] = await Promise.all([api.getSettings(), api.ngrok()])
    fields.set({ settings, ngrok, ready: true })
    if (listening) return
    listening = true
    on('branchesChanged', () => void app.refresh())
    on('ngrokChanged', (tunnel) => fields.set({ ngrok: tunnel }))
    on('worktreeProgress', ({ branch, progress }) => {
      if (!fields.creating()[branch]) return
      fields.set({ creating: { ...fields.creating(), [branch]: { step: progress.step, message: progress.message } } })
      // The branch exists in git once `worktree add` ran; show it in the list from then on.
      if (progress.step === 'env') void app.refresh()
    })
    on('menu', (action) => {
      if (action === 'newBranch') fields.set({ section: 'branches', showCreate: true })
      if (action === 'settings') app.toggleSettings()
      if (action === 'showBranches') app.go({ section: 'branches' })
      if (action === 'showIssues') app.go({ section: 'issues' })
    })
    await app.refresh()
    // Resource usage and terminal presence are polled, not pushed: both cost a subprocess.
    setInterval(() => void app.refreshUsage(), 3000)
    setInterval(() => void app.refreshTerminals(), 5000)
    void app.refreshTerminals()
  },

  async refresh(): Promise<void> {
    if (!fields.settings()?.projectPath) return
    try {
      const [branches, categories] = await Promise.all([api.listBranches(), api.getCategories()])
      fields.set({ branches, categories, error: null })
    } catch (error) {
      fields.set({ branches: [], error: messageOf(error) })
    }
  },

  /** `set` that remembers the section. */
  go(patch: Partial<AppState>): void {
    if (patch.section && patch.section !== 'settings') setPref('teabranch.section', patch.section)
    fields.set(patch)
  },

  /** The settings, at `page` when given, else where they were left. */
  openSettings(page?: SettingsPage): void {
    const section = fields.section()
    if (page) {
      setPref('teabranch.settingsPage', page)
      fields.set({ settingsPage: page })
    }
    if (section !== 'settings') fields.set({ lastSection: section, section: 'settings' })
  },

  /** The gear and ⌘,: into the settings, or back out to where you were. */
  toggleSettings(): void {
    if (fields.section() === 'settings') app.go({ section: fields.lastSection() })
    else app.openSettings()
  },

  async run(branch: string | null, work: () => Promise<unknown>): Promise<void> {
    if (branch) fields.set({ busy: new Set(fields.busy()).add(branch) })
    try {
      await work()
    } catch (error) {
      fields.set({ error: messageOf(error) })
    } finally {
      if (branch) {
        const busy = new Set(fields.busy())
        busy.delete(branch)
        fields.set({ busy })
      }
      await app.refresh()
    }
  },

  async toggle(branch: Branch): Promise<void> {
    const live = isLive(branch.environment?.status ?? 'stopped')
    if (!live) fields.set({ recency: [branch.name, ...fields.recency().filter((name) => name !== branch.name)] })
    await app.run(branch.name, () => (live ? api.stopBranch(branch.name) : api.startBranch(branch.name)))
    void app.refreshUsage()
  },

  restart: (branch: string): Promise<void> => app.run(branch, () => api.restartBranch(branch)),

  async remove(branch: string): Promise<void> {
    await app.run(branch, () => api.deleteBranch(branch))
    if (fields.selectedBranch() === branch && !fields.branches().some((b) => b.name === branch)) {
      fields.set({ selectedBranch: null })
    }
  },

  async setCategory(branch: string, category: DevCategory): Promise<void> {
    fields.set({ categories: { ...fields.categories(), [branch]: category } })
    await api.setCategory(branch, category)
  },

  toggleLane(lane: DevCategory): void {
    const lanes = fields.collapsedLanes()
    const next = lanes.includes(lane) ? lanes.filter((l) => l !== lane) : [...lanes, lane]
    setPref('teabranch.collapsedLanes', next)
    fields.set({ collapsedLanes: next })
  },

  async chooseProject(): Promise<void> {
    try {
      const settings = await api.chooseProject()
      if (settings) {
        fields.set({ settings, selectedBranch: null, error: null })
        await app.refresh()
      }
    } catch (error) {
      fields.set({ error: messageOf(error) })
    }
  },

  async updateSettings(patch: Partial<AppSettings>): Promise<void> {
    fields.set({ settings: await api.updateSettings(patch) })
  },

  /** Which model each scene runs on: the rules in Settings. */
  modelRules: (): ModelRules => fields.settings()?.models ?? defaultModelRules,

  async setModelFallback(fallback: AgentModel): Promise<void> {
    await app.updateSettings({ models: { ...app.modelRules(), fallback } })
  },

  /** One scene's rule; null drops it, so the scene follows the fallback again. */
  async setModelRule(scene: ModelScene, model: AgentModel | null): Promise<void> {
    const rules = { ...app.modelRules().rules }
    if (model) rules[scene] = model
    else delete rules[scene]
    await app.updateSettings({ models: { ...app.modelRules(), rules } })
  },

  /** Builds every view again, in the language now set. */
  remountUi(): void {
    fields.set({ epoch: fields.epoch() + 1 })
  },

  setTheme(theme: Theme): void {
    setPref('teabranch.theme', theme)
    applyTheme(theme)
    fields.set({ theme })
  },

  async refreshUsage(): Promise<void> {
    if (!fields.branches().some((branch) => isLive(statusOf(branch)))) {
      if (Object.keys(fields.usage()).length) fields.set({ usage: {} })
      return
    }
    try {
      fields.set({ usage: await api.usage() })
    } catch {
      // Sampling is best effort.
    }
  },

  async refreshTerminals(): Promise<void> {
    try {
      fields.set({ withTerminal: new Set(await api.branchesWithTerminal()) })
    } catch {
      // Best effort.
    }
  },
}

export const statusOf = (branch: Branch) => branch.environment?.status ?? 'stopped'
export const categoryOf = (categories: Record<string, DevCategory>, branch: string): DevCategory => categories[branch] ?? 'todo'

/** Search + sort. */
export function visibleBranches(state: Pick<AppState, 'branches' | 'search' | 'sortKey' | 'sortAscending' | 'categories'>): Branch[] {
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
