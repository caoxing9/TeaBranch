import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Notification } from 'electron'
import type {
  AgentAccess,
  AgentModel,
  ConversationEntry,
  DbMode,
  Issue,
  IssueRun,
  IssueShelf,
  PRAction,
  PRDetails,
  QueueState,
  QueuedMessage,
  ReviewRecord,
  TeableConfig,
  WorktreeProgress,
} from '@shared/types'
import { agentModelLabel, isActivePhase, triageLabel, triageVerdict } from '@shared/types'
import { agentMessage } from '@shared/attachments'
import { ciFailures, ciPending, parseChecks } from '@shared/ci'
import { t } from '@shared/i18n'
import { state } from '../core/appState'
import { emit, emitSoon } from '../core/events'
import { errorMessage, TeaBranchError } from '../core/log'
import { loadIssueRuns, loadTeableConfig, loadTranscript, saveIssueRuns, saveTranscript } from '../core/settingsStore'
import { git, run, shellQuote } from '../core/shell'
import {
  commandLine,
  entry,
  type Handle,
  modelEnvironment,
  type Outcome,
  runClaude,
  runCodexReview,
  sessionContextUsed,
  truncate,
  userEntry,
} from './agentRunner'
import { worktreeDbInfo } from './git'
import { withBranchLock } from './processManager'
import { contextDir, contextPrompt, prepareIssueContext, uploadsDir } from './issueContext'
import {
  fixAfterTriagePrompt,
  fixPrompt,
  type PromptTarget,
  reviewFeedbackPrompt,
  ciFixPrompt,
  resumePrompt,
  reviewPrompt,
  systemPrompt,
  triagePrompt,
} from './prompts'
import * as teable from './teable'
import { accessToken } from './teableAuth'
import * as worktrees from './worktree'

/**
 * The issue → worktree → agent → PR → review loop.
 *
 * Each issue owns one Claude Code session, created on its first fix and resumed by every message
 * after it — a follow-up typed in the app, review findings fed back, `claude --resume` in a
 * terminal — so the agent always has the whole story of the bug.
 *
 * The queue works like a download manager: up to N issues run at once, and whenever one settles
 * the next in line takes its place.
 *
 * Pausing stops a step's process but keeps the issue's place; resuming carries the same session
 * on from that step. Pausing the queue pauses every running issue and takes no new ones.
 */
class IssueAgent {
  private runs: Record<string, IssueRun> = {}
  private transcripts = new Map<string, ConversationEntry[]>()
  /** Live agent processes. At most one per issue: a session can't be resumed twice at once. */
  private handles = new Map<string, Handle>()
  /**
   * Agents whose turn is over but whose process lives on for the background tasks it started — dev
   * servers, a watch. The issue has settled; the next message goes into this process.
   */
  private resting = new Map<string, Handle>()
  /** What settles the agent's next turn: the step that started it, or a follow-up once it rested. */
  private finishing = new Map<string, (outcome: Outcome) => void>()
  private waiting: Issue[] = []
  /** Issues taken off the queue and not settled yet: the slots N counts. */
  private slots: string[] = []
  /** Settled out of a slot since the queue last ran dry, for the notification when it does. */
  private finished: string[] = []
  private paused = false
  /** The issues as last loaded, so a paused one can resume from just its id. */
  private known = new Map<string, Issue>()
  /** Pauses per issue: a pipeline that sees this change was paused under it, even if resumed since. */
  private pauses = new Map<string, number>()
  private ciTimer: NodeJS.Timeout | null = null
  /** Half-built worktrees to discard before a retry rebuilds, record id → branch. */
  private abandoned = new Map<string, string>()
  private dirty = new Set<string>()
  private flushTimer: NodeJS.Timeout | null = null
  private saveTimer: NodeJS.Timeout | null = null

  constructor() {
    this.runs = loadIssueRuns()
    // Anything mid-flight when the app last quit died with it. Queued issues never started, so
    // they stay queued and rejoin once the table loads (`restoreQueue`).
    for (const run of Object.values(this.runs)) {
      if (isActivePhase(run.phase) && run.phase !== 'queued') {
        run.phase = 'failed'
        run.lastError = t('TeaBranch 退出时它还在运行')
      }
      run.background = undefined
      if (!run.context) {
        const used = sessionContextUsed(run.sessionId)
        if (used) run.context = { used }
      }
    }
    this.watchCI()
  }

  // MARK: Reads

  allRuns = (): Record<string, IssueRun> => this.runs
  isRunning = (recordId: string): boolean => this.handles.has(recordId)
  /** A process alive, or a pipeline step about to start one. */
  private isBusy = (recordId: string): boolean => {
    const run = this.runs[recordId]
    return this.handles.has(recordId) || (!!run && isActivePhase(run.phase))
  }
  /** Agent and reviewer processes alive right now. */
  runningCount = (): number => this.handles.size

  transcript(recordId: string): ConversationEntry[] {
    let list = this.transcripts.get(recordId)
    if (!list) {
      list = loadTranscript(recordId)
      this.transcripts.set(recordId, list)
    }
    return list
  }

  queueState(): QueueState {
    return {
      running: [...this.slots],
      waiting: this.waiting.map((issue) => issue.id),
      paused: this.paused,
      concurrency: Math.max(1, loadTeableConfig().batchSize),
    }
  }

  // MARK: Entry points

