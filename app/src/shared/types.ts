import { type LanguagePref, type Locale, t } from './i18n'
// Types shared by the main process and the renderer. Everything here crosses IPC, so it is
// plain data: no classes, no functions, no Dates (timestamps are epoch milliseconds).

export type BranchStatus = 'running' | 'stopped' | 'building' | 'error'

export const isLive = (status: BranchStatus): boolean => status === 'running' || status === 'building'

export interface BranchEnvironment {
  branchName: string
  worktreePath?: string
  port?: number
  backendPort?: number
  socketPort?: number
  status: BranchStatus
  databaseName?: string
}

export interface Branch {
  name: string
  isCurrent: boolean
  environment?: BranchEnvironment
  /** Created by TeaBranch, as opposed to added by hand with `git worktree add`. */
  managed: boolean
  worktreePath?: string
}

export type DevCategory = 'developing' | 'todo' | 'done'

/**
 * A label table read like a plain record — `phaseLabel[phase]` — but translated on every read, so
 * it follows a language switch instead of freezing at module load.
 */
function translatedLabels<K extends string>(labels: Record<K, () => string>): Readonly<Record<K, string>> {
  const table = {} as Record<K, string>
  for (const key of Object.keys(labels) as K[]) Object.defineProperty(table, key, { get: labels[key], enumerable: true })
  return table
}

export const categoryLabel = translatedLabels<DevCategory>({
  developing: () => t('开发中'),
  todo: () => t('待开发'),
  done: () => t('已完成'),
})

export interface AppSettings {
  projectPath?: string
  basePort: number
  defaultStartCommand: string
  terminalApp?: string
  /** What the "Agent" action runs. Spelled out, not an alias: terminals run it non-interactively. */
  agentCommand: string
  /** Interface (and agent report) language; follows macOS when unset. */
  language?: LanguagePref
}

export interface NgrokTunnel {
  branchName: string
  port: number
  publicURL: string
}

export interface WorktreeDbInfo {
  branchName: string
  databaseName?: string
  databaseURL?: string
  redisURI?: string
}

export type DbMode = { kind: 'new' } | { kind: 'clone'; sourceBranch: string } | { kind: 'reuse'; sourceBranch: string }

export interface WorktreeProgress {
  step: string
  message: string
  done: boolean
}

export interface EnvEntry {
  key: string
  value: string
  /** TeaBranch generated it and relies on it for isolation. */
  managed: boolean
}

export interface ProcessSample {
  pid: number
  name: string
  cpuPercent: number
  residentBytes: number
  group: string
  elapsedSeconds: number
}

export interface BranchUsage {
  processes: ProcessSample[]
  cpuPercent: number
  residentBytes: number
  uptimeSeconds: number
}

export interface LogLine {
  id: number
  /** Epoch ms the line was captured. */
  at: number
  text: string
  /** `backend`, `frontend`, `dev` — the process label, when the line carries one. */
  source?: string
}

export interface FileChange {
  path: string
  added: number
  removed: number
}

export interface BranchChanges {
  base: string
  files: FileChange[]
  /** Commits on the branch that the base doesn't have. */
  commits: { hash: string; subject: string }[]
  /** Uncommitted edits in the worktree, by path. */
  dirty: string[]
}

export interface TerminalPreset {
  value?: string
  label: string
  supportsTabs: boolean
  supportsCommands: boolean
}

// MARK: - Issues

export type ModelProvider = 'claude' | 'magpie'

export interface AgentModel {
  provider: ModelProvider
  /** For `claude` an alias like `opus`; undefined uses the CLI default. */
  model?: string
  /** Reasoning effort; undefined leaves it to the CLI. */
  effort?: AgentEffort
}

/**
 * Claude Code's `--effort` levels, plus MonoCode's two extras: `ultracode` runs at `xhigh` with
 * the `ultracode` setting on, `ultrathink` is a prompt prefix rather than a flag.
 */
export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode' | 'ultrathink'

export const agentEfforts: { value: AgentEffort; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
  { value: 'max', label: 'Max' },
  { value: 'ultracode', label: 'Ultracode' },
  { value: 'ultrathink', label: 'Ultrathink' },
]

/** A Claude model as the CLI's own `list_models` reports it. `value` is what `--model` takes. */
export interface ClaudeModelOption {
  value: string
  /** The concrete model an alias runs, e.g. `claude-opus-5-5` for `opus`. */
  resolved: string
  name: string
  description: string
  efforts: AgentEffort[]
}

export interface ClaudeCatalog {
  models: ClaudeModelOption[]
  /** What a run with no `--model` gets: `~/.claude/settings.json`'s model, else the CLI's default. */
  defaultName: string
  defaultEffort?: AgentEffort
}

