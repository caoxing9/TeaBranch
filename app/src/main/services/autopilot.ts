import { app, Notification, powerSaveBlocker } from 'electron'
import type { AutopilotStatus, IssueRun } from '@shared/types'
import { APP_THREAD, triageLabel } from '@shared/types'
import { t } from '@shared/i18n'
import { emit } from '../core/events'
import { errorMessage, log } from '../core/log'
import { loadAutopilotConfig } from '../core/settingsStore'
import { truncate } from './agentRunner'
import * as hub from './autopilotHub'
import * as feishu from './feishu'
import { issueAgent } from './issueAgent'
import * as prReview from './prReview'
import * as router from './router'
import { feishuSource } from './sources/feishuSource'
import { githubSource } from './sources/githubSource'
import type { Source } from './sources/source'
import { teableSource } from './sources/teableSource'
import { startWatchdog, stopWatchdog } from './watchdog'

/**
 * Autopilot: TeaBranch working on its own, after DeepSeek's super-agent design.
 *
 * Sources (the issue table, Feishu, GitHub) watch their channels and filter in code; the bus sends
 * what passes straight to the agent holding its thread, or to the router; the router — one
 * long-lived session with no shell — decides, hands work to issue agents (the workers) and does all
 * the talking; a watchdog outside it all keeps it going. This file starts and stops the pieces, and
 * turns workers' progress into events for the router.
 */

const sources: Source[] = [teableSource, feishuSource, githubSource]

let running = false
let blocker: number | null = null
/** Sources running now: those switched on, while autopilot is. */
const started = new Set<Source['id']>()

export function status(): AutopilotStatus {
  const connection = feishu.status()
  const routing = router.routerStatus()
  return {
    enabled: running,
    feishu: connection.state,
    feishuError: connection.error,
    bot: connection.bot,
    router: routing.state,
    routerError: routing.error,
    pending: routing.pending,
    routerContext: routing.context,
    routerMemoryAt: routing.memoryAt,
    threads: hub.threadCount(),
    lastPollAt: teableSource.lastPollAt(),
    sources: sources.map((source) => (started.has(source.id) ? source.status() : { id: source.id, state: 'off' })),
  }
}

let statusTimer: NodeJS.Timeout | null = null
export const statusChanged = (): void => {
  statusTimer ??= setTimeout(() => {
    statusTimer = null
    emit('autopilotStatus', status())
  }, 100)
}
feishuSource.onChange(statusChanged)
// Sources poll on their own clocks; what they show is refreshed with them.
setInterval(() => running && statusChanged(), 15_000)

/** Start or stop to match the config; called at launch and after every config change. */
export async function apply(): Promise<void> {
  const config = loadAutopilotConfig()
  // Only when it changes: macOS refuses it from an unsigned build, every time it's asked.
  if (app.getLoginItemSettings().openAtLogin !== config.openAtLogin) {
    try {
      app.setLoginItemSettings({ openAtLogin: config.openAtLogin })
    } catch (error) {
      log.warn(`login item: ${errorMessage(error)}`)
    }
  }
  if (!config.enabled) return stop()
  if (blocker === null && config.keepAwake) blocker = powerSaveBlocker.start('prevent-app-suspension')
  if (blocker !== null && !config.keepAwake) {
    powerSaveBlocker.stop(blocker)
    blocker = null
  }
  if (!running) {
    running = true
    await router.startRouter(statusChanged)
    startWatchdog(statusChanged, reconnectFeishu)
    log.info('autopilot on')
  }
  await syncSources()
  statusChanged()
}

export function stop(): void {
  if (!running) return
  running = false
  for (const source of sources) source.stop()
  started.clear()
  router.stopRouter()
  stopWatchdog()
  if (blocker !== null) powerSaveBlocker.stop(blocker)
  blocker = null
  hub.flushHub()
  statusChanged()
  log.info('autopilot off')
}

/** Start the sources switched on, stop the ones switched off. */
async function syncSources(): Promise<void> {
  const enabled = loadAutopilotConfig().sources
  for (const source of sources) {
    if (enabled[source.id] && !started.has(source.id)) {
      started.add(source.id)
      await source.start()
      log.info(`source ${source.id} on`)
    } else if (!enabled[source.id] && started.has(source.id)) {
      started.delete(source.id)
      source.stop()
      log.info(`source ${source.id} off`)
    }
  }
}

export const reconnectFeishu = (): Promise<void> => feishuSource.reconnect()

// MARK: - The app's own chat

/** The router on its own, for the chat in the window — whether or not autopilot as a whole is on. */
export async function ensureRouter(): Promise<void> {
  if (router.routerStatus().state === 'off') await router.startRouter(statusChanged)
  statusChanged()
}

/**
 * You, in the app: an instruction or a question for the router, which answers in the same place.
 * `files` are what you attached, kept where the conversation can show them and a task can take them.
 */
