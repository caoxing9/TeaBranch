import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AppSettings, ConversationEntry, DevCategory, IssueRun, TeableConfig } from '@shared/types'
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
const toEpoch = (value: unknown): number =>
  typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) || Date.now() : Date.now()

export const defaultSettings: AppSettings = {
  basePort: 3001,
  defaultStartCommand: 'npm run dev',
  agentCommand: 'claude --dangerously-skip-permissions',
}

export const loadSettings = (): AppSettings => ({ ...defaultSettings, ...load<Partial<AppSettings>>(file('settings.json')) })
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
  autoNextBatch: false,
  branchPrefix: '',
  fixModel: { provider: 'claude' },
  reviewEngine: 'codex',
  reviewModel: { provider: 'claude' },
  codexModel: '',
  autoReview: true,
  sendReviewToAgent: true,
  maxReviewRounds: 2,
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
export const saveTranscript = (recordId: string, entries: ConversationEntry[]): void =>
  save(join(configDirectory, 'transcripts', `${recordId}.json`), entries)