/** MonoCode's access modes, mapped onto Claude Code's `--permission-mode`. */
export type AgentAccess = 'supervised' | 'acceptEdits' | 'auto' | 'fullAccess'

export const agentAccessModes: { value: AgentAccess; label: string; hint: string }[] = [
  {
    value: 'supervised',
    label: 'Supervised',
    hint: 'Ask before commands and file changes. Unattended runs have no one to ask, so these are denied.',
  },
  { value: 'acceptEdits', label: 'Auto-accept edits', hint: 'Auto-approve edits; other actions that need approval are denied.' },
  { value: 'auto', label: 'Auto', hint: 'An AI reviewer can approve or deny actions.' },
  {
    value: 'fullAccess',
    label: 'Full access',
    hint: 'Allow commands, edits, and supported MCP confirmations without prompts.',
  },
]

export const agentEffortLabel = (effort?: AgentEffort): string | undefined => agentEfforts.find((option) => option.value === effort)?.label

export const agentModelLabel = (m: AgentModel): string => {
  const name = m.provider === 'claude' ? (m.model ? `Claude · ${m.model}` : t('Claude（默认）')) : `Magpie · ${m.model ?? 'default'}`
  const effort = agentEffortLabel(m.effort)
  return effort ? `${name} · ${effort}` : name
}

export type ReviewEngine = 'codex' | 'claude'

export interface TeableConfig {
  baseURL: string
  baseId: string
  tableId: string
  viewId?: string
  titleField?: string
  bodyField?: string
  statusField?: string
  idField?: string
  assigneeField?: string
  onlyMine: boolean
  prField?: string
  doneStatus?: string
  fixStatuses: string[]
  autoFix: boolean
  /** How many queued issues run at once. */
  batchSize: number
  branchPrefix: string
  fixModel: AgentModel
  /** Permission mode fix agents run with. */
  access: AgentAccess
  reviewEngine: ReviewEngine
  reviewModel: AgentModel
  codexModel: string
  autoReview: boolean
  /** Before fixing, check the bug is real and still there (reproduce, look for a fix already in). */
  triage: boolean
  sendReviewToAgent: boolean
  maxReviewRounds: number
  /** Send a PR's failing CI back to its agent once every check has finished. */
  autoFixCI: boolean
  /** How many times per run that happens by itself before it waits for you. */
  maxCIRounds: number
  magpieURL: string
  /** Client ID of a Teable OAuth app with Device Flow enabled. */
  oauthClientId?: string
  /** Your own instructions per stage, replacing the defaults; the issue context is always added. */
  prompts?: Partial<Record<PromptStage, string>>
}

/**
 * The stages an issue agent gets instructions for. Each prompt is the issue (fields, comments,
 * attachments) and the worktree, which TeaBranch always supplies, plus instructions you can
 * replace. Placeholders: {key} {link} {branch} {base} {round} {language}. The TRIAGE / VERDICT line
 * a stage must end with is appended by TeaBranch, so a custom prompt can't break the pipeline.
 */
export type PromptStage = 'triage' | 'fix' | 'review' | 'reviewFeedback'
export const promptStages: PromptStage[] = ['triage', 'fix', 'review', 'reviewFeedback']

export interface TeableUser {
  id: string
  name: string
  email?: string
  avatar?: string
}

export interface Attachment {
  name: string
  mimetype: string
  size: number
  /** Time-limited download URL; refreshed on every table load. */
  url?: string
  thumbnail?: string
  width?: number
  height?: number
}

export interface IssueComment {
  id: string
  author: Person
  createdTime: number
  /** Paragraphs as text, mentions as @name, links as Markdown. */
  text: string
  images: string[]
}

/** Someone named in a user cell. */
export interface Person {
  name: string
  email?: string
  avatar?: string
}

/** A level of the Teable hierarchy the issue table is picked from: space → base → table → view. */
export type TeableLevel = 'space' | 'base' | 'table' | 'view'

export interface TeableNode {
  id: string
  name: string
  /** For a table: the view it opens on. */
  defaultViewId?: string
  /** For a base: its space's name, when the token may read it. */
  group?: string
}

export interface TeableField {
  id: string
  name: string
  type: string
  isPrimary: boolean
  choices: string[]
  isMultiple: boolean
}

export interface TeableRecord {
  id: string
  autoNumber?: number
  fields: Record<string, string>
  /** User cells with their avatars, by field name — the text format drops everything but names. */
  people?: Record<string, Person[]>
  /** Attachment cells, by field name. */
  attachments?: Record<string, Attachment[]>
}

