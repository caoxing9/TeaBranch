import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { t } from '@shared/i18n'
import {
  commentableLines,
  parsePR,
  parseReviewOutput,
  placeComments,
  type PRRef,
  type ReviewComment,
  type ReviewOutput,
  type ReviewVerdict,
} from '@shared/prReview'
import { agentModelLabel, type PRReviewJob } from '@shared/types'
import { state } from '../core/appState'
import { errorMessage, log } from '../core/log'
import { loadAutopilotConfig, loadTeableConfig } from '../core/settingsStore'
import { type CommandResult, git, run } from '../core/shell'
import { type Handle, type Outcome, runClaude, runCodexReview, truncate } from './agentRunner'
import * as hub from './autopilotHub'
import { OWN_COMMENT } from './issueAgent'
import { prReviewPrompt } from './prompts'
import { worktreeBase } from './worktree'

/**
 * A pull request someone sent in a chat, reviewed for you. Its head is checked out next to the
 * project's worktrees (or cloned, for another repository), the reviewer the issue pipeline uses
 * reads the diff, and the review goes on GitHub under your `gh` login — an approval when nothing
 * blocks and the settings allow it, inline comments where GitHub takes them. The verdict is then
 * reported where it was asked for.
 */

export interface ReviewRequest {
  url: string
  /** Where it was asked for: the verdict is reported there. */
  thread?: string
  /** What they asked to look at, in their words. */
  request?: string
  requester?: string
  /** The events it answers, for the activity feed. */
  causes?: string[]
}

const jobs = new Map<string, PRReviewJob>()
const handles = new Map<string, Handle>()
const listeners: ((job: PRReviewJob) => void)[] = []

/** Called when a review ends, done or failed. */
export const onFinished = (listener: (job: PRReviewJob) => void): void => void listeners.push(listener)

/** Every review asked for since launch, newest first. */
export const reviews = (): PRReviewJob[] => [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt)

const active = (job: PRReviewJob | undefined): job is PRReviewJob => !!job && job.phase !== 'done' && job.phase !== 'failed'

/** Start a review; the job is returned at once and runs on its own. The same PR is reviewed once at a time. */
export function start(request: ReviewRequest): PRReviewJob {
  if (!loadAutopilotConfig().prReview.enabled) throw new Error(t('PR review 已关闭，在托管的 GitHub 设置里打开'))
  const ref = parsePR(request.url)
  if (!ref) throw new Error(t('不是 GitHub PR 链接：{url}', { url: request.url }))
  const running = jobs.get(ref.url)
  if (active(running)) return running
  const config = loadTeableConfig()
  const model = config.reviewEngine === 'codex' ? config.codexModel || 'codex default' : agentModelLabel(config.reviewModel)
  const job: PRReviewJob = {
    id: `pr_${randomUUID().slice(0, 8)}`,
    url: ref.url,
    number: ref.number,
    title: '',
    author: '',
    phase: 'preparing',
    thread: request.thread,
    model,
    costUSD: 0,
    startedAt: Date.now(),
  }
  jobs.set(ref.url, job)
  void runJob(job, ref, request)
  return job
}

export function cancel(id: string): void {
  handles.get(id)?.cancel()
}

interface PRInfo {
  title: string
  body: string
  author: string
  base: string
  head: string
  sha: string
  state: string
  additions: number
  deletions: number
  changedFiles: number
}

interface Checkout {
  cwd: string
  cleanup(): Promise<void>
}

async function runJob(job: PRReviewJob, ref: PRRef, request: ReviewRequest): Promise<void> {
  let checkout: Checkout | undefined
  try {
    const info = await prInfo(ref)
    job.title = info.title
    job.author = info.author
    checkout = await checkoutPR(ref, info)
    job.phase = 'reviewing'
    const outcome = await review(job, ref, info, checkout.cwd, request)
    job.costUSD += outcome.costUSD
    if (outcome.cancelled) throw new Error(t('Review 已取消'))
    if (!outcome.finalText) throw new Error(outcome.diagnosis ?? t('Review 没有输出'))
    const output = parseReviewOutput(outcome.finalText)
    job.verdict = output.verdict
    job.summary = output.summary
    job.phase = 'posting'
    job.posted = await post(ref, info, output, job.model)
    job.phase = 'done'
  } catch (error) {
    job.phase = 'failed'
    job.error = errorMessage(error)
    log.warn(`pr review ${ref.url}: ${job.error}`)
  } finally {
    job.finishedAt = Date.now()
    handles.delete(job.id)
    if (checkout) await checkout.cleanup().catch((error) => log.warn(`pr review cleanup: ${errorMessage(error)}`))
  }
  await report(job, request)
  for (const listener of listeners) listener(job)
}

