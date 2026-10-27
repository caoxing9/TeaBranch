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
export type TriageVerdict = 'bug' | 'fixed' | 'notBug' | 'needsInfo'

export const triageLabel = translatedLabels<TriageVerdict>({
  bug: () => t('确认是 bug'),
  fixed: () => t('已经修复'),
  notBug: () => t('不是 bug'),
  needsInfo: () => t('信息不足'),
})

/** The verdict from the check's last TRIAGE line; undefined when there is none. */
export function triageVerdict(text: string): TriageVerdict | undefined {
  const verdicts: Record<string, TriageVerdict> = {
    BUG: 'bug',
    ALREADY_FIXED: 'fixed',
    NOT_A_BUG: 'notBug',
    NEEDS_INFO: 'needsInfo',
  }
  const lines = [...text.matchAll(/TRIAGE:\s*\**\s*(BUG|ALREADY_FIXED|NOT_A_BUG|NEEDS_INFO)\b/g)]
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
  deleteChat(chatId: string): Promise<void>
  updateChat(chatId: string, patch: { model?: AgentModel | null; access?: AgentAccess | null; title?: string }): Promise<void>
  /** Store pasted or dropped bytes with the issue's files; returns the saved path. */
  saveUpload(recordId: string, name: string, base64: string): Promise<string>
  /** Pick files from disk and copy them into the issue's files. */
  pickUploads(recordId: string): Promise<string[]>
  review(issue: Issue): Promise<void>
  sendLatestReview(issue: Issue): Promise<void>
  postLatestReview(recordId: string): Promise<void>
  cancelIssue(recordId: string): Promise<void>
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
  menu: 'newBranch' | 'settings' | 'showBranches' | 'showIssues' | 'toggleTerminal' | 'newTerminal'
}

export type EventName = keyof Events

export const IPC_INVOKE = 'teabranch:invoke'
export const IPC_EVENT = 'teabranch:event'
