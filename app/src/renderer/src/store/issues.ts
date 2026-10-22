import { create } from 'zustand'
import type {
  ConversationEntry,
  Issue,
  IssueComment,
  Person,
  IssueRun,
  QueueState,
  TeableConfig,
  TeableField,
  TeableRecord,
  TeableUser,
} from '@shared/types'
import { isActivePhase } from '@shared/types'
import { api, messageOf, on } from '@/lib/api'
import { assigneeGuess, mapping, toIssue } from '@/lib/issues'

export type IssueFilter = 'all' | 'active' | 'review' | 'untouched'

/** Teable-style view filter, applied to the loaded records client-side. */
export type FilterOperator = 'is' | 'isNot' | 'contains' | 'doesNotContain' | 'isEmpty' | 'isNotEmpty'

export interface FilterCondition {
  id: string
  field: string
  operator: FilterOperator
  /** Accepted choices for select fields; the text for `contains`. Unused by the empty checks. */
  value: string[]
}

export interface IssueFilterSet {
  conjunction: 'and' | 'or'
  conditions: FilterCondition[]
}

const FILTER_KEY = 'teabranch.issueFilter'

export const newConditionId = (): string => Math.random().toString(36).slice(2, 10)

/** A condition with nothing to compare against yet doesn't filter — like Teable's half-built rows. */
export const isComplete = (condition: FilterCondition): boolean =>
  condition.operator === 'isEmpty' || condition.operator === 'isNotEmpty' || condition.value.some((value) => value.trim())

const loadIssueFilter = (): IssueFilterSet => {
  try {
    const saved = localStorage.getItem(FILTER_KEY)
    if (saved) return JSON.parse(saved)
    // The earlier field → accepted-values map becomes one "is" condition per field.
    const legacy = JSON.parse(localStorage.getItem('teabranch.issueFieldFilters') ?? '{}') as Record<string, string[]>
    return {
      conjunction: 'and',
      conditions: Object.entries(legacy)
        .filter(([, values]) => values.length)
        .map(([field, value]) => ({ id: newConditionId(), field, operator: 'is' as const, value })),
    }
  } catch {
    return { conjunction: 'and', conditions: [] }
  }
}

interface IssuesStore {
  config: TeableConfig | null
  user: TeableUser | null
  checkedSession: boolean
  signingIn: boolean
  loading: boolean
  fields: TeableField[]
  records: TeableRecord[]
  issues: Issue[]
  runs: Record<string, IssueRun>
  queue: QueueState
  /** The issue open in the main pane — at most one. */
  selection: Set<string>
  /** Issues ticked for a batch fix. Independent of which one is open. */
  checked: Set<string>
  search: string
  filter: IssueFilter
  /** Field conditions over the loaded issues. Remembered across launches. */
  issueFilter: IssueFilterSet
  transcripts: Record<string, ConversationEntry[]>
  /** Comment threads of issues someone opened. */
  comments: Record<string, IssueComment[]>
  magpieModels: string[]
  magpieError: string | null
  error: string | null
  showSettings: boolean
  /** A device-flow sign-in waiting for approval in the browser. */
  deviceLogin: { userCode: string; verificationUri: string } | null
  /** One-click OAuth is available for the configured host. */
  oauthReady: boolean

  init(): Promise<void>
  startDeviceLogin(): Promise<void>
  cancelDeviceLogin(): Promise<void>
  signIn(token: string, baseURL?: string): Promise<void>
  signOut(): Promise<void>
  reload(): Promise<void>
  updateConfig(patch: Partial<TeableConfig>): Promise<void>
  select(ids: Set<string>): void
  setChecked(ids: Set<string>): void
  loadTranscript(recordId: string): Promise<void>
  loadComments(recordId: string): Promise<void>
  perform(work: () => Promise<unknown>): Promise<void>
  setIssueFilter(filter: IssueFilterSet): void
  loadMagpieModels(): Promise<void>
}