  /** Queue a fix. An issue that already has a live or finished run is left alone. */
  enqueueFix(issue: Issue): void {
    const config = loadTeableConfig()
    const previous = this.runs[issue.id]
    if (previous && previous.phase !== 'failed' && previous.phase !== 'cancelled') return

    // A worktree that never finished setting up is rebuilt under the current naming; one that did
    // holds the agent's work and keeps its branch.
    let branch = branchName(issue, config.branchPrefix)
    if (previous?.worktreeReady) branch = previous.branch
    else if (previous) this.abandoned.set(issue.id, previous.branch)

    const now = Date.now()
    this.runs[issue.id] = {
      recordId: issue.id,
      issueKey: issue.key,
      title: issue.title,
      branch,
      // A retry keeps its session, so the agent remembers what it already tried.
      sessionId: previous?.sessionId ?? randomUUID(),
      phase: 'queued',
      worktreeReady: previous?.worktreeReady ? true : undefined,
      prURL: previous?.prURL,
      reviews: previous?.reviews ?? [],
      costUSD: previous?.costUSD ?? 0,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    this.known.set(issue.id, issue)
    this.waiting.push(issue)
    this.append(issue.id, entry('system', 'agent', t('已加入修复队列')))
    this.changed()
    this.fill()
  }

  /** Put issues left queued by a previous launch back in the queue, oldest first. */
  restoreQueue(issues: Issue[]): void {
    for (const issue of issues) this.known.set(issue.id, issue)
    const known = new Set([...this.waiting.map((issue) => issue.id), ...this.slots])
    const stale = issues
      .filter((issue) => this.runs[issue.id]?.phase === 'queued' && !known.has(issue.id))
      .sort((a, b) => (this.runs[a.id]?.createdAt ?? 0) - (this.runs[b.id]?.createdAt ?? 0))
    if (!stale.length) return
    this.waiting.push(...stale)
    // A relaunch is no go-ahead: what was left in the queue waits, paused, until you resume it.
    if (!this.slots.length) this.paused = true
    this.changed()
    this.fill()
  }

  /**
   * One issue you started yourself: it runs now, outside any batch — you are already looking at
   * it, so there's nothing to hold it for. Batches are for what you queue in bulk.
   */
  fixNow(issue: Issue): void {
    if (this.runs[issue.id]?.phase !== 'queued') this.enqueueFix(issue)
    const index = this.waiting.findIndex((candidate) => candidate.id === issue.id)
    // Already taken into a batch, or not in a state to fix.
    if (index < 0) return
    this.waiting.splice(index, 1)
    this.changed()
    void this.pipeline(issue, loadTeableConfig())
  }

  /** Send a message to the issue's own agent, resuming its session. */
  /** The check said it needn't be fixed; you've read why and want the fix anyway. */
  async fixAnyway(issue: Issue): Promise<void> {
    const run = this.runs[issue.id]
    if (!run) throw new TeaBranchError(t('这个 issue 还没有 agent 会话，先点“自动修复”。'))
    await this.send(issue, fixAfterTriagePrompt(promptTarget(issue, run.branch), true), [], t('验证结论我看过了，仍然按 bug 修复。'))
  }

  /**
   * From the composer: sent now when the issue is idle. While it works the message queues and goes
   * out once the issue settles — or, with `steer`, into the agent's running turn.
   */
  async say(issue: Issue, message: string, attachments: string[] = [], steer = false): Promise<void> {
    const run = this.runs[issue.id]
    if (!run) throw new TeaBranchError(t('这个 issue 还没有 agent 会话，先点“自动修复”。'))
    if (!this.isBusy(issue.id)) return this.send(issue, message, attachments)
    const queued: QueuedMessage = { id: randomUUID(), text: message, attachments }
    this.update(issue.id, (r) => {
      r.queued = [...(r.queued ?? []), queued]
    })
    if (steer) await this.steer(issue, queued.id)
  }

  /** A queued message, now: into the agent's running turn, or as the next turn when the issue is idle. */
  async steer(issue: Issue, queuedId: string): Promise<void> {
    const run = this.runs[issue.id]
    const queued = run?.queued?.find((candidate) => candidate.id === queuedId)
    if (!run || !queued) return
    if (!this.isBusy(issue.id)) {
      this.unqueue(issue.id, queuedId)
      return this.send(issue, queued.text, queued.attachments)
    }
    const handle = this.handles.get(issue.id)
    // Only the fixing agent takes messages: not a reviewer, not a worktree still being built.
    if (!handle || (run.phase !== 'triaging' && run.phase !== 'fixing'))
      throw new TeaBranchError(t('现在没有 agent 在对话，这条会在它结束后发出'))
    // Too late for this turn: it stays queued and goes out once the issue settles.
    if (!handle.steer?.(agentMessage(queued.text, queued.attachments))) return
    this.unqueue(issue.id, queuedId)
    this.append(issue.id, userEntry('agent', queued.text, queued.attachments))
  }

  unqueue(recordId: string, queuedId: string): void {
    this.update(recordId, (run) => {
      run.queued = run.queued?.filter((candidate) => candidate.id !== queuedId)
    })
  }

  /** `display` replaces the message in the transcript when the prompt itself is boilerplate. */
  async send(issue: Issue, message: string, attachments: string[] = [], display?: string): Promise<void> {
    const run = this.runs[issue.id]
    if (!run) throw new TeaBranchError(t('这个 issue 还没有 agent 会话，先点“自动修复”。'))
    if (this.isRunning(issue.id)) throw new TeaBranchError(t('Agent 正在运行，等它结束或先停止。'))
    const cwd = this.worktreePath(run)
    if (!cwd) throw new TeaBranchError(t('找不到 worktree：{branch}', { branch: run.branch }))
    const config = loadTeableConfig()
    this.append(issue.id, userEntry('agent', display ?? message, attachments))
    message = agentMessage(message, attachments)
    this.update(issue.id, (r) => {
      r.phase = 'fixing'
      r.lastError = undefined
    })
    this.startAgent(issue, message, cwd, config, (outcome) => this.agentFinished(issue, outcome, config))
  }

  async review(issue: Issue): Promise<void> {
    const run = this.runs[issue.id]
    if (!run) throw new TeaBranchError(t('还没有可以 review 的修复。'))
    if (this.isRunning(issue.id)) throw new TeaBranchError(t('Agent 正在运行，等它结束再 review。'))
    const cwd = this.worktreePath(run)
    if (!cwd) throw new TeaBranchError(t('找不到 worktree：{branch}', { branch: run.branch }))
    this.startReview(issue, run, cwd, loadTeableConfig())
  }

  /** Hand the latest review to the agent by hand — when auto-send is off or rounds ran out. */
  async sendLatestReview(issue: Issue): Promise<void> {
    const review = this.runs[issue.id]?.reviews.at(-1)
    if (!review) throw new TeaBranchError(t('还没有 review 结果。'))
    await this.send(issue, reviewFeedbackPrompt(promptTarget(issue, this.runs[issue.id].branch), review, engineLabel(review.engine)))
  }

  setShelf(recordId: string, shelf: IssueShelf | null): void {
    this.update(recordId, (run) => {
      run.shelf = shelf ?? undefined
    })
    // Filed as done: what it left running for you to try goes with it.
    if (shelf === 'done') this.stopBackground(recordId)
  }

  /** Stop one background task, or all of them; the session stays, and resumes on the next message. */
  stopBackground(recordId: string, taskId?: string): void {
    const handle = this.resting.get(recordId) ?? this.handles.get(recordId)
    const tasks = this.runs[recordId]?.background ?? []
    for (const task of tasks) if (!taskId || task.id === taskId) handle?.stopTask?.(task.id)
  }

  /** On quit: agents and whatever they left running in the background. */
  killAll(): void {
    for (const handle of [...this.handles.values(), ...this.resting.values()]) handle.cancel()
  }

  setAccess(recordId: string, access: AgentAccess | null): void {
    this.update(recordId, (run) => {
      run.access = access ?? undefined
    })
  }

  setModel(recordId: string, model: AgentModel | null): void {
    this.update(recordId, (run) => {
      run.model = model ?? undefined
    })
  }

  cancel(recordId: string): void {
    this.waiting = this.waiting.filter((issue) => issue.id !== recordId)
    this.handles.get(recordId)?.cancel()
    this.resting.get(recordId)?.cancel()
    this.update(recordId, (run) => {
      if (isActivePhase(run.phase) || run.phase === 'paused') run.phase = 'cancelled'
      run.pausedFrom = undefined
    })
    this.append(recordId, entry('system', 'agent', t('已停止')))
    this.settle()
  }

  /** Stop the current step but keep the issue's place; its session waits to be resumed. */
  pause(recordId: string): void {
    const run = this.runs[recordId]
    if (!run || !isActivePhase(run.phase) || run.phase === 'queued') return
    const from = run.phase
    this.pauses.set(recordId, (this.pauses.get(recordId) ?? 0) + 1)
    // Before the kill, so the step's exit handler sees a pause rather than an ending.
    this.update(recordId, (r) => {
      r.phase = 'paused'
      r.pausedFrom = from
    })
    this.handles.get(recordId)?.cancel()
    this.append(recordId, entry('system', 'agent', t('已暂停')))
  }

  /** Pick a paused issue up at the step it was stopped in. */
  resume(recordId: string): void {
    const run = this.runs[recordId]
    if (!run || run.phase !== 'paused') return
    const issue = this.known.get(recordId)
    if (!issue) throw new TeaBranchError(t('这个 issue 不在当前列表里，刷新后再继续'))
    const from = run.pausedFrom
    const config = loadTeableConfig()
    const cwd = this.worktreePath(run)
    this.append(recordId, entry('system', 'agent', t('继续')))
    try {
      if (from === 'reviewing' && cwd) return this.startReview(issue, run, cwd, config)
      if ((from === 'triaging' || from === 'fixing') && cwd && sessionExists(run.sessionId, cwd)) {
        this.update(recordId, (r) => {
          r.phase = from
        })
        this.startAgent(issue, resumePrompt(), cwd, config, (outcome) =>
          from === 'triaging' ? this.triageFinished(issue, outcome, config) : void this.agentFinished(issue, outcome, config),
        )
        return
      }
      // Paused before the agent had a session to carry on: go through the steps again.
      this.update(recordId, (r) => {
        r.phase = 'queued'
        r.pausedFrom = undefined
      })
      void this.pipeline(issue, config)
    } catch (error) {
      this.fail(recordId, t('启动 agent 失败：{error}', { error: errorMessage(error) }))
      this.settle()
    }
  }

  pauseAll(): void {
    this.paused = true
    for (const id of Object.keys(this.runs)) this.pause(id)
    this.changed()
  }

  resumeAll(): void {
    this.paused = false
    for (const run of Object.values(this.runs)) {
      if (run.phase !== 'paused') continue
      try {
        this.resume(run.recordId)
      } catch (error) {
        this.append(run.recordId, entry('error', 'agent', errorMessage(error), true))
      }
    }
    this.changed()
    this.fill()
  }

  /** Stop everything running or paused, and drop what's still waiting. */
  cancelAll(): void {
    const waiting = this.waiting.map((issue) => issue.id)
    this.waiting = []
    this.paused = false
    const live = Object.values(this.runs)
      .filter((run) => isActivePhase(run.phase) || run.phase === 'paused')
      .map((run) => run.recordId)
    for (const id of new Set([...waiting, ...live])) this.cancel(id)
    this.changed()
  }

  reorder(ids: string[]): void {
    const rank = new Map(ids.map((id, index) => [id, index]))
    this.waiting = [...this.waiting].sort((a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length))
    this.changed()
  }

  /** Forget the run and its conversation. The worktree and branch stay. */
  reset(recordId: string): void {
    this.cancel(recordId)
    delete this.runs[recordId]
    this.transcripts.delete(recordId)
    saveTranscript(recordId, [])
    this.scheduleSave()
    this.changed()
    this.settle()
  }

  async postLatestReview(recordId: string): Promise<void> {
    const record = this.runs[recordId]
    const review = record?.reviews.at(-1)
    if (!record?.prURL || !review) throw new TeaBranchError(t('没有 PR 或 review 结果。'))
    const cwd = this.worktreePath(record)
    if (!cwd) throw new TeaBranchError(t('找不到 worktree'))
    const file = join(tmpdir(), `teabranch-review-${randomUUID()}.md`)
    writeFileSync(file, `### 🤖 ${engineLabel(review.engine)} review (${review.model})\n\n${review.text}`)
    try {
      const result = await run('gh', ['pr', 'comment', record.prURL, '--body-file', file], { cwd })
      if (!result.ok) throw new TeaBranchError(t('gh pr comment 失败：{error}', { error: result.stderr }))
    } finally {
      rmSync(file, { force: true })
    }
    this.append(recordId, entry('system', 'review', t('Review 已发布到 PR')))
  }

  /** The command that reopens the issue's conversation interactively. */
  resumeCommand(recordId: string): { cwd: string; command: string; title: string } | undefined {
    const run = this.runs[recordId]
    const cwd = run && this.worktreePath(run)
    if (!run || !cwd) return undefined
    const env = Object.entries(modelEnvironment(loadTeableConfig().fixModel))
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .sort()
      .join(' ')
    const command = commandLine(state.settings.agentCommand, ['--resume', run.sessionId])
    return { cwd, command: env ? `env ${env} ${command}` : command, title: run.branch }
  }

  /**
   * The issue's worktree for a chat about it, built first when there is none yet — same branch and
   * shared database a fix would use, so a later fix picks it up as is.
   */
  async issueWorktree(
    issue: Issue,
    onProgress: (branch: string, progress: WorktreeProgress) => void,
  ): Promise<{ cwd: string; branch: string }> {
    const repo = state.projectPath
    if (!repo) throw new TeaBranchError(t('没有设置仓库路径'))
    const branch = this.runs[issue.id]?.branch ?? branchName(issue, loadTeableConfig().branchPrefix)
    const existed = existsSync(worktrees.worktreeDirectory(branch, repo))
    // Under the branch lock even when it exists: a fix may be building it right now.
    const cwd = await withBranchLock(branch, async () =>
      worktrees.create(branch, repo, await defaultDbMode(repo), (progress) => onProgress(branch, progress)),
    )
    if (!existed) onBranchCreated(branch)
    return { cwd, branch }
  }

  worktreePath(run: IssueRun): string | undefined {
    const repo = state.projectPath
    if (!repo) return undefined
    const path = worktrees.worktreeDirectory(run.branch, repo)
    return existsSync(path) ? path : undefined
  }

  // MARK: CI

  /** Every open PR's checks, now and then; a settled run whose CI failed goes back to its agent. */
  private watchCI(): void {
    const tick = async (): Promise<void> => {
      for (const run of Object.values(this.runs)) {
        if (!run.prURL || (run.ci && run.ci.state !== 'OPEN') || this.isBusy(run.recordId)) continue
        await this.refreshChecks(run.recordId).catch(() => undefined)
      }
      this.ciTimer = setTimeout(() => void tick(), 90_000)
    }
    this.ciTimer ??= setTimeout(() => void tick(), 10_000)
  }

  async refreshChecks(recordId: string): Promise<void> {
    const prURL = this.runs[recordId]?.prURL
    if (!prURL) return
    const result = await run('gh', ['pr', 'view', prURL, '--json', 'state,headRefOid,statusCheckRollup'], { timeoutMs: 30_000 })
    const parsed = result.ok ? parseChecks(result.out) : undefined
    if (!parsed) return
    this.update(recordId, (r) => {
      r.ci = { ...parsed, at: Date.now() }
    })
    this.maybeSendCI(recordId)
  }

  async prDetails(recordId: string): Promise<PRDetails> {
    const prURL = this.runs[recordId]?.prURL
    if (!prURL) throw new TeaBranchError(t('还没有 PR'))
    const fields =
      'number,url,title,body,state,isDraft,reviewDecision,mergeStateStatus,headRefName,baseRefName,additions,deletions,changedFiles,author,updatedAt,headRefOid,statusCheckRollup'
    const result = await run('gh', ['pr', 'view', prURL, '--json', fields], { timeoutMs: 30_000 })
    if (!result.ok) throw new TeaBranchError(t('读取 PR 失败：{error}', { error: result.stderr || result.out }))
    const data = JSON.parse(result.out) as Omit<PRDetails, 'author'> & { author?: { login?: string } }
    const checks = parseChecks(result.out)
    if (checks) {
      this.update(recordId, (r) => {
        r.ci = { ...checks, at: Date.now() }
      })
      this.maybeSendCI(recordId)
    }
    return {
      number: data.number,
      url: data.url,
      title: data.title,
      body: data.body ?? '',
      state: data.state,
      isDraft: !!data.isDraft,
      reviewDecision: data.reviewDecision ?? '',
      mergeStateStatus: data.mergeStateStatus ?? '',
      headRefName: data.headRefName,
      baseRefName: data.baseRefName,
      additions: data.additions ?? 0,
      deletions: data.deletions ?? 0,
      changedFiles: data.changedFiles ?? 0,
      author: data.author?.login ?? '',
      updatedAt: data.updatedAt,
    }
  }

  /** Merge, draft ⇄ ready, close — what you'd otherwise go to GitHub for. The branch is kept. */
  async prAction(recordId: string, action: PRAction): Promise<void> {
    const prURL = this.runs[recordId]?.prURL
    if (!prURL) throw new TeaBranchError(t('还没有 PR'))
    const args: Record<PRAction, string[]> = {
      squash: ['pr', 'merge', prURL, '--squash'],
      merge: ['pr', 'merge', prURL, '--merge'],
      rebase: ['pr', 'merge', prURL, '--rebase'],
      draft: ['pr', 'ready', prURL, '--undo'],
      ready: ['pr', 'ready', prURL],
      close: ['pr', 'close', prURL],
    }
    const result = await run('gh', args[action], { timeoutMs: 60_000 })
    if (!result.ok) throw new TeaBranchError(result.stderr || result.out || t('gh 执行失败'))
    const done: Record<PRAction, string> = {
      squash: t('PR 已合并'),
      merge: t('PR 已合并'),
      rebase: t('PR 已合并'),
      draft: t('PR 已转为草稿'),
      ready: t('PR 已标记为可以 review'),
      close: t('PR 已关闭'),
    }
    this.append(recordId, entry('system', 'agent', done[action]))
    await this.refreshChecks(recordId)
  }

  /** Once per push, after every check has finished, up to the round cap. */
  private maybeSendCI(recordId: string): void {
    const run = this.runs[recordId]
    const issue = this.known.get(recordId)
    const config = loadTeableConfig()
    if (!run?.ci || !issue || !config.autoFixCI || this.isBusy(recordId)) return
    if (run.phase !== 'prOpen' && run.phase !== 'finished') return
    if (run.ci.state !== 'OPEN' || ciPending(run.ci) || !ciFailures(run.ci).length || run.ciSentFor === run.ci.sha) return
    if ((run.ciRounds ?? 0) >= Math.max(1, config.maxCIRounds)) return
    this.sendCIFailures(issue, true).catch((error) => this.append(recordId, entry('error', 'agent', errorMessage(error), true)))
  }

  async sendCIFailures(issue: Issue, auto = false): Promise<void> {
    const current = this.runs[issue.id]
    const failures = current?.ci ? ciFailures(current.ci) : []
    if (!current?.prURL || !current.ci || !failures.length) throw new TeaBranchError(t('这个 PR 现在没有失败的 CI'))
    const { prURL, ci } = current
    this.update(issue.id, (r) => {
      r.ciSentFor = ci.sha
      if (auto) r.ciRounds = (r.ciRounds ?? 0) + 1
    })
    const names = failures.map((check) => check.name).join(', ')
    if (auto)
      this.append(
        issue.id,
        entry('system', 'agent', t('CI 失败，自动发给 agent（第 {round} 轮）', { round: this.runs[issue.id].ciRounds ?? 1 })),
      )
    await this.send(issue, ciFixPrompt(promptTarget(issue, current.branch), prURL, ci.sha, failures), [], t('CI 失败：{names}', { names }))
  }

  // MARK: Queue

  /** More slots start more now; fewer let the running ones finish and take no new ones until under. */
  concurrencyChanged(): void {
    this.changed()
    this.fill()
  }

  /** Free slots take the next issues in line. */
  private fill(): void {
    if (this.paused) return
    const max = Math.max(1, loadTeableConfig().batchSize)
    const config = loadTeableConfig()
    const taken: Issue[] = []
    while (this.slots.length < max && this.waiting.length) {
      const issue = this.waiting.shift() as Issue
      this.slots.push(issue.id)
      taken.push(issue)
    }
    if (!taken.length) return
    this.changed()
    for (const issue of taken) void this.pipeline(issue, config)
  }

  /**
   * Done with everything automation will do on its own. A run that stopped without a PR counts:
   * its agent is waiting on a human, and holding a slot for that answer stalls the queue. A
   * paused one doesn't: you stopped it to come back to it.
   */
  private isSettled(recordId: string): boolean {
    const run = this.runs[recordId]
    return !this.handles.has(recordId) && (!run || (!isActivePhase(run.phase) && run.phase !== 'paused'))
  }

  /**
   * Free the slots of issues that have settled and fill them. Called only at the *end* of a step —
   * after an agent turn or review has started whatever comes next. Between "PR opened" and "review
   * started" a run briefly looks settled, and checking there would free its slot early.
   */
  private settle(): void {
    const done = this.slots.filter((id) => this.isSettled(id))
    if (!done.length) return
    this.slots = this.slots.filter((id) => !done.includes(id))
    this.finished.push(...done)
    this.changed()
    this.fill()
    if (this.slots.length || this.waiting.length) return
    notifyDone(this.finished.map((id) => this.runs[id]).filter((run): run is IssueRun => !!run))
    this.finished = []
  }

  // MARK: Pipeline

  /** Worktree, then the first agent turn. */
  private async pipeline(issue: Issue, config: TeableConfig): Promise<void> {
    this.known.set(issue.id, issue)
    const run = this.runs[issue.id]
    if (!run || run.phase !== 'queued') return this.settle()
    const pauses = this.pauses.get(issue.id) ?? 0
    const stopped = (phase: IssueRun['phase']): boolean =>
      this.runs[issue.id]?.phase !== phase || (this.pauses.get(issue.id) ?? 0) !== pauses
    const repo = state.projectPath
    if (!repo) {
      this.fail(issue.id, t('没有设置仓库路径'))
      return this.settle()
    }

    this.update(issue.id, (r) => {
      r.phase = 'preparing'
    })
    // Only a worktree this run itself started and never finished. A same-named directory made by
    // hand is the user's and is reused as is.
    const abandoned = this.abandoned.get(issue.id)
    this.abandoned.delete(issue.id)
    if (abandoned) await this.discardHalfBuilt(abandoned, repo, issue.id)

    let cwd: string
    try {
      cwd = await withBranchLock(run.branch, async () =>
        worktrees.create(run.branch, repo, await defaultDbMode(repo), (progress) =>
          this.append(issue.id, entry('system', 'agent', progress.message)),
        ),
      )
    } catch (error) {
      this.fail(issue.id, t('创建 worktree 失败：{error}', { error: errorMessage(error) }))
      return this.settle()
    }
    this.update(issue.id, (r) => {
      r.worktreeReady = true
    })
    onBranchCreated(run.branch)

    // Stopped while the worktree was being built.
    if (stopped('preparing')) return this.settle()

    this.update(issue.id, (r) => {
      r.phase = 'fixing'
    })
    // Attachments and the comment thread: what the text cells leave out.
    this.append(issue.id, entry('system', 'agent', t('读取附件和评论…')))
    const context = await prepareIssueContext(issue)
    const downloaded = context.files.filter((file) => file.path).length
    this.append(
      issue.id,
      entry(
        'system',
        'agent',
        t('附件 {downloaded}/{total} 个已下载 · 评论 {comments} 条', {
          downloaded,
          total: context.files.length,
          comments: context.comments.length,
        }),
      ),
    )
    if (stopped('fixing')) return this.settle()

    try {
      if (config.triage) {
        // Is it real, and still there? Same session as the fix, so the fix starts from what it found.
        this.update(issue.id, (r) => {
          r.phase = 'triaging'
        })
        this.append(issue.id, entry('user', 'agent', t('【修复前验证】{key} {title}', { key: issue.key, title: issue.title })))
        this.startAgent(issue, triagePrompt(promptTarget(issue, run.branch), contextPrompt(context)), cwd, config, (outcome) =>
          this.triageFinished(issue, outcome, config),
        )
      } else {
        this.append(issue.id, entry('user', 'agent', t('【自动修复任务】{key} {title}', { key: issue.key, title: issue.title })))
        this.startAgent(issue, fixPrompt(promptTarget(issue, run.branch), contextPrompt(context)), cwd, config, (outcome) =>
          this.agentFinished(issue, outcome, config),
        )
      }
    } catch (error) {
      this.fail(issue.id, t('启动 agent 失败：{error}', { error: errorMessage(error) }))
      this.settle()
    }
  }

  private startAgent(issue: Issue, prompt: string, cwd: string, config: TeableConfig, onExit: (outcome: Outcome) => void): void {
    const run = this.runs[issue.id]
    // New work: where it lands is up to how this run ends, not where you filed the last one.
    run.shelf = undefined
    run.pausedFrom = undefined
    // The session's process is still alive for its background tasks: a second one would fork the
    // session, so the prompt goes into this one.
    const resting = this.resting.get(issue.id)
    if (resting) {
      if (!resting.steer?.(prompt)) throw new TeaBranchError(t('Agent 正在收尾，等它退出再试'))
      this.finishing.set(issue.id, onExit)
      this.changed()
      return
    }
    this.finishing.set(issue.id, onExit)
    const finish = (outcome: Outcome) => (this.finishing.get(issue.id) ?? onExit)(outcome)
    const handle: Handle = runClaude({
      prompt,
      cwd,
      session: { kind: sessionExists(run.sessionId, cwd) ? 'resume' : 'new', id: run.sessionId },
      model: run.model ?? config.fixModel,
      access: run.access ?? config.access,
      baseCommand: state.settings.agentCommand,
      appendSystemPrompt: systemPrompt(issue),
      // The issue's downloaded attachments live outside the worktree; let the agent read them.
      extraArgs: [contextDir(issue.id), uploadsDir(issue.id)].filter(existsSync).flatMap((dir) => ['--add-dir', dir]),
      channel: 'agent',
      onEntry: (line) => this.append(issue.id, line),
      onContext: (used) =>
        this.update(issue.id, (current) => {
          current.context = { used, window: current.context?.window }
        }),
      onBackground: (tasks) =>
        this.update(issue.id, (current) => {
          current.background = tasks.length ? tasks : undefined
        }),
      // The turn is over though the process lives on: settle it now, and free its slot.
      onTurn: (outcome) => {
        // It woke while a reviewer held the issue: its turn is in the transcript, nothing to settle.
        if (this.handles.get(issue.id) !== handle) {
          this.update(issue.id, (current) => {
            current.costUSD += outcome.costUSD
          })
          return
        }
        this.handles.delete(issue.id)
        this.resting.set(issue.id, handle)
        finish(outcome)
      },
      // A message went in, or a finished task woke it: the issue is being worked on again.
      onWake: () => {
        if (this.resting.get(issue.id) !== handle || this.handles.has(issue.id)) return
        this.resting.delete(issue.id)
        this.handles.set(issue.id, handle)
        this.finishing.set(issue.id, (outcome) => void this.agentFinished(issue, outcome, loadTeableConfig()))
        this.update(issue.id, (current) => {
          current.phase = 'fixing'
          current.shelf = undefined
          current.lastError = undefined
        })
      },
      onExit: (outcome) => {
        const rested = this.resting.get(issue.id) === handle
        if (rested) this.resting.delete(issue.id)
        else if (this.handles.get(issue.id) === handle) this.handles.delete(issue.id)
        this.update(issue.id, (current) => {
          current.background = undefined
          if (outcome.contextWindow) current.context = { used: current.context?.used ?? 0, window: outcome.contextWindow }
        })
        // Its last turn was settled when it ended; only the background outlived it.
        if (rested || outcome.reported) return this.drain(issue)
        finish(outcome)
      },
    })
    this.handles.set(issue.id, handle)
    this.changed()
  }

  /** Settle the pre-fix check: a confirmed bug goes straight on to the fix; anything else waits for you. */
  private triageFinished(issue: Issue, outcome: Outcome, config: TeableConfig): void {
    try {
      const run = this.runs[issue.id]
      if (!run || run.phase === 'cancelled' || run.phase === 'paused' || outcome.cancelled) return
      this.update(issue.id, (r) => {
        r.costUSD += outcome.costUSD
      })
      if (!outcome.finalText) {
        this.fail(issue.id, outcome.diagnosis ?? t('验证没有输出结论'))
        return
      }
      // No verdict line is a check that didn't conclude: ask, don't fix on a guess.
      const verdict = triageVerdict(outcome.finalText) ?? 'needsInfo'
      this.update(issue.id, (r) => {
        r.triage = { verdict, text: outcome.finalText as string, at: Date.now() }
      })
      if (verdict !== 'bug') {
        this.update(issue.id, (r) => {
          r.phase = 'triaged'
        })
        this.append(issue.id, entry('system', 'agent', t('验证结论：{verdict}，不自动修复，等你决定', { verdict: triageLabel[verdict] })))
        return
      }
      const cwd = this.worktreePath(run)
      if (!cwd) {
        this.fail(issue.id, t('找不到 worktree：{branch}', { branch: run.branch }))
        return
      }
      this.update(issue.id, (r) => {
        r.phase = 'fixing'
      })
      this.append(issue.id, entry('system', 'agent', t('验证结论：确认是 bug，开始修复')))
      this.append(issue.id, entry('user', 'agent', t('【自动修复任务】{key} {title}', { key: issue.key, title: issue.title })))
      this.startAgent(issue, fixAfterTriagePrompt(promptTarget(issue, run.branch)), cwd, config, (next) =>
        this.agentFinished(issue, next, config),
      )
    } catch (error) {
      this.fail(issue.id, t('启动 agent 失败：{error}', { error: errorMessage(error) }))
    } finally {
      this.settle()
      this.drain(issue)
    }
  }

  /** Settle an agent turn: find the PR, write it back, maybe review. */
  private async agentFinished(issue: Issue, outcome: Outcome, config: TeableConfig): Promise<void> {
    try {
      const run = this.runs[issue.id]
      if (!run || run.phase === 'cancelled' || run.phase === 'paused' || outcome.cancelled) return
      this.update(issue.id, (r) => {
        r.costUSD += outcome.costUSD
      })

      const cwd = this.worktreePath(run)
      const prURL = cwd ? await findPR(run.branch, cwd) : undefined
      if (prURL) {
        const isNew = prURL !== run.prURL
        this.update(issue.id, (r) => {
          r.prURL = prURL
          r.phase = 'prOpen'
          r.lastError = undefined
        })
        if (isNew) {
          this.append(issue.id, entry('system', 'agent', t('PR 已创建：{url}', { url: prURL })))
          await this.writeBack(issue.id, prURL, config)
        }
        // Review whenever the agent changed the PR — on creation, and after addressing a review.
        // The round cap keeps the two from ping-ponging forever.
        const latest = this.runs[issue.id]
        const rounds = latest.reviews.length
        const lastApproved = latest.reviews.at(-1)?.approved ?? false
        const wantsReview = rounds === 0 || (config.sendReviewToAgent && rounds < Math.max(1, config.maxReviewRounds))
        if (config.autoReview && !lastApproved && wantsReview && cwd) {
          try {
            this.startReview(issue, latest, cwd, config)
          } catch (error) {
            this.update(issue.id, (r) => {
              r.phase = 'prOpen'
            })
            this.append(issue.id, entry('error', 'review', errorMessage(error), true))
          }
        }
      } else if (outcome.isError) {
        this.fail(issue.id, outcome.finalText ? truncate(outcome.finalText, 400) : t('Agent 异常退出'))
      } else {
        // Stopped without a PR — usually it needs information. Its question is in the conversation.
        this.update(issue.id, (r) => {
          r.phase = 'finished'
        })
      }
    } finally {
      this.settle()
      this.drain(issue)
    }
  }

  private startReview(issue: Issue, run: IssueRun, cwd: string, config: TeableConfig): void {
    const round = run.reviews.length + 1
    const prompt = reviewPrompt(promptTarget(issue, run.branch), round)
    const model = config.reviewEngine === 'codex' ? config.codexModel || 'codex default' : agentModelLabel(config.reviewModel)
    this.update(issue.id, (r) => {
      r.phase = 'reviewing'
      r.pausedFrom = undefined
    })
    this.append(
      issue.id,
      entry('system', 'review', t('第 {round} 轮 review · {engine}', { round, engine: engineLabel(config.reviewEngine) })),
    )

    const onEntry = (line: ConversationEntry): void => this.append(issue.id, { ...line, channel: 'review' })
    const onExit = (outcome: Outcome): void => {
      this.handles.delete(issue.id)
      void this.reviewFinished(issue, outcome, round, model, config)
    }
    const handle =
      config.reviewEngine === 'codex'
        ? runCodexReview({ prompt, cwd, model: config.codexModel, onEntry, onExit })
        : // A fresh session per review: the reviewer must not inherit the fixer's reasoning, or it
          // reviews the intent instead of the diff.
          runClaude({
            prompt,
            cwd,
            session: { kind: 'new', id: randomUUID() },
            model: config.reviewModel,
            baseCommand: state.settings.agentCommand,
            extraArgs: ['--disallowedTools', 'Edit,Write,NotebookEdit,MultiEdit'],
            channel: 'review',
            onEntry,
            onExit,
          })
    this.handles.set(issue.id, handle)
    this.changed()
  }

  private async reviewFinished(issue: Issue, outcome: Outcome, round: number, model: string, config: TeableConfig): Promise<void> {
    try {
      const phase = this.runs[issue.id]?.phase
      if (phase === 'cancelled' || phase === 'paused' || outcome.cancelled) return
      if (!outcome.finalText) {
        this.update(issue.id, (r) => {
          r.phase = 'prOpen'
        })
        this.append(issue.id, entry('error', 'review', outcome.diagnosis ?? t('Review 没有输出'), true))
        return
      }
      const approved = isApproved(outcome.finalText)
      const review: ReviewRecord = {
        engine: config.reviewEngine,
        model,
        text: outcome.finalText,
        approved,
        round,
        at: Date.now(),
      }
      this.update(issue.id, (r) => {
        r.reviews.push(review)
        r.costUSD += outcome.costUSD
        r.phase = 'prOpen'
      })
      this.append(issue.id, entry('review', 'review', outcome.finalText))

      if (approved) {
        this.append(issue.id, entry('system', 'review', t('✅ Reviewer 认可，等你审查合并')))
        return
      }
      if (!config.sendReviewToAgent) return
      if (round >= Math.max(1, config.maxReviewRounds)) {
        // The last round still goes back to the agent; re-reviewing the result is the human's job.
        this.append(issue.id, entry('system', 'review', t('已到 review 轮数上限，修改后不再自动 review')))
      }
      this.append(issue.id, entry('system', 'agent', t('把第 {round} 轮 review 发给 agent', { round })))
      try {
        await this.send(issue, reviewFeedbackPrompt(promptTarget(issue, this.runs[issue.id].branch), review, engineLabel(review.engine)))
      } catch (error) {
        this.append(issue.id, entry('error', 'agent', errorMessage(error), true))
      }
    } finally {
      this.settle()
      this.drain(issue)
    }
  }

  /** Once the issue settles, what you typed while it worked goes to the agent, a message a turn. */
  private drain(issue: Issue): void {
    const run = this.runs[issue.id]
    const next = run?.queued?.[0]
    if (!run || !next || this.isBusy(issue.id) || run.phase === 'cancelled' || run.phase === 'paused') return
    this.steer(issue, next.id).catch((error) => this.append(issue.id, entry('error', 'agent', errorMessage(error), true)))
  }

  private async writeBack(recordId: string, prURL: string, config: TeableConfig): Promise<void> {
    const cells: Record<string, unknown> = {}
    if (config.prField) cells[config.prField] = prURL
    if (config.statusField && config.doneStatus) cells[config.statusField] = config.doneStatus
    const token = await accessToken()
    if (!Object.keys(cells).length || !token) return
    try {
      await teable.update(config, token, recordId, cells)
      this.append(recordId, entry('system', 'agent', t('已回写 Teable：{fields}', { fields: Object.keys(cells).sort().join(', ') })))
    } catch (error) {
      this.append(recordId, entry('error', 'agent', t('回写 Teable 失败：{error}', { error: errorMessage(error) }), true))
    }
  }

  /**
   * Remove a worktree whose setup was cut short, and its branch if nothing was committed on it.
   * `worktrees.create` treats an existing directory as finished, so without this a retry would hand
   * the agent half a `node_modules` and no env file.
   */
  private async discardHalfBuilt(branch: string, repo: string, recordId: string): Promise<void> {
    if (!existsSync(worktrees.worktreeDirectory(branch, repo))) return
    this.append(recordId, entry('system', 'agent', t('清理未完成的 worktree：{branch}', { branch })))
    try {
      await withBranchLock(branch, () => worktrees.remove(branch, repo))
    } catch (error) {
      this.append(recordId, entry('error', 'agent', errorMessage(error), true))
      return
    }
    // Never delete commits: only a branch with nothing beyond the base goes.
    const unique = await git(['rev-list', '--count', `origin/${worktrees.baseBranch}..${branch}`], repo)
    if (unique.ok && unique.out === '0') await git(['branch', '-D', branch], repo)
  }

  // MARK: State helpers

  private fail(recordId: string, message: string): void {
    this.update(recordId, (run) => {
      run.phase = 'failed'
      run.lastError = message
    })
    this.append(recordId, entry('error', 'agent', message, true))
  }

  private update(recordId: string, body: (run: IssueRun) => void): void {
    const run = this.runs[recordId]
    if (!run) return
    body(run)
    run.updatedAt = Date.now()
    this.scheduleSave()
    this.changed()
  }

  private append(recordId: string, line: ConversationEntry): void {
    const list = this.transcript(recordId)
    list.push(line)
    // Bounded: the oldest of thousands of tool calls are the least interesting part.
    if (list.length > 3000) list.splice(0, list.length - 3000)
    emit('transcript', { recordId, entries: [line] })
    // Rewriting a whole conversation per streamed line would be megabytes of IO per minute.
    this.dirty.add(recordId)
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null
      for (const id of this.dirty) saveTranscript(id, this.transcript(id))
      this.dirty.clear()
    }, 1000)
  }

  private changed(): void {
    emitSoon('issueRunsChanged', 50)
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      saveIssueRuns(this.runs)
    }, 300)
  }

  /** Flush everything now — called on quit. */
  flush(): void {
    for (const id of this.dirty) saveTranscript(id, this.transcript(id))
    saveIssueRuns(this.runs)
  }
}

