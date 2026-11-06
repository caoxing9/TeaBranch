import { randomUUID } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from '../node/fs'
import { homedir, tmpdir } from '../node/os'
import { basename, join } from 'path'
import { Notify } from 'teabranch/native'
import type {
  AgentAccess,
  AgentModel,
  ModelScene,
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
} from '../shared/types'
import { agentModelLabel, isActivePhase, triageLabel, triageVerdict } from '../shared/types'
import { agentMessage } from '../shared/attachments'
import { ciFailures, ciPending, parseChecks } from '../shared/ci'
import { cleanupBlockers } from '../shared/cleanup'
import { t } from '../shared/i18n'
import { state } from '../core/appState'
import { modelFor } from '../core/models'
import { emit, emitSoon } from '../core/events'
import { errorMessage, TeaBranchError } from '../core/log'
import { loadAutopilotConfig, loadIssueRuns, loadTeableConfig, loadTranscript, saveIssueRuns, saveTranscript } from '../core/settingsStore'
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
import { browserEnvironment } from './browserBridge'
import { contextDir, contextPrompt, type IssueContext, prepareIssueContext, uploadsDir } from './issueContext'
import { createIssue, setFixStatus } from './issueSource'
import { inspect, removeWorktree } from './worktreeCleanup'
import {
  fixAfterTriagePrompt,
  fixPrompt,
  type PromptTarget,
  reviewFeedbackPrompt,
  ciFixPrompt,
  resumePrompt,
  reviewPrompt,
  systemPrompt,
  BROWSER_PROMPT,
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
  private ciTimer: ReturnType<typeof setTimeout> | null = null
  /** Half-built worktrees to discard before a retry rebuilds, record id → branch. */
  private abandoned = new Map<string, string>()
  private dirty = new Set<string>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  /** When each issue's conversation last moved: what the watchdog measures a stall by. */
  private activity = new Map<string, number>()
  private phaseListeners: ((run: IssueRun, from: IssueRun['phase']) => void)[] = []
  private rekeyListeners: ((from: string, to: string) => void)[] = []
  /** Probes being filed right now: their records exist in the table a moment before their runs do. */
  private filing = new Set<string>()
  /** Issues whose worktree is being cleaned up right now. */
  private cleaning = new Set<string>()

  constructor() {
    this.runs = loadIssueRuns()
    // Anything mid-flight when the app last quit died with it. Queued issues never started, so
    // they stay queued and rejoin once the table loads (`restoreQueue`). With autopilot on it was
    // only interrupted: it waits, paused at its step, for autopilot to pick it up again.
    const autopilot = loadAutopilotConfig().enabled
    for (const run of Object.values(this.runs)) {
      if (isActivePhase(run.phase) && run.phase !== 'queued') {
        if (autopilot) {
          run.pausedFrom = run.phase
          run.phase = 'paused'
          run.interrupted = true
        } else {
          run.phase = 'failed'
          run.lastError = t('TeaBranch 退出时它还在运行')
        }
      }
      run.background = undefined
      if (!run.context) {
        const used = sessionContextUsed(run.sessionId)
        if (used) run.context = { used }
      }
    }
    // A probe has no record in the table to load it from: it is what it was asked.
    for (const run of Object.values(this.runs)) if (run.probe) this.known.set(run.recordId, probeIssue(run))
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

  /**
   * Queue a fix. An issue that already has a live or finished run is left alone. `origin` is where
   * autopilot picked it up: the threads it answers in, and whether it reports back only with a PR.
   */
  enqueueFix(issue: Issue, origin?: { threads?: string[]; silent?: boolean; probe?: IssueRun['probe'] }): void {
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
      threads: [...new Set([...(previous?.threads ?? []), ...(origin?.threads ?? [])])],
      silent: origin?.silent ?? previous?.silent,
      probe: origin?.probe ?? previous?.probe,
      filedFrom: previous?.filedFrom,
      retries: previous?.retries,
      seenCommentsAt: previous?.seenCommentsAt,
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
    // A relaunch is no go-ahead: what was left in the queue waits, paused, until you resume it —
    // unless autopilot is on, which is exactly that go-ahead.
    if (!this.slots.length && !loadAutopilotConfig().enabled) this.paused = true
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
    if (!handle || (run.phase !== 'triaging' && run.phase !== 'fixing')) throw new TeaBranchError(t('现在没有 agent 在对话，这条会在它结束后发出'))
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

  /** `display` replaces the message in the transcript when the prompt itself is boilerplate; `scene` picks the model by the rules. */
  async send(issue: Issue, message: string, attachments: string[] = [], display?: string, scene: ModelScene = 'fix'): Promise<void> {
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
    this.startAgent(issue, message, cwd, config, (outcome) => this.agentFinished(issue, outcome, config), scene)
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
    await this.send(
      issue,
      reviewFeedbackPrompt(promptTarget(issue, this.runs[issue.id].branch), review, engineLabel(review.engine)),
      [],
      undefined,
      'reviewFeedback',
    )
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
    writeFileSync(file, `### 🤖 ${engineLabel(review.engine)} review (${review.model})\n\n${review.text}\n\n${OWN_COMMENT}`)
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
    const env = Object.entries(modelEnvironment(run.model ?? modelFor('fix')))
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
  async issueWorktree(issue: Issue, onProgress: (branch: string, progress: WorktreeProgress) => void): Promise<{ cwd: string; branch: string }> {
    const repo = state.projectPath
    if (!repo) throw new TeaBranchError(t('没有设置仓库路径'))
    const branch = this.runs[issue.id]?.branch ?? branchName(issue, loadTeableConfig().branchPrefix)
    const existed = existsSync(worktrees.worktreeDirectory(branch, repo))
    // Under the branch lock even when it exists: a fix may be building it right now.
    const cwd = await withBranchLock(branch, async () => worktrees.create(branch, repo, await defaultDbMode(repo), (progress) => onProgress(branch, progress)))
    if (!existed) onBranchCreated(branch)
    return { cwd, branch }
  }

  worktreePath(run: IssueRun): string | undefined {
    const repo = state.projectPath
    if (!repo) return undefined
    const path = worktrees.worktreeDirectory(run.branch, repo)
    return existsSync(path) ? path : undefined
  }

  // MARK: Autopilot

  /** Each phase change, after it's saved — how autopilot hears an issue finished something worth telling. */
  onPhaseChange(listener: (run: IssueRun, from: IssueRun['phase']) => void): void {
    this.phaseListeners.push(listener)
  }

  issue = (recordId: string): Issue | undefined => this.known.get(recordId)

  /** When a probe is filed: from its probe id to its record's. */
  onRekey(listener: (from: string, to: string) => void): void {
    this.rekeyListeners.push(listener)
  }

  /**
   * Look into something nobody has filed yet: a fresh worktree on the latest base and an agent that
   * checks it first. `images` are local files that came with it.
   */
  probe(text: string, origin: { threads?: string[]; silent?: boolean; images?: string[] } = {}): Issue {
    const id = `probe_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const report = text.trim()
    const dir = uploadsDir(id)
    const images = (origin.images ?? []).filter(existsSync).map((path) => {
      mkdirSync(dir, { recursive: true })
      const target = join(dir, basename(path))
      copyFileSync(path, target)
      return target
    })
    const probe = {
      // Named by its first line; attachment markers are for the agent, not a title.
      title: truncate(
        report
          .replace(/\[📎 \d+\]/g, '')
          .split('\n')
          .map((line) => line.trim())
          .find(Boolean) || report,
        80,
      ),
      body: agentMessage(report, images),
    }
    const issue = probeIssue({ recordId: id, issueKey: this.nextProbeKey(), probe })
    this.known.set(id, issue)
    this.enqueueFix(issue, { threads: origin.threads, silent: origin.silent, probe })
    return issue
  }

  /** P1, P2…: past every probe key and branch already used, so a filed probe's branch is never reused. */
  private nextProbeKey(): string {
    const used = Object.values(this.runs).flatMap((run) => [run.issueKey, run.branch])
    const numbers = used.map((name) => Number(/(?:^|[^A-Za-z])P(\d+)$/.exec(name)?.[1] ?? 0))
    return `P${Math.max(0, ...numbers) + 1}`
  }

  /**
   * The issue is done: take its worktree and branch down. Held back — and said why in its
   * conversation — while anything exists only here: an open PR, unpushed commits, edited files, an
   * agent still at work. `force` is you, having read why, removing it anyway.
   */
  async cleanup(recordId: string, force = false): Promise<string[]> {
    // One at a time per issue: a second look while the first is deleting would see half a worktree.
    if (this.cleaning.has(recordId)) return []
    this.cleaning.add(recordId)
    try {
      return await this.performCleanup(recordId, force)
    } finally {
      this.cleaning.delete(recordId)
    }
  }

  private async performCleanup(recordId: string, force: boolean): Promise<string[]> {
    const run = this.runs[recordId]
    const repo = state.projectPath
    if (!run || !repo) return []
    const cwd = this.worktreePath(run)
    if (!cwd && !run.worktreeReady) return []
    if (cwd && !force) {
      const blockers = cleanupBlockers(await inspect(run.branch, cwd, run.prURL))
      if (this.isBusy(recordId)) blockers.push(t('agent 还在运行'))
      if (blockers.length) {
        const why = blockers.join(t('，'))
        // Retried on every read of the table: said once per reason, not every few minutes.
        if (run.cleanupHeld !== why) this.append(recordId, entry('system', 'agent', t('issue 已完成，但先不清理 worktree：{why}', { why })))
        this.update(recordId, (r) => {
          r.cleanupHeld = why
        })
        return blockers
      }
    }
    if (this.isBusy(recordId) || this.resting.has(recordId)) this.cancel(recordId)
    if (cwd) await removeWorktree(run.branch, repo, { deleteBranch: true })
    this.update(recordId, (r) => {
      r.shelf = 'done'
      r.worktreeReady = undefined
      r.cleanupHeld = undefined
    })
    this.append(recordId, entry('system', 'agent', t('issue 已完成，已清理 worktree 和分支')))
    return []
  }

  /** An issue in the table by its key (`T2312`) or record id. */
  findIssue(keyOrId: string): Issue | undefined {
    const wanted = keyOrId.trim().toLowerCase()
    return this.known.get(keyOrId.trim()) ?? [...this.known.values()].find((issue) => issue.key.toLowerCase() === wanted)
  }

  /** Issues as the table has them now, so a run can carry on from just its id. */
  remember(issues: Issue[]): void {
    for (const issue of issues) this.known.set(issue.id, issue)
  }

  /**
   * A message from outside the app — a chat, a PR comment — for the issue's agent: into its running
   * turn when it's talking, queued while it's busy otherwise, and as a new turn when it's idle.
   */
  async deliver(recordId: string, message: string, attachments: string[] = [], display?: string): Promise<void> {
    const issue = this.known.get(recordId)
    if (!issue) throw new TeaBranchError(t('这个 issue 不在当前列表里，刷新后再继续'))
    if (!this.runs[recordId]) {
      this.enqueueFix(issue)
      return
    }
    if (!this.isBusy(recordId)) return this.send(issue, message, attachments, display)
    const queued: QueuedMessage = { id: randomUUID(), text: message, attachments }
    this.update(recordId, (r) => {
      r.queued = [...(r.queued ?? []), queued]
    })
    await this.steer(issue, queued.id).catch(() => undefined)
  }

  linkThread(recordId: string, thread: string): void {
    this.update(recordId, (run) => {
      if (!run.threads?.includes(thread)) run.threads = [...(run.threads ?? []), thread]
    })
  }

  unlinkThread(recordId: string, thread: string): void {
    this.update(recordId, (run) => {
      run.threads = run.threads?.filter((candidate) => candidate !== thread)
    })
  }

  setSilent(recordId: string, silent: boolean): void {
    this.update(recordId, (run) => {
      run.silent = silent || undefined
    })
  }

  noteCommentsSeen(recordId: string, at: string): void {
    this.update(recordId, (run) => {
      run.seenCommentsAt = at
    })
  }

  /** The agent is mid-turn — not resting on background tasks, not under review. */
  isTalking = (recordId: string): boolean => {
    const phase = this.runs[recordId]?.phase
    return this.handles.has(recordId) && (phase === 'fixing' || phase === 'triaging')
  }

  lastActivity = (recordId: string): number => this.activity.get(recordId) ?? this.runs[recordId]?.updatedAt ?? 0

  /** A word into a quiet agent's turn. False when it can't take one. */
  nudge(recordId: string, message: string): boolean {
    const handle = this.handles.get(recordId)
    if (!handle?.steer?.(message)) return false
    this.update(recordId, (run) => {
      run.nudgedAt = Date.now()
    })
    this.append(recordId, entry('system', 'agent', t('Watchdog：agent 太久没有动静，提醒它汇报进展')))
    return true
  }

  /** Stop the step and start it over in the same session: for an agent that stalled. */
  restart(recordId: string, why: string): void {
    const run = this.runs[recordId]
    if (!run) return
    this.append(recordId, entry('system', 'agent', t('Watchdog：{why}，重启这一步', { why })))
    this.update(recordId, (r) => {
      r.retries = (r.retries ?? 0) + 1
      r.nudgedAt = undefined
    })
    this.pause(recordId)
    // The old process gets a moment to die: a session resumed twice at once forks.
    setTimeout(() => {
      try {
        this.resume(recordId)
      } catch (error) {
        this.append(recordId, entry('error', 'agent', errorMessage(error), true))
      }
    }, 3000)
  }

  /** A failed run, again from the top — same branch and session, so it knows what it tried. */
  retry(recordId: string, why: string): void {
    const issue = this.known.get(recordId)
    const run = this.runs[recordId]
    if (!issue || !run || run.phase !== 'failed') return
    const retries = (run.retries ?? 0) + 1
    this.append(recordId, entry('system', 'agent', t('Watchdog：{why}，自动重试（第 {n} 次）', { why, n: retries })))
    this.enqueueFix(issue)
    this.update(recordId, (r) => {
      r.retries = retries
    })
  }

  /** Runs autopilot found interrupted by a quit, once the table says what their issues are. */
  resumeInterrupted(): void {
    for (const run of Object.values(this.runs)) {
      if (!run.interrupted || run.phase !== 'paused' || !this.known.has(run.recordId)) continue
      this.update(run.recordId, (r) => {
        r.interrupted = undefined
      })
      try {
        this.resume(run.recordId)
      } catch (error) {
        this.append(run.recordId, entry('error', 'agent', errorMessage(error), true))
      }
    }
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
    if (auto) this.append(issue.id, entry('system', 'agent', t('CI 失败，自动发给 agent（第 {round} 轮）', { round: this.runs[issue.id].ciRounds ?? 1 })))
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
    const stopped = (phase: IssueRun['phase']): boolean => this.runs[issue.id]?.phase !== phase || (this.pauses.get(issue.id) ?? 0) !== pauses
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
        worktrees.create(run.branch, repo, await defaultDbMode(repo), (progress) => this.append(issue.id, entry('system', 'agent', progress.message))),
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
    // Attachments and the comment thread: what the text cells leave out. A probe has neither yet.
    let context: IssueContext = { dir: contextDir(issue.id), files: [], comments: [] }
    if (!run.probe) {
      this.append(issue.id, entry('system', 'agent', t('读取附件和评论…')))
      context = await prepareIssueContext(issue)
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
    }
    if (stopped('fixing')) return this.settle()

    try {
      // A probe is a question before it is a fix: it is always checked first.
      if (config.triage || run.probe) {
        // Is it real, and still there? Same session as the fix, so the fix starts from what it found.
        this.update(issue.id, (r) => {
          r.phase = 'triaging'
        })
        this.append(issue.id, entry('user', 'agent', t('【修复前验证】{key} {title}', { key: issue.key, title: issue.title })))
        this.startAgent(
          issue,
          triagePrompt(promptTarget(issue, run.branch), contextPrompt(context)),
          cwd,
          config,
          (outcome) => this.triageFinished(issue, outcome, config),
          'triage',
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

  /** The branch's browser in the app, through `tb-browser`; screenshots go beside the uploads. */
  private browser(issue: Issue, branch: string, prompt?: string): { env: Record<string, string>; appendSystemPrompt?: string } {
    const env = browserEnvironment(issue.id, { branch, dir: join(uploadsDir(issue.id), 'browser') })
    if (!env.TEABRANCH_BROWSER) return { env, appendSystemPrompt: prompt }
    return { env, appendSystemPrompt: prompt ? `${prompt}\n\n${BROWSER_PROMPT}` : BROWSER_PROMPT }
  }

  private startAgent(issue: Issue, prompt: string, cwd: string, config: TeableConfig, onExit: (outcome: Outcome) => void, scene: ModelScene = 'fix'): void {
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
    const { env, appendSystemPrompt } = this.browser(issue, run.branch, systemPrompt(issue))
    const handle: Handle = runClaude({
      prompt,
      cwd,
      session: { kind: sessionExists(run.sessionId, cwd) ? 'resume' : 'new', id: run.sessionId },
      model: run.model ?? modelFor(scene),
      access: run.access ?? config.access,
      baseCommand: state.settings.agentCommand,
      appendSystemPrompt,
      // The issue's downloaded attachments live outside the worktree; let the agent read them.
      // A filed probe keeps reading what came with it under its probe id.
      extraArgs: [contextDir(issue.id), uploadsDir(issue.id), ...(run.filedFrom ? [uploadsDir(run.filedFrom)] : [])]
        .filter(existsSync)
        .flatMap((dir) => ['--add-dir', dir]),
      env,
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
      // A probe that found something real becomes an issue — the bug to fix, or the request to decide on.
      if (run.probe && (verdict === 'bug' || verdict === 'feature')) {
        void this.promote(issue, verdict, config)
        return
      }
      if (verdict !== 'bug') {
        this.update(issue.id, (r) => {
          r.phase = 'triaged'
        })
        this.append(issue.id, entry('system', 'agent', t('验证结论：{verdict}，不自动修复，等你决定', { verdict: triageLabel[verdict] })))
        return
      }
      this.startFix(issue, config)
    } catch (error) {
      this.fail(issue.id, t('启动 agent 失败：{error}', { error: errorMessage(error) }))
    } finally {
      this.settle()
      this.drain(issue)
    }
  }

  /** The check confirmed the bug: on to the fix, in the same session. */
  private startFix(issue: Issue, config: TeableConfig): void {
    const run = this.runs[issue.id]
    const cwd = run && this.worktreePath(run)
    if (!run || !cwd) {
      this.fail(issue.id, t('找不到 worktree：{branch}', { branch: run?.branch ?? issue.key }))
      return
    }
    this.update(issue.id, (r) => {
      r.phase = 'fixing'
    })
    this.append(issue.id, entry('system', 'agent', t('验证结论：确认是 bug，开始修复')))
    this.append(issue.id, entry('user', 'agent', t('【自动修复任务】{key} {title}', { key: issue.key, title: issue.title })))
    this.startAgent(issue, fixAfterTriagePrompt(promptTarget(issue, run.branch)), cwd, config, (next) => this.agentFinished(issue, next, config))
  }

  /**
   * File a probe that found something real as an issue, with what the check found, and carry on as
   * that issue: a bug goes on to its fix, a feature waits for you. If the table can't take it, a bug is
   * still fixed — as the probe.
   */
  private async promote(probe: Issue, verdict: 'bug' | 'feature', config: TeableConfig): Promise<void> {
    let issue = probe
    this.filing.add(probe.id)
    try {
      const run = this.runs[probe.id]
      if (!run?.probe) return
      const pauses = this.pauses.get(probe.id) ?? 0
      // Nothing of the check may still run while its session moves to the record: a process woken
      // from rest would resume the session alongside the fix's, and write under the probe's id.
      await this.quiesce(probe.id)
      try {
        const findings = truncate(run.triage?.text ?? '', 6000)
        // Filed neutral, so nothing reading the table picks it up as work before its run is in place.
        const { issue: filed } = await createIssue(run.probe.title, `${run.probe.body}\n\n---\nTeaBranch:\n${findings}`, {
          fixStatus: false,
        })
        this.append(probe.id, entry('system', 'agent', t('已提 issue：{key}', { key: filed.key })))
        if (!this.rekey(probe.id, filed)) {
          this.fail(probe.id, t('{key} 已经有一个任务在跑，探查停在这里', { key: filed.key }))
          return
        }
        issue = filed
        if (verdict === 'bug') void markFixing(filed.id)
      } catch (error) {
        this.append(probe.id, entry('error', 'agent', t('提 issue 失败：{error}', { error: errorMessage(error) }), true))
      }
      // Paused or stopped while it was being filed: it stays filed, and goes no further.
      const current = this.runs[issue.id]
      if (!current || current.phase !== 'triaging' || (this.pauses.get(issue.id) ?? 0) !== pauses) return
      if (verdict === 'feature') {
        this.update(issue.id, (r) => {
          r.phase = 'triaged'
        })
        this.append(issue.id, entry('system', 'agent', t('验证结论：是需求，不自动修复，等你决定')))
        return
      }
      this.startFix(issue, config)
    } catch (error) {
      this.fail(issue.id, t('启动 agent 失败：{error}', { error: errorMessage(error) }))
    } finally {
      this.filing.delete(probe.id)
      this.settle()
      this.drain(issue)
    }
  }

  /** Stop the issue's process, resting or not, and wait until it is gone. */
  private async quiesce(recordId: string): Promise<void> {
    const handle = this.resting.get(recordId) ?? this.handles.get(recordId)
    if (!handle) return
    this.resting.delete(recordId)
    if (this.handles.get(recordId) === handle) this.handles.delete(recordId)
    handle.cancel()
    await handle.exited
  }

  /** A probe is being filed: the table briefly has its record without its run. */
  isFiling = (): boolean => this.filing.size > 0

  /**
   * Everything a probe held under its id moves to its new record's: the run, its conversation, its
   * place in the queue, the threads it answers in. Its process is gone by now (`quiesce`).
   */
  private rekey(from: string, issue: Issue): boolean {
    const to = issue.id
    const run = this.runs[from]
    // The record already has a run of its own: two runs can't share one id.
    if (!run || this.runs[to]) return false
    delete this.runs[from]
    this.runs[to] = { ...run, recordId: to, issueKey: issue.key, title: issue.title, probe: undefined, filedFrom: from }
    const move = <V>(map: Map<string, V>): void => {
      if (!map.has(from)) return
      map.set(to, map.get(from) as V)
      map.delete(from)
    }
    move(this.handles)
    move(this.finishing)
    move(this.pauses)
    move(this.activity)
    move(this.abandoned)
    this.slots = this.slots.map((id) => (id === from ? to : id))
    this.finished = this.finished.map((id) => (id === from ? to : id))
    this.known.delete(from)
    this.known.set(to, issue)
    const transcript = this.transcript(from)
    this.transcripts.delete(from)
    this.transcripts.set(to, transcript)
    this.dirty.delete(from)
    saveTranscript(to, transcript)
    saveTranscript(from, [])
    this.scheduleSave()
    this.changed()
    emit('issueRekeyed', { from, to })
    for (const listener of this.rekeyListeners) listener(from, to)
    return true
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
    const model = config.reviewEngine === 'codex' ? config.codexModel || 'codex default' : agentModelLabel(modelFor('review'))
    this.update(issue.id, (r) => {
      r.phase = 'reviewing'
      r.pausedFrom = undefined
    })
    this.append(issue.id, entry('system', 'review', t('第 {round} 轮 review · {engine}', { round, engine: engineLabel(config.reviewEngine) })))

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
            model: modelFor('review'),
            baseCommand: state.settings.agentCommand,
            ...this.browser(issue, run.branch),
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
        await this.send(
          issue,
          reviewFeedbackPrompt(promptTarget(issue, this.runs[issue.id].branch), review, engineLabel(review.engine)),
          [],
          undefined,
          'reviewFeedback',
        )
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
    // A probe that couldn't be filed has no record to write to.
    if (this.runs[recordId]?.probe) return
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
    const from = run.phase
    body(run)
    run.updatedAt = Date.now()
    if (run.phase !== from) run.phaseAt = run.updatedAt
    this.scheduleSave()
    this.changed()
    if (run.phase !== from) for (const listener of this.phaseListeners) listener(run, from)
  }

  private append(recordId: string, line: ConversationEntry): void {
    this.activity.set(recordId, line.at)
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
  Notify.show(t('Issue 队列全部完成'), body, 'Glass')
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

/** Marks a PR comment TeaBranch or its agents wrote, so autopilot doesn't hand it back to them. */
export const OWN_COMMENT = '<!-- teabranch -->'

export const isApproved = (review: string): boolean => /VERDICT:\s*APPROVE/i.test(review)

function promptTarget(issue: Issue, branch: string): PromptTarget {
  const config = loadTeableConfig()
  const link = isProbeId(issue.id) ? 'not filed yet' : teable.recordURL(config, issue.id)
  return { issue, link, branch, base: worktrees.baseBranch, custom: config.prompts }
}

export const isProbeId = (id: string): boolean => id.startsWith('probe_')

/** A filed bug moves to the status auto mode fixes, now that its run holds it. Best effort. */
async function markFixing(recordId: string): Promise<void> {
  try {
    await setFixStatus(recordId)
  } catch {
    // The table shows a status; the work goes on regardless.
  }
}

/** A probe as an issue: what it was asked is its whole record. */
function probeIssue(run: Pick<IssueRun, 'recordId' | 'issueKey' | 'probe'>): Issue {
  const title = run.probe?.title ?? ''
  const body = run.probe?.body ?? ''
  return { id: run.recordId, key: run.issueKey, title, body, record: { id: run.recordId, fields: { title, report: body } } }
}