export interface Issue {
  record: TeableRecord
  title: string
  body: string
  status?: string
  /** What goes into the branch name, commit and PR title — e.g. `T2312`. */
  key: string
  id: string
}

export type IssuePhase =
  | 'queued'
  | 'preparing'
  | 'triaging'
  | 'triaged'
  | 'fixing'
  | 'prOpen'
  | 'reviewing'
  | 'finished'
  | 'failed'
  | 'cancelled'
  /** Stopped by you mid-step, to pick up where it left off. Holds its place in the batch. */
  | 'paused'

export const phaseLabel = translatedLabels<IssuePhase>({
  queued: () => t('排队中'),
  preparing: () => t('创建 worktree'),
  triaging: () => t('验证中'),
  triaged: () => t('验证完成'),
  fixing: () => t('修复中'),
  prOpen: () => t('PR 待审查'),
  reviewing: () => t('Review 中'),
  finished: () => t('等你回复'),
  failed: () => t('失败'),
  cancelled: () => t('已取消'),
  paused: () => t('已暂停'),
})

export const isActivePhase = (p: IssuePhase): boolean =>
  p === 'queued' || p === 'preparing' || p === 'triaging' || p === 'fixing' || p === 'reviewing'

/** What the pre-fix check concluded: only a confirmed bug goes on to a fix by itself. */
export type TriageVerdict = 'bug' | 'feature' | 'fixed' | 'notBug' | 'needsInfo'

export const triageLabel = translatedLabels<TriageVerdict>({
  bug: () => t('确认是 bug'),
  feature: () => t('是需求'),
  fixed: () => t('已经修复'),
  notBug: () => t('不是 bug'),
  needsInfo: () => t('信息不足'),
})

/** The verdict from the check's last TRIAGE line; undefined when there is none. */
export function triageVerdict(text: string): TriageVerdict | undefined {
  const verdicts: Record<string, TriageVerdict> = {
    BUG: 'bug',
    FEATURE: 'feature',
    ALREADY_FIXED: 'fixed',
    NOT_A_BUG: 'notBug',
    NEEDS_INFO: 'needsInfo',
  }
  const lines = [...text.matchAll(/TRIAGE:\s*\**\s*(BUG|FEATURE|ALREADY_FIXED|NOT_A_BUG|NEEDS_INFO)\b/g)]
  const last = lines.at(-1)
  return last ? verdicts[last[1]] : undefined
}

export interface TriageRecord {
  verdict: TriageVerdict
  text: string
  at: number
}

export interface ReviewRecord {
  engine: ReviewEngine
  model: string
  text: string
  approved: boolean
  round: number
  at: number
}

export interface IssueRun {
  recordId: string
  issueKey: string
  title: string
  branch: string
  /** The issue's own Claude Code conversation; every follow-up resumes it. */
  sessionId: string
  phase: IssuePhase
  /** The worktree pipeline ran to the end. Missing means it was cut short. */
  worktreeReady?: boolean
  prURL?: string
  lastError?: string
  /** The pre-fix check: reproduced, already fixed, not a bug… Missing when it was skipped. */
  triage?: TriageRecord
  reviews: ReviewRecord[]
  /** The model this issue's agent runs on, when picked for this issue; else the configured default. */
  model?: AgentModel
  /** Permission mode for this issue's agent; else the configured default. */
  access?: AgentAccess
  /** How full the agent session's context is, as of its last message. */
  context?: ContextUsage
  /** Messages typed while the agent was busy, sent in order once it settles. */
  queued?: QueuedMessage[]
  /** What the agent left running in the background; the process lives on until they finish. */
  background?: BackgroundTask[]
  /** The PR's checks as last polled. */
  ci?: PRChecks
  /** CI failures sent to the agent by themselves so far. */
  ciRounds?: number
  /** The head commit whose failures went to the agent last, so they go once per push. */
  ciSentFor?: string
  /** The step a pause cut short, which resuming picks up. */
  pausedFrom?: IssuePhase
  /** Where you filed it in the sidebar, over where its phase puts it. Cleared when the agent runs again. */
  shelf?: IssueShelf
  /** Conversations outside the app this issue answers in: a Feishu topic, its PR. Thread ids. */
  threads?: string[]
  /**
   * Started by autopilot on a hunch, from a chat nobody asked it in: it reports back only once it has
   * a PR to show, and otherwise stays quiet.
   */
  silent?: boolean
  /**
   * A probe: work that started before anyone filed an issue — something you or a colleague noticed.
   * It has no Teable record yet; it gets one, and becomes an ordinary run, once the check finds a
   * bug or a feature request. What it was asked, kept so it survives a relaunch.
   */
  probe?: { title: string; body: string }
  /** The probe id this run was before it was filed as an issue. */
  filedFrom?: string
  /** Why its worktree was kept when the issue was done, last time that was tried. */
  cleanupHeld?: string
  /** Times the watchdog restarted it after it stalled or failed. */
  retries?: number
  /** When the watchdog last nudged it for being quiet too long. */
  nudgedAt?: number
  /** When it entered its current phase: how long the step has been going. */
  phaseAt?: number
  /** It was mid-step when TeaBranch quit; autopilot picks it up again on the next launch. */
  interrupted?: boolean
  /** The newest PR comment or review already handed to the agent, as GitHub timestamps it. */
  seenCommentsAt?: string
  costUSD: number
  createdAt: number
  updatedAt: number
}