let onBranchCreated: (branch: string) => void = () => undefined
export const setOnBranchCreated = (callback: (branch: string) => void): void => {
  onBranchCreated = callback
}

export const issueAgent = new IssueAgent()

// MARK: - Helpers

/**
 * Share the main checkout's database and Redis — a fix rarely needs its own copy, and skipping the
 * create-from-template step makes a worktree much faster to stand up. A fresh one only when no
 * develop checkout has a database configured.
 */
async function defaultDbMode(repo: string): Promise<DbMode> {
  const info = await worktreeDbInfo(repo)
  const main = info.find((entry) => entry.branchName === worktrees.baseBranch && entry.databaseURL)
  return main ? { kind: 'reuse', sourceBranch: main.branchName } : { kind: 'new' }
}

const engineLabel = (engine: string): string => (engine === 'codex' ? 'Codex CLI' : 'Claude Code')

/** The queue ran dry: what came of everything it ran. */
function notifyDone(finished: IssueRun[]): void {
  if (!finished.length) return
  const count = (test: (run: IssueRun) => boolean): number => finished.filter(test).length
  const parts = [t('{n} 个已提 PR', { n: count((run) => !!run.prURL) })]
  const approved = count((run) => !!run.prURL && !!run.reviews.at(-1)?.approved)
  const needsInput = count((run) => run.phase === 'finished' && !run.prURL)
  const triaged = count((run) => run.phase === 'triaged')
  const failed = count((run) => run.phase === 'failed')
  if (approved) parts.push(t('{n} 个 review 通过', { n: approved }))
  if (needsInput) parts.push(t('{n} 个等你回复', { n: needsInput }))
  if (triaged) parts.push(t('{n} 个验证后没修（已修复 / 不是 bug / 信息不足）', { n: triaged }))
  if (failed) parts.push(t('{n} 个失败', { n: failed }))
  const body = t('共 {total} 个：{body}', { total: finished.length, body: parts.join(t('，')) })
  if (Notification.isSupported()) new Notification({ title: t('Issue 队列全部完成'), body, sound: 'Glass' }).show()
}