const must = async (command: Promise<CommandResult>, what: string): Promise<void> => {
  const result = await command
  if (!result.ok) throw new Error(`${what}: ${truncate(result.stderr || result.out, 300)}`)
}

async function prInfo(ref: PRRef): Promise<PRInfo> {
  const fields = 'title,body,author,baseRefName,headRefName,headRefOid,state,additions,deletions,changedFiles'
  const result = await run('gh', ['pr', 'view', ref.url, '--json', fields], { timeoutMs: 60_000 })
  if (!result.ok) throw new Error(t('读不到 PR：{error}', { error: truncate(result.stderr || result.out, 300) }))
  const data = JSON.parse(result.out) as {
    title?: string
    body?: string
    author?: { login?: string }
    baseRefName?: string
    headRefName?: string
    headRefOid?: string
    state?: string
    additions?: number
    deletions?: number
    changedFiles?: number
  }
  return {
    title: data.title ?? '',
    body: data.body ?? '',
    author: data.author?.login ?? '',
    base: data.baseRefName || 'main',
    head: data.headRefName ?? '',
    sha: data.headRefOid ?? '',
    state: data.state ?? '',
    additions: data.additions ?? 0,
    deletions: data.deletions ?? 0,
    changedFiles: data.changedFiles ?? 0,
  }
}

/** Whether the project's `origin` is the PR's repository. */
async function sameRepo(repo: string, ref: PRRef): Promise<boolean> {
  const remote = await git(['remote', 'get-url', 'origin'], repo)
  const match = /github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.out)
  return !!match && match[1].toLowerCase() === ref.owner.toLowerCase() && match[2].toLowerCase() === ref.repo.toLowerCase()
}

/**
 * The PR's head, checked out detached: a worktree beside the project's when the PR is on its repo
 * (never a branch, so the branch list doesn't show it), a partial clone otherwise.
 */
async function checkoutPR(ref: PRRef, info: PRInfo): Promise<Checkout> {
  const refName = `refs/teabranch/pr-${ref.number}`
  const fetch = (cwd: string): Promise<CommandResult> => git(['fetch', 'origin', `pull/${ref.number}/head:${refName}`, info.base], cwd)
  const repo = state.settings.projectPath
  if (repo && existsSync(repo) && (await sameRepo(repo, ref))) {
    const dir = join(worktreeBase(repo), `pr-${ref.number}`)
    // Left over from a review cut short.
    if (existsSync(dir)) await git(['worktree', 'remove', '--force', dir], repo)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    await git(['update-ref', '-d', refName], repo)
    await must(fetch(repo), 'git fetch')
    mkdirSync(worktreeBase(repo), { recursive: true })
    await must(git(['worktree', 'add', '--detach', dir, refName], repo), 'git worktree add')
    return {
      cwd: dir,
      cleanup: async () => {
        await git(['worktree', 'remove', '--force', dir], repo)
        await git(['update-ref', '-d', refName], repo)
      },
    }
  }
  const dir = join(tmpdir(), `teabranch-pr-${ref.owner}-${ref.repo}-${ref.number}-${randomUUID().slice(0, 8)}`)
  await must(
    run('gh', ['repo', 'clone', `${ref.owner}/${ref.repo}`, dir, '--', '--filter=blob:none', '--no-checkout'], { timeoutMs: 600_000 }),
    'gh repo clone',
  )
  await must(fetch(dir), 'git fetch')
  await must(git(['checkout', '--detach', refName], dir), 'git checkout')
  return { cwd: dir, cleanup: async () => rmSync(dir, { recursive: true, force: true }) }
}

/** The reviewer the issue pipeline uses, read-only, in a session of its own. */
function review(job: PRReviewJob, ref: PRRef, info: PRInfo, cwd: string, request: ReviewRequest): Promise<Outcome> {
  const config = loadTeableConfig()
  const prompt = prReviewPrompt({
    url: ref.url,
    number: ref.number,
    title: info.title,
    body: info.body,
    author: info.author,
    base: info.base,
    head: info.head,
    sha: info.sha,
    additions: info.additions,
    deletions: info.deletions,
    changedFiles: info.changedFiles,
    request: request.request,
    requester: request.requester,
    custom: config.prompts,
  })
  return new Promise((resolve) => {
    const onEntry = (line: { kind: string; text: string; isError?: boolean }): void => {
      if (line.isError) log.warn(`pr review ${ref.number}: ${truncate(line.text, 300)}`)
    }
    const handle =
      config.reviewEngine === 'codex'
        ? runCodexReview({ prompt, cwd, model: config.codexModel, onEntry, onExit: resolve })
        : runClaude({
            prompt,
            cwd,
            session: { kind: 'new', id: randomUUID() },
            model: config.reviewModel,
            baseCommand: state.settings.agentCommand,
            extraArgs: ['--disallowedTools', 'Edit,Write,NotebookEdit,MultiEdit'],
            channel: 'review',
            onEntry,
            onExit: resolve,
          })
    handles.set(job.id, handle)
  })
}