export type CheckBucket = 'pass' | 'fail' | 'pending' | 'skip'

export interface PRCheck {
  name: string
  bucket: CheckBucket
  link?: string
  description?: string
}

export interface PRChecks {
  /** The head commit these results are for. */
  sha: string
  /** OPEN, MERGED or CLOSED. */
  state: string
  checks: PRCheck[]
  at: number
}

/** What the PR tab shows, from `gh pr view`. */
export interface PRDetails {
  number: number
  url: string
  title: string
  body: string
  /** OPEN, MERGED or CLOSED. */
  state: string
  isDraft: boolean
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED — or empty when no review is required. */
  reviewDecision: string
  /** CLEAN, BLOCKED, BEHIND, DIRTY (conflicts), UNSTABLE (failing checks), DRAFT… */
  mergeStateStatus: string
  headRefName: string
  baseRefName: string
  additions: number
  deletions: number
  changedFiles: number
  author: string
  updatedAt: string
}

export type PRAction = 'squash' | 'merge' | 'rebase' | 'draft' | 'ready' | 'close'

/** The sidebar groups you can move a settled issue into. */
export type IssueShelf = 'review' | 'attention' | 'done'

/** A message waiting for the agent to finish its turn — or to be steered into it. */
export interface QueuedMessage {
  id: string
  text: string
  attachments: string[]
}

export type EntryKind = 'user' | 'assistant' | 'tool' | 'toolResult' | 'system' | 'result' | 'error' | 'review' | 'task'
export type EntryChannel = 'agent' | 'review'

export interface ConversationEntry {
  id: string
  kind: EntryKind
  channel: EntryChannel
  text: string
  isError?: boolean
  at: number
  /**
   * Set on the `system` line Claude Code opens a session with: the model it runs. Read this rather
   * than parsing `text`, which is in whatever language the app was in.
   */
  connectedModel?: string
  /** Set on a `result` line: the run's numbers, so nothing parses the display text. */
  stats?: { turns: number; seconds: number; costUSD: number }
  /** Set on a `user` line: the files sent with it, which its `[📎 N]` markers stand for. */
  attachments?: string[]
  /** Set on a `tool` line: the call's id, which its subagent's steps point back to. */
  toolUseId?: string
  /** Set on a subagent's own steps: the `Agent` call that runs it. */
  parentToolUseId?: string
  /** Set on a `task` line, a background task that finished and woke the agent. */
  task?: BackgroundTask & { status: 'completed' | 'failed' | 'stopped' }
}

/** A command or subagent the agent left running in the background, which keeps its process alive. */
export interface BackgroundTask {
  id: string
  kind: 'command' | 'agent' | 'other'
  description: string
  startedAt: number
}

export interface QueueState {
  /** Taken off the queue and still going: at most `concurrency`. */
  running: string[]
  waiting: string[]
  /** Paused as a whole: running steps stopped, nothing new taken from the queue. */
  paused: boolean
  concurrency: number
}

// MARK: - Autopilot

/**
 * How autopilot treats a Feishu chat: act only when @-mentioned, also weigh what is said without a
 * mention (a bug report nobody addressed to it), or not listen at all.
 */
export type ChatMode = 'mention' | 'candidate' | 'ignore'

export interface FeishuChat {
  id: string
  name: string
  mode: ChatMode
  /** Last message seen from it; chats show up here the first time the bot hears from them. */
  seenAt: number
}

