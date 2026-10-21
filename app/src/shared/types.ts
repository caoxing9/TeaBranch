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

export const categoryLabel: Record<DevCategory, string> = {
  developing: '开发中',
  todo: '待开发',
  done: '已完成',
}

export interface AppSettings {
  projectPath?: string
  basePort: number
  defaultStartCommand: string
  terminalApp?: string
  /** What the "Agent" action runs. Spelled out, not an alias: terminals run it non-interactively. */
  agentCommand: string
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

export type DbMode =
  | { kind: 'new' }
  | { kind: 'clone'; sourceBranch: string }
  | { kind: 'reuse'; sourceBranch: string }

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
}

export const agentModelLabel = (m: AgentModel): string =>
  m.provider === 'claude' ? (m.model ? `Claude · ${m.model}` : 'Claude（默认）') : `Magpie · ${m.model ?? 'default'}`

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
  batchSize: number
  autoNextBatch: boolean
  branchPrefix: string
  fixModel: AgentModel
  reviewEngine: ReviewEngine
  reviewModel: AgentModel
  codexModel: string
  autoReview: boolean
  sendReviewToAgent: boolean
  maxReviewRounds: number
  magpieURL: string
  /** Client ID of a Teable OAuth app with Device Flow enabled. */
  oauthClientId?: string
}

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
  | 'fixing'
  | 'prOpen'
  | 'reviewing'
  | 'finished'
  | 'failed'
  | 'cancelled'

export const phaseLabel: Record<IssuePhase, string> = {
  queued: '排队中',
  preparing: '创建 worktree',
  fixing: '修复中',
  prOpen: 'PR 待审查',
  reviewing: 'Review 中',
  finished: '已结束',
  failed: '失败',
  cancelled: '已取消',
}

export const isActivePhase = (p: IssuePhase): boolean =>
  p === 'queued' || p === 'preparing' || p === 'fixing' || p === 'reviewing'

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
  reviews: ReviewRecord[]
  /** The model this issue's agent runs on, when picked for this issue; else the configured default. */
  model?: AgentModel
  costUSD: number
  createdAt: number
  updatedAt: number
}

export type EntryKind = 'user' | 'assistant' | 'tool' | 'toolResult' | 'system' | 'result' | 'error' | 'review'
export type EntryChannel = 'agent' | 'review'

export interface ConversationEntry {
  id: string
  kind: EntryKind
  channel: EntryChannel
  text: string
  isError?: boolean
  at: number
}

export interface QueueState {
  batch: string[]
  waiting: string[]
  awaitingNextBatch: boolean
  settled: number
}

export interface BatchSummary {
  total: number
  withPR: number
  approved: number
  failed: number
  needsInput: number
  remaining: number
  awaitingConfirmation: boolean
}

// MARK: - IPC

/** Calls the renderer makes into the main process. Each returns a promise over IPC. */
export interface Api {
  // App
  getSettings(): Promise<AppSettings>
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
  startNextBatch(): Promise<void>
  restoreQueue(issues: Issue[]): Promise<void>
  /** `attachments` are paths returned by `saveUpload` / `pickUploads`. */
  sendToAgent(issue: Issue, message: string, attachments?: string[]): Promise<void>
  setIssueModel(recordId: string, model: AgentModel | null): Promise<void>
  /** Store pasted or dropped bytes with the issue's files; returns the saved path. */
  saveUpload(recordId: string, name: string, base64: string): Promise<string>
  /** Pick files from disk and copy them into the issue's files. */
  pickUploads(recordId: string): Promise<string[]>
  review(issue: Issue): Promise<void>
  sendLatestReview(issue: Issue): Promise<void>
  postLatestReview(recordId: string): Promise<void>
  cancelIssue(recordId: string): Promise<void>
  resetIssue(recordId: string): Promise<void>
  resumeInTerminal(recordId: string): Promise<void>
  magpieModels(): Promise<string[]>
  setMagpieKey(key: string): Promise<void>
  openExternal(url: string): Promise<void>
}

/** Pushes from the main process. */
export interface Events {
  branchesChanged: void
  ngrokChanged: NgrokTunnel | null
  logs: { branch: string; lines: LogLine[] }
  worktreeProgress: { branch: string; progress: WorktreeProgress }
  issueRunsChanged: void
  transcript: { recordId: string; entries: ConversationEntry[] }
  batchFinished: BatchSummary
  /** A device-flow sign-in finished; `error` when it didn't succeed. */
  teableSignedIn: { error?: string }
  menu: 'newBranch' | 'settings' | 'showBranches' | 'showIssues'
}

export type EventName = keyof Events

export const IPC_INVOKE = 'teabranch:invoke'
export const IPC_EVENT = 'teabranch:event'
