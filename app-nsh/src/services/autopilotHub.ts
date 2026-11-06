import { randomUUID } from 'crypto'
import { rmSync, writeFileSync } from '../node/fs'
import { tmpdir } from '../node/os'
import { join } from 'path'
import { type ActivityItem, APP_THREAD } from '../shared/types'
import { emit } from '../core/events'
import { run } from '../core/shell'
import { loadAutopilotConfig, loadTeableConfig } from '../core/settingsStore'
import { loadActivity, loadAutopilotState, saveActivity, saveAutopilotState, type Thread } from '../core/settingsStore'
import * as teable from './teable'
import { accessToken } from './teableAuth'
import * as feishu from './feishu'
import { issueAgent, OWN_COMMENT } from './issueAgent'

/**
 * What autopilot's parts share: the threads (conversations outside the app) and which issues hold
 * them, the activity feed, and the one way anything gets said back to people.
 */

const store = loadAutopilotState()
let activity: ActivityItem[] = loadActivity()
let saveTimer: ReturnType<typeof setTimeout> | null = null

const persist = (): void => {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveAutopilotState(store)
    saveActivity(activity)
  }, 500)
}

export const flushHub = (): void => {
  saveAutopilotState(store)
  saveActivity(activity)
}

// MARK: Threads

export const feishuThread = (chatId: string, rootId: string): string => `feishu:${chatId}:${rootId}`
export const githubThread = (prURL: string): string => `gh:${prURL}`
export const threadKind = (id: string): 'feishu' | 'github' | 'teable' | 'app' | 'other' =>
  id.startsWith('feishu:')
    ? 'feishu'
    : id.startsWith('gh:')
      ? 'github'
      : id.startsWith('teable:')
        ? 'teable'
        : id.startsWith('app:')
          ? 'app'
          : 'other'

export const thread = (id: string): Thread | undefined => store.threads[id]
export const threadCount = (): number => Object.keys(store.threads).length

/** The thread, made when first seen; `replyTo` moves to the newest message so replies land under it. */
export function touchThread(id: string, title: string, replyTo?: string, asBot?: boolean): Thread {
  const existing = store.threads[id]
  const next: Thread = existing ?? { id, title, recordIds: [], updatedAt: Date.now() }
  if (replyTo) next.replyTo = replyTo
  if (asBot) next.asBot = true
  next.updatedAt = Date.now()
  store.threads[id] = next
  prune()
  persist()
  return next
}

/** Issues answering in the thread whose runs still exist. */
export function holders(id: string): string[] {
  const runs = issueAgent.allRuns()
  return (store.threads[id]?.recordIds ?? []).filter((recordId) => runs[recordId])
}

export function link(threadId: string, recordId: string): void {
  const entry = store.threads[threadId] ?? touchThread(threadId, threadId)
  if (!entry.recordIds.includes(recordId)) entry.recordIds.push(recordId)
  issueAgent.linkThread(recordId, threadId)
  persist()
}

// A filed probe answers in the same threads under its new id.
issueAgent.onRekey((from, to) => {
  for (const entry of Object.values(store.threads)) entry.recordIds = entry.recordIds.map((id) => (id === from ? to : id))
  for (const item of activity) if (item.recordId === from) item.recordId = to
  persist()
})

export function unlink(threadId: string, recordId: string): void {
  const entry = store.threads[threadId]
  if (entry) entry.recordIds = entry.recordIds.filter((id) => id !== recordId)
  issueAgent.unlinkThread(recordId, threadId)
  persist()
}

/** A thread quiet for a month that nothing holds is forgotten. */
function prune(): void {
  const cutoff = Date.now() - 30 * 86_400_000
  for (const [id, entry] of Object.entries(store.threads)) if (entry.updatedAt < cutoff && !holders(id).length) delete store.threads[id]
}

// MARK: Router session

export const routerSession = (): { id?: string; started?: boolean } => ({
  id: store.routerSessionId,
  started: store.routerStarted,
})

export function setRouterSession(id: string | undefined, started: boolean): void {
  store.routerSessionId = id
  store.routerStarted = started
  persist()
}

