import { type IssueRun, isActivePhase } from '../shared/types'
import { errorMessage, log } from '../core/log'
import { loadAutopilotConfig } from '../core/settingsStore'
import * as hub from './autopilotHub'
import * as feishu from './feishu'
import { issueAgent } from './issueAgent'
import { judgeProgress, type Verdict } from './progressJudge'
import * as router from './router'

/**
 * The control loop outside everything else, once a minute. A process that is alive isn't the same as
 * work moving: an agent can sit in a turn saying nothing, talk without getting anywhere, a connection
 * can give up, a run can fail on something passing. It nudges, restarts and retries — a bounded
 * number of times — then tells the people waiting, through the router, that a human is needed.
 */

let timer: ReturnType<typeof setTimeout> | null = null
let lastFeishuRetry = 0
let reconnect: () => Promise<void> = async () => undefined
/** Runs it already gave up on, so the people waiting hear it once. */
const reported = new Set<string>()
/** Progress checks: when each run was last read, bad verdicts in a row, and reads under way. */
const judged = new Map<string, number>()
const strikes = new Map<string, number>()
const judging = new Set<string>()

export function startWatchdog(changed: () => void, reconnectFeishu: () => Promise<void>): void {
  reconnect = reconnectFeishu
  if (timer) return
  timer = setInterval(() => {
    try {
      tick()
    } catch (error) {
      log.warn(`watchdog: ${errorMessage(error)}`)
    }
    changed()
  }, 60_000)
}

export function stopWatchdog(): void {
  if (timer) clearInterval(timer)
  timer = null
}

function tick(): void {
  const config = loadAutopilotConfig()
  const now = Date.now()

  // The SDK reconnects by itself; once it has given up, start it over — every five minutes at most.
  const connection = feishu.status().state
  if ((connection === 'failed' || feishu.connectionState() === 'failed') && now - lastFeishuRetry > 300_000) {
    lastFeishuRetry = now
    hub.record({ source: 'watchdog', text: 'Feishu connection failed; reconnecting', outcome: 'action' })
    void reconnect()
  }

  const stall = Math.max(5, config.stallMinutes) * 60_000
  for (const run of Object.values(issueAgent.allRuns())) {
    const id = run.recordId
    const quietFor = now - issueAgent.lastActivity(id)

    // Mid-turn and silent too long, with nothing in the background to wait on.
    if (issueAgent.isTalking(id) && !run.background?.length && quietFor > stall) {
      if (!run.nudgedAt || run.nudgedAt < issueAgent.lastActivity(id)) {
        if (
          issueAgent.nudge(
            id,
            'TeaBranch watchdog: nothing has been heard from you for a while. If you are stuck, say what blocks you and stop; otherwise carry on and report progress.',
          )
        )
          hub.record({
            source: 'watchdog',
            text: `${run.issueKey}: quiet ${Math.round(quietFor / 60_000)} min, nudged`,
            outcome: 'action',
            recordId: id,
          })
      } else if (now - run.nudgedAt > stall) {
        if ((run.retries ?? 0) < config.maxRetries) {
          hub.record({
            source: 'watchdog',
            text: `${run.issueKey}: still stalled after a nudge, restarting the step`,
            outcome: 'action',
            recordId: id,
          })
          issueAgent.restart(id, `${Math.round(quietFor / 60_000)} min`)
        } else giveUp(run.recordId, 'stalled')
      }
      continue
    }

    // Talking, but getting anywhere? Past the grace period a model reads its last steps, now and then.
    const check = Math.max(0, config.progressCheckMinutes) * 60_000
    if (check && issueAgent.isTalking(id) && !run.background?.length && !judging.has(id)) {
      const since = judged.get(id) ?? run.phaseAt ?? run.updatedAt
      if (now - since >= check) {
        judged.set(id, now)
        judging.add(id)
        void checkProgress(run, config.maxRetries).finally(() => judging.delete(id))
      }
    } else if (!issueAgent.isTalking(id)) {
      judged.delete(id)
      strikes.delete(id)
    }

    // A recent failure is worth one more try — after a pause, so whatever was passing has passed.
    // One from before autopilot was watching is left as it is.
    if (run.phase === 'failed' && now - run.updatedAt > 120_000 && now - run.updatedAt < 2 * 3_600_000) {
      if ((run.retries ?? 0) < config.maxRetries && issueAgent.issue(id)) {
        hub.record({
          source: 'watchdog',
          text: `${run.issueKey}: failed (${run.lastError ?? '?'}), retrying`,
          outcome: 'action',
          recordId: id,
        })
        issueAgent.retry(id, run.lastError ?? 'failed')
      } else giveUp(id, run.lastError ?? 'failed')
    }
    if (isActivePhase(run.phase)) reported.delete(id)
  }
}

/**
 * A model's reading of the agent's last steps. Off course once: a word of advice into its turn.
 * Still off course at the next look: the step starts over, or — out of retries — a human's turn.
 */
async function checkProgress(run: IssueRun, maxRetries: number): Promise<void> {
  const id = run.recordId
  let verdict: Verdict | undefined
  try {
    verdict = await judgeProgress(run, issueAgent.transcript(id))
  } catch (error) {
    log.warn(`progress check ${run.issueKey}: ${errorMessage(error)}`)
  }
  if (!verdict || !issueAgent.isTalking(id)) return
  if (verdict.progress === 'yes') {
    strikes.delete(id)
    return
  }
  const count = (strikes.get(id) ?? 0) + 1
  strikes.set(id, count)
  const what = verdict.progress === 'stuck' ? 'going in circles' : 'drifting from the task'
  const current = issueAgent.allRuns()[id]
  if (count === 1) {
    const nudged = issueAgent.nudge(id, `TeaBranch watchdog: you look like you are ${what} — ${verdict.reason} ${verdict.advice}`.trim())
    hub.record({
      source: 'watchdog',
      text: `${run.issueKey}: ${what} — ${verdict.reason}`,
      outcome: 'action',
      detail: nudged ? 'advised' : 'could not reach the agent',
      recordId: id,
    })
    return
  }
  strikes.delete(id)
  if ((current?.retries ?? 0) < maxRetries) {
    hub.record({
      source: 'watchdog',
      text: `${run.issueKey}: still ${what} after advice — ${verdict.reason}; restarting the step`,
      outcome: 'action',
      recordId: id,
    })
    issueAgent.restart(id, what)
  } else giveUp(id, `${what} (${verdict.reason})`)
}

/** Out of retries: a human's turn. The router tells whoever is waiting in the task's threads. */
function giveUp(recordId: string, why: string): void {
  const run = issueAgent.allRuns()[recordId]
  if (!run || reported.has(recordId)) return
  reported.add(recordId)
  const threads = (run.threads ?? []).filter((id) => hub.threadKind(id) === 'feishu' || hub.threadKind(id) === 'app')
  const text = `Task ${run.issueKey} "${run.title}" needs a human: ${why}. The watchdog retried ${run.retries ?? 0} time(s) and stopped.`
  const item = hub.record({
    source: 'watchdog',
    thread: threads[0],
    text,
    outcome: threads.length && !run.silent ? 'routed' : 'error',
    recordId,
  })
  if (threads.length && !run.silent && loadAutopilotConfig().notify.failed)
    router.push({ id: item.id, source: 'watchdog', thread: threads.join(' '), attrs: { task: run.issueKey }, text })
}