export interface AutopilotConfig {
  /** Listen, route and keep runs going without anyone at the app. */
  enabled: boolean
  feishuAppId: string
  /** Feishu (China) or Lark (international). */
  feishuDomain: 'feishu' | 'lark'
  /**
   * Who it is in the chats: the app's bot, or you — reading the chats you switch on with your
   * authorization, and replying under your name with a 🤖 mark.
   */
  feishuIdentity: 'bot' | 'user'
  /** Speaking as you: seconds between reads of the listened chats. */
  pollSeconds: number
  /**
   * Speaking as you, your direct messages: not read, read for bug reports only (it answers once it
   * has a fix), or each one handed to the router like an @-mention.
   */
  userDirectMode: ChatMode
  /** When it speaks up in a chat, each on its own. */
  notify: ReplyNotify
  /** Characters a chat reply aims to stay under. */
  chatReplyLimit: number
  /** Speaking as you: what starts every reply, so nobody takes it for you. */
  replyPrefix: string
  /** Your own rules for how it replies — tone, form of address, what to leave out. */
  replyRules: string
  /** What counts as worth handling when nobody asked: the semantic filter, in your words. */
  candidatePolicy: string
  /** A new issue in the table that no rule fixes: let the router judge it, or leave it to you. */
  teableNewIssues: 'router' | 'ignore'
  /** The router may answer in an issue's Teable comments. */
  teableReplies: boolean
  /** An issue moved to one of these statuses is finished: its worktree and branch are cleaned up. */
  teableDoneStatuses: string[]
  teableCleanup: boolean
  /** PRs people send in chats, reviewed and answered on GitHub under your account. */
  prReview: PRReviewConfig
  chats: Record<string, FeishuChat>
  /** What a chat not configured yet gets. */
  unknownChatMode: ChatMode
  /** Answer direct messages to the bot. */
  directMessages: boolean
  /** Feishu open ids allowed to drive it; empty lets anyone in a listened chat. */
  allowedUsers: string[]
  /** The model the router — the one that reads every event and replies — runs on. */
  routerModel: AgentModel
  /** Each source on or off on its own, under the master switch. */
  sources: Record<SourceId, boolean>
  /** Minutes without a word from an agent before the watchdog checks on it. */
  stallMinutes: number
  /** Restarts the watchdog tries on a stalled or failed run before leaving it to you. */
  maxRetries: number
  /**
   * Minutes an agent may be mid-step before a model reads its last steps and says whether it is
   * getting anywhere; checked again every so many minutes after. 0 never asks.
   */
  progressCheckMinutes: number
  /** Minutes between reads of the issue table. */
  pollMinutes: number
  /** Keep the Mac from sleeping while autopilot is on. */
  keepAwake: boolean
  openAtLogin: boolean
}

export interface ReplyNotify {
  /** A task was created from the message: a short acknowledgement with its key. */
  accepted: boolean
  /** The task opened a PR. */
  pr: boolean
  /** The agent stopped with a question, or the check found it isn't a bug. */
  question: boolean
  /** The reviewer approved the PR. */
  approved: boolean
  /** It failed, or the watchdog gave up on it. */
  failed: boolean
}

/** Reviews of PRs people send in chats: whether it may, and what it may post on GitHub as you. */
export interface PRReviewConfig {
  /** A PR link with a request to look at it starts a review. */
  enabled: boolean
  /** It may approve, when nothing blocks. */
  approve: boolean
  /** It may request changes; otherwise its findings go in a plain comment. */
  requestChanges: boolean
}

export type FeishuState = 'off' | 'noCredentials' | 'connecting' | 'connected' | 'reconnecting' | 'failed'

/** Where events come from. Each is one of autopilot's inputs, filtered in code before the router. */
export type SourceId = 'teable' | 'feishu' | 'github'

export interface SourceStatus {
  id: SourceId
  /** `setup`: needs something from you before it can run. */
  state: 'off' | 'setup' | 'connecting' | 'online' | 'error'
  /** One line on what it's doing: who it is, how much it watches. */
  detail?: string
  error?: string
  lastEventAt?: number
}

export interface AutopilotStatus {
  enabled: boolean
  feishu: FeishuState
  feishuError?: string
  bot?: { name: string; openId: string }
  /** The router: waiting for events, working through some, or stopped by an error. */
  router: 'off' | 'idle' | 'thinking' | 'error'
  routerError?: string
  /** Events waiting for the router's next turn. */
  pending: number
  /** How full the router's session is; it hands over to a fresh one before the window fills. */
  routerContext?: ContextUsage
  /** When the router last wrote its notes for the next session. */
  routerMemoryAt?: number
  threads: number
  lastPollAt?: number
  sources: SourceStatus[]
}

/** `me`: you, in the app — talking to the router, or starting a probe. */
export type TriggerSource = SourceId | 'me' | 'worker' | 'watchdog'

/** The one thread for your conversation with the router inside the app. */
export const APP_THREAD = 'app:home'