export const useIssues = create<IssuesStore>((set, get) => ({
  config: null,
  user: null,
  checkedSession: false,
  signingIn: false,
  loading: false,
  fields: [],
  records: [],
  issues: [],
  runs: {},
  queue: { batch: [], waiting: [], awaitingNextBatch: false, settled: 0 },
  selection: new Set(),
  checked: new Set(),
  search: '',
  filter: 'all',
  issueFilter: loadIssueFilter(),
  transcripts: {},
  comments: {},
  magpieModels: [],
  magpieError: null,
  error: null,
  showSettings: false,
  deviceLogin: null,
  oauthReady: false,

  async init() {
    const [config, runs, queue, oauthReady] = await Promise.all([
      api.teableConfig(),
      api.issueRuns(),
      api.queueState(),
      api.teableOAuthReady(),
    ])
    set({ config, runs, queue, oauthReady })

    on('issueRunsChanged', async () => {
      const [runs, queue] = await Promise.all([api.issueRuns(), api.queueState()])
      set({ runs, queue })
    })
    on('transcript', ({ recordId, entries }) => {
      const current = get().transcripts[recordId]
      // Only conversations someone has opened are kept in memory here.
      if (current) set({ transcripts: { ...get().transcripts, [recordId]: [...current, ...entries] } })
    })

    on('teableSignedIn', async ({ error }) => {
      set({ deviceLogin: null })
      if (error) {
        set({ error })
        return
      }
      const user = await api.teableSession().catch(() => null)
      set({ user, error: null })
      if (user) await get().reload()
    })

    const user = await api.teableSession().catch(() => null)
    set({ user, checkedSession: true })
    if (user) await get().reload()

    // Auto mode re-reads the table every three minutes to pick up new issues.
    setInterval(() => {
      if (get().config?.autoFix && get().user) void get().reload()
    }, 180_000)
  },

  async signIn(token, baseURL) {
    set({ signingIn: true, error: null })
    try {
      const user = await api.teableSignIn(token, baseURL)
      set({ user, config: await api.teableConfig() })
      await get().reload()
    } catch (error) {
      set({ error: messageOf(error) })
    } finally {
      set({ signingIn: false })
    }
  },

  async startDeviceLogin() {
    set({ error: null })
    try {
      const code = await api.teableDeviceStart()
      set({ deviceLogin: { userCode: code.userCode, verificationUri: code.verificationUri } })
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  async cancelDeviceLogin() {
    await api.teableDeviceCancel()
    set({ deviceLogin: null })
  },

  async signOut() {
    await api.teableSignOut()
    set({ user: null, records: [], issues: [], fields: [], selection: new Set(), checked: new Set() })
  },

  async reload() {
    if (get().loading) return
    set({ loading: true })
    try {
      const { fields, records } = await api.teableLoad()
      const config = get().config ?? (await api.teableConfig())
      const map = mapping(config, fields)
      const issues = records.map((record) => toIssue(record, map))
      set({ fields, records, issues, error: null })
      // A token that can't read its own profile still says who it is: with "only mine" on, Teable
      // returned only records assigned to `Me`, so the one person on every assignee cell is you.
      const user = get().user
      if (user?.id === 'token' && config.onlyMine) {
        const me = inferMe(issues, assigneeGuess(config, fields))
        if (me) set({ user: { id: 'token', name: me.name, email: me.email, avatar: me.avatar } })
      }
      await api.restoreQueue(issues)
      // Auto mode: queue untouched issues whose status says "fix me".
      if (config.autoFix && config.fixStatuses.length) {
        const runs = get().runs
        const wanted = issues.filter((issue) => !runs[issue.id] && issue.status && config.fixStatuses.includes(issue.status))
        if (wanted.length) await api.enqueueFix(wanted)
      }
    } catch (error) {
      set({ error: messageOf(error) })
    } finally {
      set({ loading: false })
    }
  },

  async updateConfig(patch) {
    const before = get().config
    const config = await api.updateTeableConfig(patch)
    if (patch.baseURL !== undefined || patch.oauthClientId !== undefined) set({ oauthReady: await api.teableOAuthReady() })
    const map = mapping(config, get().fields)
    set({ config, issues: get().records.map((record) => toIssue(record, map)) })
    const reloadKeys: (keyof TeableConfig)[] = ['baseURL', 'baseId', 'tableId', 'viewId', 'onlyMine', 'assigneeField']
    if (before && reloadKeys.some((key) => before[key] !== config[key]) && get().user) await get().reload()
    // Turning auto-next on while a batch waits for confirmation should not leave it waiting.
    if (config.autoNextBatch && !before?.autoNextBatch && get().queue.awaitingNextBatch) await api.startNextBatch()
  },

  setChecked(ids) {
    set({ checked: ids })
  },

  select(ids) {
    set({ selection: ids })
    if (ids.size === 1) void get().loadTranscript([...ids][0])
  },

  async loadComments(recordId) {
    try {
      const comments = await api.issueComments(recordId)
      set({ comments: { ...get().comments, [recordId]: comments } })
    } catch {
      // Comments are context, not load-bearing.
    }
  },

  async loadTranscript(recordId) {
    if (get().transcripts[recordId]) return
    const entries = await api.transcript(recordId)
    set({ transcripts: { ...get().transcripts, [recordId]: entries } })
  },

  async perform(work) {
    try {
      await work()
    } catch (error) {
      set({ error: messageOf(error) })
    }
  },

  setIssueFilter(issueFilter) {
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(issueFilter))
    } catch {
      // Not remembered this time; the filter still applies.
    }
    set({ issueFilter })
  },

  async loadMagpieModels() {
    try {
      set({ magpieModels: await api.magpieModels(), magpieError: null })
    } catch (error) {
      set({ magpieError: messageOf(error) })
    }
  },
}))