/** The issue id itself (`T2312`), case kept, anything git dislikes turned into `-`. */
export function branchName(issue: Issue, prefix: string): string {
  const slug = issue.key
    .replace(/[^A-Za-z0-9_.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return prefix + (slug || issue.id)
}

/** Claude keeps sessions at `~/.claude/projects/<resolved cwd, non-alphanumerics → ->/<id>.jsonl`. */
function sessionExists(sessionId: string, cwd: string): boolean {
  let resolved = cwd
  try {
    resolved = realpathSync(cwd)
  } catch {
    // Use as is.
  }
  const encoded = resolved.replace(/[^A-Za-z0-9]/g, '-')
  return existsSync(join(homedir(), '.claude/projects', encoded, `${sessionId}.jsonl`))
}

async function findPR(branch: string, cwd: string): Promise<string | undefined> {
  const result = await run('gh', ['pr', 'view', branch, '--json', 'url,state', '-q', 'select(.state != "CLOSED") | .url'], { cwd })
  return result.ok && result.out.startsWith('http') ? result.out : undefined
}

export const isApproved = (review: string): boolean => /VERDICT:\s*APPROVE/i.test(review)

function promptTarget(issue: Issue, branch: string): PromptTarget {
  const config = loadTeableConfig()
  return { issue, link: teable.recordURL(config, issue.id), branch, base: worktrees.baseBranch, custom: config.prompts }
}