/** One line in autopilot's feed: an event and what became of it. */
export interface ActivityItem {
  id: string
  at: number
  source: TriggerSource | 'router'
  thread?: string
  author?: string
  text: string
  outcome: 'ignored' | 'routed' | 'delivered' | 'replied' | 'action' | 'error'
  detail?: string
  recordId?: string
  /** Files that came with it and stay: what you attached in the app's chat. */
  files?: string[]
  /** The router's own one-line account of what it made of this event. */
  decision?: string
  /** For what the router did: the events it was answering. */
  causes?: string[]
}

/** A PR someone sent, under review: where it stands and what was posted. */
export interface PRReviewJob {
  id: string
  url: string
  number: number
  title: string
  author: string
  phase: 'preparing' | 'reviewing' | 'posting' | 'done' | 'failed'
  /** The reviewer's own verdict. */
  verdict?: 'APPROVE' | 'CHANGES_REQUESTED' | 'COMMENT'
  /** What went on GitHub, after the settings had their say. */
  posted?: 'APPROVE' | 'CHANGES_REQUESTED' | 'COMMENT'
  summary?: string
  error?: string
  /** Where it was asked for; the verdict is reported there. */
  thread?: string
  model: string
  costUSD: number
  startedAt: number
  finishedAt?: number
}

// MARK: - IPC

/** Calls the renderer makes into the main process. Each returns a promise over IPC. */
export interface Api {
  // App
  getSettings(): Promise<AppSettings>
  /** The language in effect: the setting, or macOS's when it follows the system. */
  locale(): Promise<Locale>
  /** The built-in instructions per stage, in the current language, for the prompt editor. */
  defaultPrompts(): Promise<Record<PromptStage, string>>
  chooseProject(): Promise<AppSettings | null>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  terminalPresets(): Promise<TerminalPreset[]>
  canRunAgent(): Promise<boolean>

  // Branches
  listBranches(): Promise<Branch[]>
  getCategories(): Promise<Record<string, DevCategory>>
  setCategory(branch: string, category: DevCategory): Promise<void>
  startBranch(branch: string): Promise<void>
  stopBranch(branch: string): Promise<void>
  restartBranch(branch: string): Promise<void>
  deleteBranch(branch: string): Promise<void>
  createWorktree(branch: string, dbMode: DbMode): Promise<void>
  worktreeDbInfo(): Promise<WorktreeDbInfo[]>
  openTerminal(branch: string): Promise<void>
  openAgent(branch: string): Promise<void>
  openEditor(branch: string): Promise<void>
  openPreview(branch: string): Promise<void>
  /** The branch's in-app browser: state, and placing it over the panel (window coordinates). */
  browserState(branch: string): Promise<BrowserState>
  showBrowser(branch: string, bounds: { x: number; y: number; width: number; height: number }): Promise<void>
  hideBrowser(branch: string): Promise<void>
  browserNavigate(branch: string, address: string): Promise<void>
  browserBack(branch: string): Promise<void>
  browserForward(branch: string): Promise<void>
  browserReload(branch: string): Promise<void>
  browserDevTools(branch: string): Promise<void>
  revealInFinder(branch: string): Promise<void>
  revealAgentFiles(branch: string): Promise<boolean>
  branchesWithTerminal(): Promise<string[]>
  usage(): Promise<Record<string, BranchUsage>>
  logs(branch: string): Promise<LogLine[]>
  clearLogs(branch: string): Promise<void>
  envEntries(branch: string): Promise<EnvEntry[]>
  writeEnvEntries(branch: string, entries: { key: string; value: string }[]): Promise<void>
  ngrok(): Promise<NgrokTunnel | null>
  /** What a branch changed against `origin/develop` — committed, plus what is still uncommitted. */
  branchChanges(branch: string): Promise<BranchChanges>
  openFileInEditor(branch: string, path: string): Promise<void>
  toggleNgrok(branch: string): Promise<NgrokTunnel | null>

