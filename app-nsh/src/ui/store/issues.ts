import type {
  ConversationEntry,
  Issue,
  IssueComment,
  IssueRun,
  Person,
  QueueState,
  TeableConfig,
  TeableField,
  TeableRecord,
  TeableUser,
} from '../../shared/types'
import { isActivePhase } from '../../shared/types'
import { assigneeGuess, mapping, toIssue } from '../../shared/issues'
import { api, messageOf, on } from '../lib/api'
import { pref, setPref } from '../prefs'
import { createStore } from './base'

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
let listening = false

export const newConditionId = (): string => Math.random().toString(36).slice(2, 10)

/** A condition with nothing to compare against yet doesn't filter — like Teable's half-built rows. */
export const isComplete = (condition: FilterCondition): boolean =>
  condition.operator === 'isEmpty' || condition.operator === 'isNotEmpty' || condition.value.some((value) => value.trim())

const loadIssueFilter = (): IssueFilterSet => {
  const saved = pref<IssueFilterSet | null>(FILTER_KEY, null)
  if (saved) return saved
  // The earlier field → accepted-values map becomes one "is" condition per field.
  const legacy = pref<Record<string, string[]>>('teabranch.issueFieldFilters', {})
  return {
    conjunction: 'and',
    conditions: Object.entries(legacy)
      .filter(([, values]) => values.length)
      .map(([field, value]) => ({ id: newConditionId(), field, operator: 'is' as const, value })),
  }
}

interface IssuesState {
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
  /** A device-flow sign-in waiting for approval in the browser. */
  deviceLogin: { userCode: string; verificationUri: string } | null
  /** One-click OAuth is available for the configured host. */
  oauthReady: boolean
}

const selectListeners: ((previous: Set<string>, next: Set<string>) => void)[] = []

const fields = createStore<IssuesState>({
  config: null,
  user: null,
  checkedSession: false,
  signingIn: false,
  loading: false,
  fields: [],
  records: [],
  issues: [],
  runs: {},
  queue: { running: [], waiting: [], paused: false, concurrency: 3 },
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
  deviceLogin: null,
  oauthReady: false,
})