/** One condition against one issue. Cells are text-format; multi-select ones read "a, b". */
export function matchesCondition(issue: Issue, condition: FilterCondition): boolean {
  const cell = (issue.record.fields[condition.field] ?? '').trim()
  const values = cell ? cell.split(', ') : []
  const needle = (condition.value[0] ?? '').trim().toLowerCase()
  switch (condition.operator) {
    case 'isEmpty':
      return !cell
    case 'isNotEmpty':
      return !!cell
    case 'contains':
      return cell.toLowerCase().includes(needle)
    case 'doesNotContain':
      return !cell.toLowerCase().includes(needle)
    case 'is':
      return values.some((value) => condition.value.includes(value))
    case 'isNot':
      return !values.some((value) => condition.value.includes(value))
  }
}

export function matchesFilter(issue: Issue, filter: IssueFilterSet): boolean {
  const active = filter.conditions.filter(isComplete)
  if (!active.length) return true
  return filter.conjunction === 'and'
    ? active.every((condition) => matchesCondition(issue, condition))
    : active.some((condition) => matchesCondition(issue, condition))
}

/** Search, run-state tab and field filters, in list order. */
export function visibleIssues(state: Pick<IssuesStore, 'issues' | 'search' | 'filter' | 'runs' | 'issueFilter'>): Issue[] {
  const query = state.search.trim().toLowerCase()
  return state.issues.filter((issue) => {
    if (query && !issue.title.toLowerCase().includes(query) && !issue.key.toLowerCase().includes(query)) return false
    if (!matchesFilter(issue, state.issueFilter)) return false
    const run = state.runs[issue.id]
    switch (state.filter) {
      case 'active':
        return !!run && isActivePhase(run.phase)
      case 'review':
        return run?.phase === 'prOpen'
      case 'untouched':
        return !run
      default:
        return true
    }
  })
}

/** Selected issues a fix can still be queued for: never run, or last run failed / stopped. */
export const fixable = (issues: Issue[], runs: Record<string, IssueRun>): Issue[] =>
  issues.filter((issue) => {
    const run = runs[issue.id]
    return !run || run.phase === 'failed' || run.phase === 'cancelled'
  })

/** The single person present in every issue's assignee cell, when there is exactly one. */
function inferMe(issues: Issue[], assigneeField: string | undefined): Person | undefined {
  if (!assigneeField || issues.length === 0) return undefined
  let common: Map<string, Person> | undefined
  for (const issue of issues) {
    const people = issue.record.people?.[assigneeField] ?? []
    const here = new Map(people.map((person) => [person.name, person]))
    common = common ? new Map([...common].filter(([name]) => here.has(name))) : here
    if (common.size === 0) return undefined
  }
  return common?.size === 1 ? [...common.values()][0] : undefined
}