  // Issues
  teableConfig(): Promise<TeableConfig>
  updateTeableConfig(patch: Partial<TeableConfig>): Promise<TeableConfig>
  teableSignIn(token: string, baseURL?: string): Promise<TeableUser>
  teableSignOut(): Promise<void>
  teableSession(): Promise<TeableUser | null>
  teableLoad(): Promise<{ fields: TeableField[]; records: TeableRecord[] }>
  /** What the signed-in account can see: its bases (all spaces), a base's tables, a table's views. */
  teableBrowse(level: TeableLevel, parentId?: string): Promise<TeableNode[]>
  openTokenPage(): Promise<void>
  openOAuthAppPage(): Promise<void>
  /** Start a device-flow sign-in: the code is copied and the approval page opened. */
  teableDeviceStart(): Promise<{ userCode: string; verificationUri: string; expiresIn: number }>
  teableDeviceCancel(): Promise<void>
  /** Whether one-click OAuth works for the configured host (a client id is known). */
  teableOAuthReady(): Promise<boolean>
  issueRuns(): Promise<Record<string, IssueRun>>
  queueState(): Promise<QueueState>
  transcript(recordId: string): Promise<ConversationEntry[]>
  /** The record's comment thread, oldest first. */
  issueComments(recordId: string): Promise<IssueComment[]>
  enqueueFix(issues: Issue[]): Promise<void>
  /** Fix one issue right away: queued if it wasn't, then past the batch gate and the line. */
  fixNow(issue: Issue): Promise<void>
  restoreQueue(issues: Issue[]): Promise<void>
  /**
   * `attachments` are paths returned by `saveUpload` / `pickUploads`. While the agent is busy the
   * message queues; `steer` puts it into the running turn instead, when it can.
   */
  sendToAgent(issue: Issue, message: string, attachments?: string[], steer?: boolean): Promise<void>
  /** Send a queued message now: into the running turn, or as the next one when idle. */
  steerIssueMessage(issue: Issue, queuedId: string): Promise<void>
  unqueueIssueMessage(recordId: string, queuedId: string): Promise<void>
  /** File the issue under a sidebar group by hand; null goes back to where its phase puts it. */
  setIssueShelf(recordId: string, shelf: IssueShelf | null): Promise<void>
  setIssueModel(recordId: string, model: AgentModel | null): Promise<void>
  setIssueAccess(recordId: string, access: AgentAccess | null): Promise<void>
  claudeCatalog(): Promise<ClaudeCatalog>
  listChats(): Promise<Chat[]>
  createChat(workspace: { cwd: string; branch?: string; issueId?: string }): Promise<Chat>
  /** A chat in the issue's worktree, building the worktree first when it has none. */
  createIssueChat(issue: Issue): Promise<Chat>
  /** The check said it needn't be fixed; fix it anyway, in the same session. */
  fixAnyway(issue: Issue): Promise<void>

  // Built-in terminals
  /** Start the shell for this tab, or reattach to it; returns the output so far to replay. */
  terminalOpen(
    id: string,
    cwd: string,
    cols: number,
    rows: number,
  ): Promise<{ replay: string; seq: number; title: string; exited: boolean }>
  terminalWrite(id: string, data: string): Promise<void>
  terminalResize(id: string, cols: number, rows: number): Promise<void>
  terminalKill(id: string): Promise<void>
  chatTranscript(chatId: string): Promise<ConversationEntry[]>
  sendChat(chatId: string, message: string, attachments?: string[], steer?: boolean): Promise<void>
  steerChatMessage(chatId: string, queuedId: string): Promise<void>
  unqueueChatMessage(chatId: string, queuedId: string): Promise<void>
  cancelChat(chatId: string): Promise<void>
  /** Stop one of the chat agent's background tasks, or all of them without `taskId`. */
  stopChatBackground(chatId: string, taskId?: string): Promise<void>
  deleteChat(chatId: string): Promise<void>
  updateChat(chatId: string, patch: { model?: AgentModel | null; access?: AgentAccess | null; title?: string }): Promise<void>
  /** Store pasted or dropped bytes with the issue's files; returns the saved path. */
  saveUpload(recordId: string, name: string, base64: string): Promise<string>
  /** Pick files from disk and copy them into the issue's files. */
  pickUploads(recordId: string): Promise<string[]>
  /** An uploaded image as a data URL, for its thumbnail; null for anything else. */
  readUpload(path: string): Promise<string | null>
  review(issue: Issue): Promise<void>
  sendLatestReview(issue: Issue): Promise<void>
  postLatestReview(recordId: string): Promise<void>
  cancelIssue(recordId: string): Promise<void>
  /** Stop one of the issue agent's background tasks, or all of them without `taskId`. */
  stopIssueBackground(recordId: string, taskId?: string): Promise<void>
  /** The PR as GitHub has it now; its checks are refreshed along the way. */
  prDetails(recordId: string): Promise<PRDetails>
  prAction(recordId: string, action: PRAction): Promise<void>
  /** Poll the PR's checks now rather than at the next round. */
  refreshChecks(recordId: string): Promise<void>
  /** Hand the PR's failing checks to the agent, past the automatic round cap. */
  sendCIFailures(issue: Issue): Promise<void>
  /** Stop the issue's current step, keeping its place; `resumeIssue` picks it up again. */
  pauseIssue(recordId: string): Promise<void>
  resumeIssue(recordId: string): Promise<void>
  /** Pause everything running and stop taking new issues off the queue — or undo that. */
  pauseQueue(): Promise<void>
  resumeQueue(): Promise<void>
  /** Stop the batch and empty the queue. */
  cancelQueue(): Promise<void>
  /** Put the waiting issues in this order; ids left out keep their place after. */
  reorderQueue(ids: string[]): Promise<void>
  resetIssue(recordId: string): Promise<void>
  resumeInTerminal(recordId: string): Promise<void>
  magpieModels(): Promise<string[]>
  setMagpieKey(key: string): Promise<void>
  openExternal(url: string): Promise<void>