export const issues = {
  ...fields,

  async init(): Promise<void> {
    const [config, runs, queue, oauthReady] = await Promise.all([api.teableConfig(), api.issueRuns(), api.queueState(), api.teableOAuthReady()])
    fields.set({ config, runs, queue, oauthReady })
    if (listening) return
    listening = true
    on('issueRunsChanged', async () => {
      const [runs, queue] = await Promise.all([api.issueRuns(), api.queueState()])
      fields.set({ runs, queue, issues: withProbes(fields.issues(), runs) })
    })
    // A probe was filed: follow it to its record, selection and conversation alike.
    on('issueRekeyed', ({ from, to }) => {
      const selection = fields.selection()
      const { [from]: moved, ...rest } = fields.transcripts()
      fields.set({
        selection: selection.has(from) ? new Set([...selection].map((id) => (id === from ? to : id))) : selection,
        transcripts: moved ? { ...rest, [to]: moved } : rest,
      })
      // The probe left the list; its record is in the table now — read it in.
      void issues.reload()
    })
    on('transcript', ({ recordId, entries }) => {
      const current = fields.transcripts()[recordId]
      // Only conversations someone has opened are kept in memory here.
      if (current) fields.set({ transcripts: { ...fields.transcripts(), [recordId]: [...current, ...entries] } })
    })
    on('teableSignedIn', async ({ error }) => {
      fields.set({ deviceLogin: null })
      if (error) {
        fields.set({ error })
        return
      }
      const user = await api.teableSession().catch(() => null)
      fields.set({ user, error: null })
      if (user) await issues.reload()
    })
    const user = await api.teableSession().catch(() => null)
    fields.set({ user, checkedSession: true })
    if (user) await issues.reload()
    // Auto mode re-reads the table every three minutes to pick up new issues.
    setInterval(() => {
      if (fields.config()?.autoFix && fields.user()) void issues.reload()
    }, 180_000)
  },

  async signIn(token: string, baseURL?: string): Promise<void> {
    fields.set({ signingIn: true, error: null })
    try {
      const user = await api.teableSignIn(token, baseURL)
      fields.set({ user, config: await api.teableConfig() })
      await issues.reload()
    } catch (error) {
      fields.set({ error: messageOf(error) })
    } finally {
      fields.set({ signingIn: false })
    }
  },

  async startDeviceLogin(): Promise<void> {
    fields.set({ error: null })
    try {
      const code = await api.teableDeviceStart()
      fields.set({ deviceLogin: { userCode: code.userCode, verificationUri: code.verificationUri } })
    } catch (error) {
      fields.set({ error: messageOf(error) })
    }
  },

  async cancelDeviceLogin(): Promise<void> {
    await api.teableDeviceCancel()
    fields.set({ deviceLogin: null })
  },

  async signOut(): Promise<void> {
    await api.teableSignOut()
    fields.set({ user: null, records: [], issues: [], fields: [], selection: new Set(), checked: new Set() })
  },

  async reload(): Promise<void> {
    if (fields.loading()) return
    fields.set({ loading: true })
    try {
      const { fields: tableFields, records } = await api.teableLoad()
      const config = fields.config() ?? (await api.teableConfig())
      const map = mapping(config, tableFields)
      const list = withProbes(
        records.map((record) => toIssue(record, map)),
        fields.runs(),
      )
      fields.set({ fields: tableFields, records, issues: list, error: null })
      // A token that can't read its own profile still says who it is: with "only mine" on, Teable
      // returned only records assigned to `Me`, so the one person on every assignee cell is you.
      const user = fields.user()
      if (user?.id === 'token' && config.onlyMine) {
        const me = inferMe(list, assigneeGuess(config, tableFields))
        if (me) fields.set({ user: { id: 'token', name: me.name, email: me.email, avatar: me.avatar } })
      }
      await api.restoreQueue(list)
      // Auto mode: queue untouched issues whose status says "fix me".
      if (config.autoFix && config.fixStatuses.length) {
        const runs = fields.runs()
        const wanted = list.filter((issue) => !runs[issue.id] && issue.status && config.fixStatuses.includes(issue.status))
        if (wanted.length) await api.enqueueFix(wanted)
      }
    } catch (error) {
      fields.set({ error: messageOf(error) })
    } finally {
      fields.set({ loading: false })
    }
  },

  async updateConfig(patch: Partial<TeableConfig>): Promise<void> {
    const before = fields.config()
    const config = await api.updateTeableConfig(patch)
    if (patch.baseURL !== undefined || patch.oauthClientId !== undefined) fields.set({ oauthReady: await api.teableOAuthReady() })
    const map = mapping(config, fields.fields())
    fields.set({
      config,
      issues: withProbes(
        fields.records().map((record) => toIssue(record, map)),
        fields.runs(),
      ),
    })
    const reloadKeys: (keyof TeableConfig)[] = ['baseURL', 'baseId', 'tableId', 'viewId', 'onlyMine', 'assigneeField']
    if (before && reloadKeys.some((key) => before[key] !== config[key]) && fields.user()) await issues.reload()
  },

  setChecked(ids: Set<string>): void {
    fields.set({ checked: ids })
  },

  select(ids: Set<string>): void {
    const previous = fields.selection()
    fields.set({ selection: ids })
    for (const listener of selectListeners) listener(previous, ids)
    if (ids.size === 1) void issues.loadTranscript([...ids][0])
  },

  /** Called with the selection before and after every `select`. */
  onSelect(listener: (previous: Set<string>, next: Set<string>) => void): void {
    selectListeners.push(listener)
  },

  async loadComments(recordId: string): Promise<void> {
    // A probe has no record in Teable yet, so no comments either.
    if (isProbe(recordId)) return
    try {
      const comments = await api.issueComments(recordId)
      fields.set({ comments: { ...fields.comments(), [recordId]: comments } })
    } catch {
      // Comments are context, not load-bearing.
    }
  },

  async loadTranscript(recordId: string): Promise<void> {
    if (fields.transcripts()[recordId]) return
    const entries = await api.transcript(recordId)
    fields.set({ transcripts: { ...fields.transcripts(), [recordId]: entries } })
  },

  async perform(work: () => Promise<unknown>): Promise<void> {
    try {
      await work()
    } catch (error) {
      fields.set({ error: messageOf(error) })
    }
  },

  setIssueFilter(issueFilter: IssueFilterSet): void {
    setPref(FILTER_KEY, issueFilter)
    fields.set({ issueFilter })
  },

  async loadMagpieModels(): Promise<void> {
    try {
      fields.set({ magpieModels: await api.magpieModels(), magpieError: null })
    } catch (error) {
      fields.set({ magpieError: messageOf(error) })
    }
  },
}

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
export function visibleIssues(state: Pick<IssuesState, 'issues' | 'search' | 'filter' | 'runs' | 'issueFilter'>): Issue[] {
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
export const fixable = (list: Issue[], runs: Record<string, IssueRun>): Issue[] =>
  list.filter((issue) => {
    const run = runs[issue.id]
    return !run || run.phase === 'failed' || run.phase === 'cancelled'
  })

/** The single person present in every issue's assignee cell, when there is exactly one. */
function inferMe(list: Issue[], assigneeField: string | undefined): Person | undefined {
  if (!assigneeField || list.length === 0) return undefined
  let common: Map<string, Person> | undefined
  for (const issue of list) {
    const people = issue.record.people?.[assigneeField] ?? []
    const here = new Map(people.map((person) => [person.name, person]))
    common = common ? new Map([...common].filter(([name]) => here.has(name))) : here
    if (common.size === 0) return undefined
  }
  return common?.size === 1 ? [...common.values()][0] : undefined
}

const isProbe = (id: string): boolean => id.startsWith('probe_')

/**
 * The table's issues, plus the probes — work started before anyone filed it, which the table doesn't
 * have yet. A probe that has been filed is in the table under its record, and drops out here.
 */
function withProbes(list: Issue[], runs: Record<string, IssueRun>): Issue[] {
  const probes = Object.values(runs)
    .filter((run) => run.probe)
    .map((run): Issue => {
      const title = run.probe?.title ?? run.title
      const body = run.probe?.body ?? ''
      return { id: run.recordId, key: run.issueKey, title, body, record: { id: run.recordId, fields: {} } }
    })
  return [...list.filter((issue) => !isProbe(issue.id)), ...probes]
}
