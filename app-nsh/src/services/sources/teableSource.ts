import type { Issue, SourceStatus } from '../../shared/types'
import { t } from '../../shared/i18n'
import { errorMessage, log } from '../../core/log'
import { loadAutopilotConfig, loadTeableConfig } from '../../core/settingsStore'
import { truncate } from '../agentRunner'
import * as hub from '../autopilotHub'
import { ingest } from '../bus'
import { issueAgent } from '../issueAgent'
import * as issueSource from '../issueSource'
import type { Source } from './source'

/**
 * The issue table as a source, read on a timer. A new issue, or one whose status changed, is an
 * event. Its fast path is the rule you already had: a status in "fix these" queues the fix in code.
 * A new issue no rule covers goes to the router to judge, if you let it.
 *
 * It also keeps the queue whole across launches: issues left queued rejoin, and runs a quit cut
 * short pick up again.
 */

let timer: ReturnType<typeof setTimeout> | null = null
let running = false
let firstPoll = true
let count = 0
let lastError: string | undefined
let lastPollAt: number | undefined
let lastEventAt: number | undefined

export const teableSource: Source & { lastPollAt(): number | undefined } = {
  id: 'teable',
  async start() {
    running = true
    firstPoll = true
    schedule(1000)
  },
  stop() {
    running = false
    if (timer) clearTimeout(timer)
    timer = null
  },
  lastPollAt: () => lastPollAt,
  status(): SourceStatus {
    if (!loadTeableConfig().tableId) return { id: 'teable', state: 'setup', error: t('还没有选 Issue 表') }
    if (!lastPollAt && !lastError) return { id: 'teable', state: 'connecting' }
    return {
      id: 'teable',
      state: lastError ? 'error' : 'online',
      detail: t('{n} 条 issue · 每 {m} 分钟', { n: count, m: loadAutopilotConfig().pollMinutes }),
      error: lastError,
      lastEventAt,
    }
  },
}

function schedule(delayMs: number): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void poll(), delayMs)
}

export const teableThread = (recordId: string): string => `teable:${recordId}`

/**
 * Done issues whose worktree was kept — a PR still open then, say — tried again each read, so one
 * merged later is cleaned up without its status changing again.
 */
function retryCleanup(issues: Issue[]): void {
  const autopilot = loadAutopilotConfig()
  if (!autopilot.teableCleanup) return
  const runs = issueAgent.allRuns()
  for (const issue of issues) {
    const run = runs[issue.id]
    if (!run?.cleanupHeld || !autopilot.teableDoneStatuses.includes(issue.status ?? '')) continue
    void issueAgent.cleanup(issue.id).catch((error) => log.warn(`cleanup ${issue.key}: ${errorMessage(error)}`))
  }
}

async function poll(): Promise<void> {
  timer = null
  if (!running) return
  try {
    const issues = await issueSource.loadIssues()
    count = issues.length
    issueAgent.remember(issues)
    issueAgent.restoreQueue(issues)
    if (firstPoll) issueAgent.resumeInterrupted()
    // A probe being filed has its record in the table a moment before its run exists: compare next
    // time, when the record reads as the run's.
    if (!issueAgent.isFiling()) await diff(issues)
    retryCleanup(issues)
    firstPoll = false
    lastError = undefined
    lastPollAt = Date.now()
  } catch (error) {
    lastError = errorMessage(error)
    log.warn(`teable poll: ${lastError}`)
  }
  if (running) schedule(Math.max(1, loadAutopilotConfig().pollMinutes) * 60_000)
}

/** What changed since the last read becomes events. The very first read only takes stock. */
async function diff(issues: Issue[]): Promise<void> {
  const seen = hub.teableSnapshot()
  const firstEver = !Object.keys(seen).length
  const config = loadTeableConfig()
  const autopilot = loadAutopilotConfig()
  const runs = issueAgent.allRuns()
  const fixes = (issue: Issue): boolean => config.autoFix && !!issue.status && config.fixStatuses.includes(issue.status)

  for (const issue of issues) {
    const before = seen[issue.id]
    const isNew = before === undefined
    const statusChanged = !isNew && before !== (issue.status ?? '')
    seen[issue.id] = issue.status ?? ''
    if (firstEver && !fixes(issue)) continue
    if (!isNew && !statusChanged) continue
    const thread = teableThread(issue.id)
    const title = `${issue.key} ${issue.title}`
    const run = runs[issue.id]

    // The rule you set: this status means "fix it" — no model needed to decide that.
    if (!run && fixes(issue)) {
      lastEventAt = Date.now()
      await ingest({
        source: 'teable',
        thread,
        threadTitle: title,
        text: t('{key} 状态为“{status}”', { key: issue.key, status: issue.status ?? '' }),
        recordId: issue.id,
        direct: {
          describe: t('按规则自动修复'),
          run: () => {
            issueAgent.enqueueFix(issue, { threads: [thread] })
            hub.link(thread, issue.id)
          },
        },
      })
      continue
    }
    // Done — completed, closed, a duplicate: its worktree and branch go, if nothing exists only there.
    if (run && statusChanged && autopilot.teableCleanup && autopilot.teableDoneStatuses.includes(issue.status ?? '')) {
      lastEventAt = Date.now()
      await ingest({
        source: 'teable',
        thread,
        threadTitle: title,
        text: t('{key} 状态改为“{status}”', { key: issue.key, status: issue.status ?? '' }),
        recordId: issue.id,
        direct: {
          describe: t('完成后清理'),
          run: () => void issueAgent.cleanup(issue.id).catch((error) => log.warn(`cleanup ${issue.key}: ${errorMessage(error)}`)),
        },
      })
      continue
    }
    // A task already running: its agent works from the issue as it was; the router hears of the change.
    if (run && statusChanged) {
      lastEventAt = Date.now()
      await ingest({
        source: 'teable',
        thread,
        threadTitle: title,
        text: t('{key} 状态改为“{status}”', { key: issue.key, status: issue.status ?? '' }),
        attrs: { task: issue.key },
        recordId: issue.id,
        fyi: true,
      })
      continue
    }
    if (!run && isNew && autopilot.teableNewIssues === 'router') {
      lastEventAt = Date.now()
      await ingest({
        source: 'teable',
        thread,
        threadTitle: title,
        text: `New issue ${issue.key}: ${issue.title}\nstatus: ${issue.status ?? '-'}\n${truncate(issue.body, 800)}`,
        attrs: { task: issue.key, status: issue.status ?? '', addressed: 'no' },
        recordId: issue.id,
      })
    }
  }
  hub.saveTeableSnapshot(seen)
}