let viewer: string | undefined
/** Who `gh` is signed in as: the account the review goes out under. */
async function login(): Promise<string | undefined> {
  if (viewer) return viewer
  const result = await run('gh', ['api', 'user', '-q', '.login'], { timeoutMs: 30_000 })
  if (result.ok && result.out) viewer = result.out
  return viewer
}

function reviewBody(output: ReviewOutput, loose: ReviewComment[], model: string): string {
  const engine = loadTeableConfig().reviewEngine === 'codex' ? 'Codex CLI' : 'Claude Code'
  const extra = loose.length ? `\n\n${loose.map((comment) => `- \`${comment.path}:${comment.line}\` — ${comment.body}`).join('\n')}` : ''
  return `### 🤖 ${engine} review (${model})\n\n${output.body || output.summary}${extra}\n\n${OWN_COMMENT}`
}

async function submit(ref: PRRef, info: PRInfo, event: ReviewVerdict, body: string, comments: ReviewComment[]): Promise<CommandResult> {
  const file = join(tmpdir(), `teabranch-pr-review-${randomUUID()}.json`)
  const payload = {
    commit_id: info.sha || undefined,
    event,
    body,
    comments: comments.map((comment) => ({ path: comment.path, line: comment.line, side: 'RIGHT', body: comment.body })),
  }
  writeFileSync(file, JSON.stringify(payload))
  try {
    return await run('gh', ['api', '-X', 'POST', `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`, '--input', file], {
      timeoutMs: 60_000,
    })
  } finally {
    rmSync(file, { force: true })
  }
}

/** The review onto the PR, as what the settings allow; returns what went out. */
async function post(ref: PRRef, info: PRInfo, output: ReviewOutput, model: string): Promise<ReviewVerdict> {
  const allowed = loadAutopilotConfig().prReview
  const me = await login()
  let event: ReviewVerdict = output.verdict
  // GitHub refuses your approval of your own PR; the settings may keep approvals and change requests to you.
  if (event === 'APPROVE' && (!allowed.approve || (me && me.toLowerCase() === info.author.toLowerCase()))) event = 'COMMENT'
  if (event === 'CHANGES_REQUESTED' && !allowed.requestChanges) event = 'COMMENT'
  const diff = await run('gh', ['pr', 'diff', ref.url], { timeoutMs: 120_000 })
  const { inline, loose } = placeComments(output.comments, commentableLines(diff.ok ? diff.stdout : ''))
  let result = await submit(ref, info, event, reviewBody(output, loose, model), inline)
  if (!result.ok && inline.length) {
    // A line GitHub won't take after all: every finding goes in the body instead.
    result = await submit(ref, info, event, reviewBody(output, [...loose, ...inline], model), [])
  }
  if (!result.ok && event !== 'COMMENT') {
    event = 'COMMENT'
    result = await submit(ref, info, event, reviewBody(output, [...loose, ...inline], model), [])
  }
  if (!result.ok) throw new Error(t('发布 review 失败：{error}', { error: truncate(result.stderr || result.out, 300) }))
  return event
}

const postedLabel = (job: PRReviewJob): string =>
  job.posted === 'APPROVE'
    ? t('✅ 已 approve')
    : job.posted === 'CHANGES_REQUESTED'
      ? t('🔴 已 request changes')
      : job.verdict === 'CHANGES_REQUESTED'
        ? t('⚠️ 有问题，已评论（没有 request changes）')
        : t('💬 已评论')

/** The verdict, where it was asked for — the thread already holds the link. */
async function report(job: PRReviewJob, request: ReviewRequest): Promise<void> {
  if (!request.thread) return
  const text =
    job.phase === 'failed'
      ? t('PR #{n} review 失败：{error}', { n: job.number, error: job.error ?? '' })
      : `${postedLabel(job)} PR #${job.number}${job.summary ? `：${job.summary}` : ''}`
  const limit = Math.max(200, loadAutopilotConfig().chatReplyLimit * 3)
  await hub.reply(request.thread, truncate(text, limit), request.causes).catch((error) => log.warn(`pr review reply: ${errorMessage(error)}`))
}