/** The router's notes to its next session: its memory across resets. */
export const routerMemory = (): string => store.routerMemory ?? ''
export const routerMemoryAt = (): number | undefined => store.routerMemoryAt
export function setRouterMemory(text: string): void {
  store.routerMemory = text
  store.routerMemoryAt = Date.now()
  persist()
}

// MARK: Teable

export const teableSnapshot = (): Record<string, string> => ({ ...store.teable })
export function saveTeableSnapshot(snapshot: Record<string, string>): void {
  store.teable = snapshot
  persist()
}

// MARK: Activity

export function record(item: Omit<ActivityItem, 'id' | 'at'> & { at?: number }): ActivityItem {
  const full: ActivityItem = { id: `a_${randomUUID().slice(0, 8)}`, at: Date.now(), ...item }
  activity.push(full)
  if (activity.length > 1000) activity = activity.slice(-1000)
  emit('autopilotActivity', full)
  persist()
  return full
}

/** Fill in what became of an event after it was logged: the router's decision, a late error. */
export function annotate(id: string, patch: Partial<Pick<ActivityItem, 'decision' | 'outcome' | 'detail'>>): void {
  const item = activity.find((candidate) => candidate.id === id)
  if (!item) return
  Object.assign(item, patch)
  emit('autopilotActivity', item)
  persist()
}

export const activityList = (): ActivityItem[] => activity
export const activityItem = (id: string): ActivityItem | undefined => activity.find((item) => item.id === id)
export const threadActivity = (threadId: string, limit = 15): ActivityItem[] =>
  activity.filter((item) => item.thread === threadId).slice(-limit)

/** The app's chat: what you said there, what the router answered, and what it did because of it. */
export function appThreadActivity(): ActivityItem[] {
  const mine = new Set(activity.filter((item) => item.thread === APP_THREAD).map((item) => item.id))
  return activity.filter((item) => item.thread === APP_THREAD || (item.source === 'router' && !!item.causes?.some((id) => mine.has(id))))
}

/** Local files that came with an event — a chat's screenshots — by activity id. */
const files = new Map<string, string[]>()
export const setEventFiles = (id: string, paths: string[]): void => {
  if (paths.length) files.set(id, paths)
}
export const eventFiles = (id: string): string[] => files.get(id) ?? activityItem(id)?.files ?? []

// MARK: Replies

/**
 * Say something in a thread, where it came from: under the newest message of a Feishu topic, on the
 * PR, in the issue's comments — or in the app's own chat, where the record below is the message.
 */
export async function reply(threadId: string, text: string, causes?: string[]): Promise<void> {
  const target = store.threads[threadId]
  const kind = threadKind(threadId)
  if (kind === 'app') {
    // Nothing to send: the activity item is what the window shows.
  } else if (kind === 'feishu') {
    const messageId = target?.replyTo ?? threadId.split(':')[2]
    if (!messageId) throw new Error(`no message to reply under in ${threadId}`)
    await feishu.reply(messageId, text, target?.asBot)
  } else if (kind === 'github') {
    const file = join(tmpdir(), `teabranch-reply-${randomUUID()}.md`)
    writeFileSync(file, `${text}\n\n${OWN_COMMENT}`)
    try {
      const result = await run('gh', ['pr', 'comment', threadId.slice(3), '--body-file', file], { timeoutMs: 60_000 })
      if (!result.ok) throw new Error(result.stderr || result.out)
    } finally {
      rmSync(file, { force: true })
    }
  } else if (kind === 'teable') {
    if (!loadAutopilotConfig().teableReplies) throw new Error('replies in Teable comments are turned off')
    const token = await accessToken()
    if (!token) throw new Error('not signed in to Teable')
    await teable.addComment(loadTeableConfig(), token, threadId.slice('teable:'.length), `🤖 ${text}`)
  } else {
    throw new Error(`can't reply in ${threadId}`)
  }
  if (target) target.repliedAt = Date.now()
  persist()
  record({ source: 'router', thread: threadId, text, outcome: 'replied', causes })
}