export async function ask(text: string, files: string[]): Promise<void> {
  await ensureRouter()
  hub.touchThread(APP_THREAD, t('和 Router 的对话'))
  const item = hub.record({ source: 'me', thread: APP_THREAD, author: t('我'), text, outcome: 'routed', files })
  router.push({
    id: item.id,
    source: 'me',
    thread: APP_THREAD,
    attrs: { from: 'me', owner: 'yes', addressed: 'yes', images: files.length ? String(files.length) : '' },
    text,
  })
}

// MARK: - Worker reports

/** Settled somewhere people may want to hear about. */
function reportable(current: IssueRun, from: IssueRun['phase']): boolean {
  const { notify } = loadAutopilotConfig()
  const working = from === 'fixing' || from === 'triaging' || from === 'preparing'
  // A probe that found a bug was just filed and goes on to its fix: worth a word to whoever asked.
  if (from === 'triaging' && current.phase === 'fixing') return !!current.filedFrom && notify.accepted
  if (working && current.phase === 'prOpen') return notify.pr
  if (working && (current.phase === 'triaged' || current.phase === 'finished')) return notify.question
  if (working && current.phase === 'failed') return notify.failed
  // A review that approved is news; one that asked for changes goes back to the agent first.
  return notify.approved && from === 'reviewing' && current.phase === 'prOpen' && !!current.reviews.at(-1)?.approved
}

function onPhase(current: IssueRun, from: IssueRun['phase']): void {
  if (!running || !reportable(current, from)) return
  // Where people are waiting: a chat, the issue's own comments for one that came from the table, or
  // you in the app's chat.
  const threads = (current.threads ?? []).filter((id) => ['feishu', 'teable', 'app'].includes(hub.threadKind(id)))
  // Something you started yourself: a notification too, for when the window is closed.
  if ((current.probe || current.filedFrom) && threads.every((id) => hub.threadKind(id) === 'app')) notifyOwner(current)
  if (!threads.length) return
  // Silent tasks speak up only when they have a fix to show.
  if (current.silent && current.phase !== 'prOpen') {
    hub.record({
      source: 'worker',
      thread: threads[0],
      text: `${current.issueKey} ${current.phase} (silent)`,
      outcome: 'ignored',
      recordId: current.recordId,
    })
    return
  }
  const words = issueAgent
    .transcript(current.recordId)
    .filter((entry) => entry.kind === 'assistant' && entry.channel === 'agent')
    .at(-1)?.text
  const lines = [
    `Task ${current.issueKey} "${current.title}" is now ${current.phase} (was ${from}).`,
    current.prURL && `PR: ${current.prURL}`,
    current.triage && (current.phase === 'triaged' || current.filedFrom) && `Triage verdict: ${current.triage.verdict}`,
    current.filedFrom && `It started as a probe and is now filed as issue ${current.issueKey}.`,
    current.probe && current.phase === 'triaged' && 'It was a probe and stays unfiled: tell them what was found.',
    current.reviews.at(-1)?.approved && 'The reviewer approved it.',
    current.lastError && `Error: ${truncate(current.lastError, 300)}`,
    current.silent && 'Nobody asked for this one (silent): introduce it briefly — what was found and the PR.',
    words && `Agent's last message:\n${truncate(words, 1500)}`,
  ]
  const text = lines.filter(Boolean).join('\n')
  const item = hub.record({ source: 'worker', thread: threads[0], text, outcome: 'routed', recordId: current.recordId })
  router.push({ id: item.id, source: 'worker', thread: threads.join(' '), attrs: { task: current.issueKey, phase: current.phase }, text })
}

issueAgent.onPhaseChange(onPhase)

// A PR review someone asked for ended: on the feed, and a note for the router's next turn.
prReview.onFinished((job) => {
  const text =
    job.phase === 'failed'
      ? `PR #${job.number} review failed: ${job.error ?? ''}`
      : `PR #${job.number} "${job.title}" reviewed: ${job.verdict ?? ''}, posted as ${job.posted ?? ''}.${job.summary ? `\n${job.summary}` : ''}`
  const item = hub.record({
    source: 'worker',
    thread: job.thread,
    text,
    outcome: job.phase === 'failed' ? 'error' : 'action',
    detail: job.phase === 'failed' ? job.error : `review_pr ${job.posted ?? ''}`.trim(),
  })
  router.push({ id: item.id, source: 'worker', thread: job.thread, attrs: { pr: String(job.number), phase: job.phase }, text, fyi: true })
})

/** A probe's news, as a notification: what it found, or that it's being fixed. */
function notifyOwner(current: IssueRun): void {
  if (!Notification.isSupported()) return
  const verdict = current.triage ? triageLabel[current.triage.verdict] : ''
  const body =
    current.phase === 'prOpen'
      ? t('PR 已创建：{url}', { url: current.prURL ?? '' })
      : current.phase === 'fixing'
        ? t('确认是 bug，已提 {key}，开始修复', { key: current.issueKey })
        : current.phase === 'failed'
          ? (current.lastError ?? t('失败'))
          : verdict
  new Notification({ title: `${current.issueKey} ${current.title}`, body }).show()
}