  // Autopilot
  autopilotConfig(): Promise<AutopilotConfig>
  updateAutopilotConfig(patch: Partial<AutopilotConfig>): Promise<AutopilotConfig>
  autopilotStatus(): Promise<AutopilotStatus>
  /** Whether the Feishu app secret is stored; the secret itself never comes back. */
  hasFeishuSecret(): Promise<boolean>
  /** Approve in the browser so it can read and reply as you; resolves with your name. */
  authorizeFeishuUser(): Promise<string>
  signOutFeishuUser(): Promise<void>
  /** Who authorized, and the redirect URL and scopes the app needs for it. */
  feishuUserInfo(): Promise<{ name?: string; redirectURL: string; scopes: string[] }>
  setFeishuSecret(secret: string): Promise<void>
  /** Newest last. */
  autopilotActivity(): Promise<ActivityItem[]>
  /**
   * Look into something you noticed: a clean worktree on the latest base, its agent checking it.
   * `attachments` are draft uploads (`saveUpload` under `DRAFT_UPLOADS`); the probe takes them over.
   */
  probe(text: string, attachments?: string[]): Promise<{ id: string; key: string }>
  /** Say something to the router in the app's own chat; its answer arrives as activity on `APP_THREAD`. */
  askRouter(text: string, attachments?: string[]): Promise<void>
  /** The app chat so far: your messages, the router's replies and what it did because of them. */
  routerChat(): Promise<ActivityItem[]>
  /** Remove a finished issue's worktree and branch now, past the checks that held it. */
  cleanupIssue(recordId: string): Promise<void>
  /** Start the router over: it writes its notes first, and a fresh session picks them up. */
  resetRouter(): Promise<void>
  /** The router's notes to its next session — what it carries across a reset. */
  routerMemory(): Promise<string>
  setRouterMemory(text: string): Promise<void>
}

/** Pushes from the main process. */
// MARK: - Chats

/** A free-standing AI conversation, not tied to an issue: Claude Code in a checkout you pick. */
/** Tokens in the session's context window: what the composer's ring shows. */
export interface ContextUsage {
  used: number
  /** Unknown until a turn finishes and Claude reports it. */
  window?: number
}

export interface Chat {
  id: string
  title: string
  /** Where the agent runs: the main checkout or a worktree. */
  cwd: string
  /** Branch shown for `cwd`, when it is one. */
  branch?: string
  /** The issue (record id) this chat sits under in the tabs; free-standing when missing. */
  issueId?: string
  sessionId: string
  model?: AgentModel
  access?: AgentAccess
  context?: ContextUsage
  queued?: QueuedMessage[]
  background?: BackgroundTask[]
  costUSD: number
  running: boolean
  createdAt: number
  updatedAt: number
}

/** A branch's in-app browser, for its panel. */
export interface BrowserState {
  branch: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Last time the agent drove it. */
  agentAt?: number
}

export interface Events {
  terminalData: { id: string; data: string; seq: number }
  terminalExit: { id: string; code: number }
  terminalTitle: { id: string; title: string }
  branchesChanged: void
  ngrokChanged: NgrokTunnel | null
  logs: { branch: string; lines: LogLine[] }
  worktreeProgress: { branch: string; progress: WorktreeProgress }
  issueRunsChanged: void
  transcript: { recordId: string; entries: ConversationEntry[] }
  chatsChanged: void
  chatTranscript: { chatId: string; entries: ConversationEntry[] }
  /** A device-flow sign-in finished; `error` when it didn't succeed. */
  teableSignedIn: { error?: string }
  browser: BrowserState
  autopilotStatus: AutopilotStatus
  autopilotActivity: ActivityItem
  /** A probe was filed as an issue: everything under its old id now lives under the record's. */
  issueRekeyed: { from: string; to: string }
  menu: 'newBranch' | 'settings' | 'showBranches' | 'showIssues' | 'toggleTerminal' | 'newTerminal' | 'autopilot'
}

export type EventName = keyof Events

export const IPC_INVOKE = 'teabranch:invoke'
export const IPC_EVENT = 'teabranch:event'
