import type { IssueRun, SourceStatus } from '@shared/types'
import { t } from '@shared/i18n'
import { errorMessage, log } from '../../core/log'
import { run } from '../../core/shell'
import { truncate } from '../agentRunner'
import * as hub from '../autopilotHub'
import { ingest } from '../bus'
import { issueAgent, OWN_COMMENT } from '../issueAgent'
import type { Source } from './source'

/**
 * GitHub as a source: new comments and reviews on the PRs autopilot's tasks opened. Its fast path:
 * nothing TeaBranch or its agents wrote, nothing from bots. A PR is its task's own thread, so what
 * passes goes straight to that task's agent.
 */

let timer: NodeJS.Timeout | null = null
let running = false
let watched = 0
let lastError: string | undefined
let lastEventAt: number | undefined

export const githubSource: Source = {
  id: 'github',
  async start() {
    running = true
    schedule(15_000)
  },
  stop() {
    running = false
    if (timer) clearTimeout(timer)
    timer = null
  },
  status(): SourceStatus {
    return {
      id: 'github',
      state: lastError ? 'error' : 'online',
      detail: t('{n} 个打开的 PR', { n: watched }),
      error: lastError,
      lastEventAt,
    }
  },
}

function schedule(delayMs: number): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void poll(), delayMs)
}

async function poll(): Promise<void> {
  timer = null
  if (!running) return
  const open = Object.values(issueAgent.allRuns()).filter((current) => current.prURL && (!current.ci || current.ci.state === 'OPEN'))
  watched = open.length
  lastError = undefined
  for (const current of open) {
    await prComments(current).catch((error) => {
      lastError = errorMessage(error)
      log.warn(`pr comments ${current.prURL}: ${lastError}`)
    })
  }
  if (running) schedule(120_000)
}

interface Comment {
  author?: { login?: string }
  body?: string
  createdAt?: string
  submittedAt?: string
  state?: string
  path?: string
}

async function prComments(current: IssueRun): Promise<void> {
  const prURL = current.prURL as string
  const view = await run('gh', ['pr', 'view', prURL, '--json', 'comments,reviews'], { timeoutMs: 30_000 })
  if (!view.ok) throw new Error(view.stderr || 'gh pr view failed')
  const data = JSON.parse(view.out) as { comments?: Comment[]; reviews?: Comment[] }
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(prURL)
  let inline: Comment[] = []
  if (match) {
    const api = await run('gh', ['api', `repos/${match[1]}/${match[2]}/pulls/${match[3]}/comments`, '--paginate'], {
      timeoutMs: 30_000,
    })
    if (api.ok) {
      const raw = JSON.parse(api.out) as { user?: { login?: string }; body?: string; created_at?: string; path?: string; line?: number }[]
      inline = raw.map((comment) => ({
        author: { login: comment.user?.login },
        body: comment.body,
        createdAt: comment.created_at,
        path: comment.line ? `${comment.path}:${comment.line}` : comment.path,
      }))
    }
  }
  const all = [
    ...(data.comments ?? []).map((comment) => ({ ...comment, kind: 'comment' })),
    ...(data.reviews ?? []).map((review) => ({ ...review, createdAt: review.submittedAt, kind: `review (${review.state ?? ''})` })),
    ...inline.map((comment) => ({ ...comment, kind: 'review comment' })),
  ].filter((comment) => comment.createdAt)
  const newest = all.reduce((latest, comment) => (comment.createdAt! > latest ? comment.createdAt! : latest), '')
  // First look at this PR: what's there already was written before autopilot watched it.
  if (!current.seenCommentsAt) {
    if (newest) issueAgent.noteCommentsSeen(current.recordId, newest)
    return
  }
  const fresh = all
    .filter((comment) => comment.createdAt! > (current.seenCommentsAt as string))
    .filter((comment) => {
      const body = comment.body?.trim() ?? ''
      const login = comment.author?.login ?? ''
      return body && !body.includes(OWN_COMMENT) && !body.startsWith('### 🤖') && !login.endsWith('[bot]')
    })
    .sort((a, b) => a.createdAt!.localeCompare(b.createdAt!))
  if (newest) issueAgent.noteCommentsSeen(current.recordId, newest)
  if (!fresh.length) return

  lastEventAt = Date.now()
  const thread = hub.githubThread(prURL)
  hub.link(thread, current.recordId)
  const messages = fresh
    .map(
      (comment) =>
        `<message source="github" kind="${comment.kind}" from="${comment.author?.login ?? '?'}"${comment.path ? ` at="${comment.path}"` : ''}>\n${comment.body?.trim()}\n</message>`,
    )
    .join('\n\n')
  await ingest({
    source: 'github',
    thread,
    threadTitle: `PR ${current.issueKey}`,
    author: fresh.map((comment) => comment.author?.login).join(', '),
    text: fresh.map((comment) => `${comment.author?.login}: ${truncate(comment.body?.trim() ?? '', 200)}`).join('\n'),
    agentText: `${messages}\n\nNew on the PR. Address what is actionable in this branch and push; if you disagree or something is unclear, say so — your answer is passed on.`,
    recordId: current.recordId,
  })
}
