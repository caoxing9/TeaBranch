import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from '../node/fs'
import { homedir } from '../node/os'
import { dirname, join } from 'path'
import type {
  ActivityItem,
  AgentModel,
  AppSettings,
  AutopilotConfig,
  Chat,
  ConversationEntry,
  DevCategory,
  IssueRun,
  ModelRules,
  TeableConfig,
} from '../shared/types'
import { defaultModelRules } from '../shared/types'
import { log } from './log'

/**
 * On-disk state, in the same directory the Swift and Tauri builds used, so an existing install
 * keeps its project, lanes, Teable mapping and issue history without re-onboarding.
 */
export const configDirectory = join(homedir(), 'Library/Application Support/com.teabranch.dev')

const file = (name: string): string => join(configDirectory, name)

function load<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** Atomic write: temp file + rename, so a crash mid-write never leaves half a JSON file. */
function save(path: string, value: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.tmp`
    writeFileSync(temp, JSON.stringify(value, null, 2))
    renameSync(temp, path)
  } catch (error) {
    log.warn(`failed to persist ${path}: ${String(error)}`)
  }
}

/** The Swift build wrote ISO-8601 dates; this one writes epoch milliseconds. Read either. */
const toEpoch = (value: unknown): number => (typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) || Date.now() : Date.now())

export const defaultSettings: AppSettings = {
  basePort: 3001,
  defaultStartCommand: 'npm run dev',
  agentCommand: 'claude --dangerously-skip-permissions',
}

export function loadSettings(): AppSettings {
  const saved = load<Partial<AppSettings>>(file('settings.json')) ?? {}
  const models: ModelRules = saved.models ? { ...defaultModelRules, ...saved.models, rules: { ...saved.models.rules } } : migratedModelRules()
  return { ...defaultSettings, ...saved, models }
}

/**
 * Before the rules, each config named its own model: the fix model in teable.json (also what
 * chats ran on), the review model beside it, the router's in autopilot.json. Read once into the
 * rules of a settings.json that has none yet, so an upgrade changes nothing.
 */
function migratedModelRules(): ModelRules {
  const teable = load<{ fixModel?: AgentModel; reviewModel?: AgentModel }>(file('teable.json'))
  const autopilot = load<{ routerModel?: AgentModel }>(file('autopilot.json'))
  const key = (model: AgentModel) => `${model.provider}:${model.model ?? ''}:${model.effort ?? ''}`
  const fallback = teable?.fixModel ?? defaultModelRules.fallback
  const rules: ModelRules['rules'] = { ...defaultModelRules.rules }
  if (autopilot?.routerModel) rules.router = autopilot.routerModel
  if (teable?.reviewModel && key(teable.reviewModel) !== key(fallback)) rules.review = teable.reviewModel
  return { fallback, rules }
}
export const saveSettings = (settings: AppSettings): void => save(file('settings.json'), settings)

export const loadCategories = (): Record<string, DevCategory> => load(file('categories.json')) ?? {}
export const saveCategories = (categories: Record<string, DevCategory>): void => save(file('categories.json'), categories)

export const defaultTeableConfig: TeableConfig = {
  baseURL: 'https://app.teable.ai',
  // No table until the user picks one: a download must not point at someone else's private table.
  baseId: '',
  tableId: '',
  viewId: undefined,
  onlyMine: true,
  fixStatuses: [],
  autoFix: false,
  batchSize: 3,
  branchPrefix: '',
  access: 'fullAccess',
  reviewEngine: 'codex',
  codexModel: '',
  autoReview: true,
  triage: true,
  sendReviewToAgent: true,
  maxReviewRounds: 2,
  autoFixCI: true,
  maxCIRounds: 2,
  magpieURL: 'http://127.0.0.1:3425',
  oauthClientId: undefined,
}

export const loadTeableConfig = (): TeableConfig => ({
  ...defaultTeableConfig,
  ...load<Partial<TeableConfig>>(file('teable.json')),
})
export const saveTeableConfig = (config: TeableConfig): void => save(file('teable.json'), config)

export function loadIssueRuns(): Record<string, IssueRun> {
  const raw = load<Record<string, IssueRun>>(file('issue-runs.json')) ?? {}
  for (const run of Object.values(raw)) {
    run.createdAt = toEpoch(run.createdAt)
    run.updatedAt = toEpoch(run.updatedAt)
    run.reviews = (run.reviews ?? []).map((review) => ({ ...review, at: toEpoch(review.at) }))
    run.costUSD ??= 0
  }
  return raw
}
export const saveIssueRuns = (runs: Record<string, IssueRun>): void => save(file('issue-runs.json'), runs)

export function loadTranscript(recordId: string): ConversationEntry[] {
  const raw = load<ConversationEntry[]>(join(configDirectory, 'transcripts', `${recordId}.json`)) ?? []
  return raw.map((entry) => ({ ...entry, channel: entry.channel ?? 'agent', at: toEpoch(entry.at) }))
}
export const saveTranscript = (recordId: string, entries: ConversationEntry[]): void => save(join(configDirectory, 'transcripts', `${recordId}.json`), entries)

// MARK: - Chats

export function loadChats(): Record<string, Chat> {
  return load<Record<string, Chat>>(join(configDirectory, 'chats.json')) ?? {}
}
export const saveChats = (chats: Record<string, Chat>): void => save(join(configDirectory, 'chats.json'), chats)

export function loadChatTranscript(chatId: string): ConversationEntry[] {
  return load<ConversationEntry[]>(join(configDirectory, 'chat-transcripts', `${chatId}.json`)) ?? []
}
export const saveChatTranscript = (chatId: string, entries: ConversationEntry[]): void =>
  save(join(configDirectory, 'chat-transcripts', `${chatId}.json`), entries)
export const deleteChatTranscript = (chatId: string): void => rmSync(join(configDirectory, 'chat-transcripts', `${chatId}.json`), { force: true })

// MARK: - Autopilot

export const defaultAutopilotConfig: AutopilotConfig = {
  enabled: false,
  feishuAppId: '',
  feishuDomain: 'feishu',
  feishuIdentity: 'bot',
  pollSeconds: 20,
  // Your private conversations stay private until you say otherwise.
  userDirectMode: 'ignore',
  notify: { accepted: true, pr: true, question: true, approved: false, failed: true },
  prReview: { enabled: true, approve: true, requestChanges: false },
  chatReplyLimit: 100,
  replyPrefix: '🤖 ',
  replyRules: '',
  candidatePolicy: '',
  teableNewIssues: 'router',
  teableReplies: true,
  teableDoneStatuses: [],
  teableCleanup: true,
  chats: {},
  // A chat the bot was added to is not a go-ahead to act in it.
  unknownChatMode: 'ignore',
  directMessages: true,
  allowedUsers: [],
  sources: { teable: true, feishu: true, github: true },
  stallMinutes: 20,
  maxRetries: 1,
  progressCheckMinutes: 15,
  pollMinutes: 3,
  keepAwake: true,
  openAtLogin: false,
}

export function loadAutopilotConfig(): AutopilotConfig {
  const saved = load<Partial<AutopilotConfig> & { watchGitHub?: boolean }>(file('autopilot.json'))
  // Nested: a switch added later still gets its default in a file saved before it. GitHub's own
  // switch was `watchGitHub` before every source had one.
  const sources = { ...defaultAutopilotConfig.sources, github: saved?.watchGitHub ?? true, ...saved?.sources }
  return {
    ...defaultAutopilotConfig,
    ...saved,
    notify: { ...defaultAutopilotConfig.notify, ...saved?.notify },
    prReview: { ...defaultAutopilotConfig.prReview, ...saved?.prReview },
    sources,
  }
}
export const saveAutopilotConfig = (config: AutopilotConfig): void => save(file('autopilot.json'), config)

/**
 * A conversation outside the app — a Feishu topic, a PR — and the issues answering in it. Events on a
 * thread go straight to those issues' agents; only a thread nobody holds goes to the router.
 */
export interface Thread {
  id: string
  title: string
  recordIds: string[]
  /** Feishu: the message replies go under, so they stay in the topic. */
  replyTo?: string
  /** When the router last said something here: answers to it come back without an @. */
  repliedAt?: number
  /** Feishu: answered as the app's bot — a direct message to it — whoever it speaks as elsewhere. */
  asBot?: boolean
  updatedAt: number
}

/** What outlives a relaunch: the router's session, and which issue holds which thread. */
export interface AutopilotState {
  routerSessionId?: string
  /** The session has had a turn, so the next one resumes it. */
  routerStarted?: boolean
  /** What the router wrote for its next session before the last one ended, and when. */
  routerMemory?: string
  routerMemoryAt?: number
  /** Each issue's status as last read, so the next read knows what's new and what changed. */
  teable?: Record<string, string>
  threads: Record<string, Thread>
}

export const loadAutopilotState = (): AutopilotState => ({ threads: {}, ...load<Partial<AutopilotState>>(file('autopilot-state.json')) })
export const saveAutopilotState = (value: AutopilotState): void => save(file('autopilot-state.json'), value)

export const loadActivity = (): ActivityItem[] => load<ActivityItem[]>(file('autopilot-activity.json')) ?? []
export const saveActivity = (items: ActivityItem[]): void => save(file('autopilot-activity.json'), items)
