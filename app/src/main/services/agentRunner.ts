import { randomUUID } from 'node:crypto'
import { httpFetch } from '../core/http'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentAccess, AgentModel, BackgroundTask, ConversationEntry, EntryChannel, EntryKind } from '@shared/types'
import { t } from '@shared/i18n'
import { readSecret } from '../core/secrets'
import { loadTeableConfig } from '../core/settingsStore'
import { shellQuote } from '../core/shell'
import { type ExitReason, isCleanExit, killGroup, spawnShell } from '../core/spawn'

/** Headless agent runs: Claude Code in `-p` stream-json mode, and `codex exec`. */

export interface Outcome {
  exit: ExitReason
  cancelled: boolean
  /** Claude's final `result` text, or what Codex wrote to `--output-last-message`. */
  finalText: string
  costUSD: number
  isError: boolean
  /** Why a run produced nothing, when the output made that recognisable. */
  diagnosis?: string
  /** The model's context window, from the result's `modelUsage`. */
  contextWindow?: number
  /** Every turn was already handed to `onTurn`: the process only outlived them. */
  reported?: boolean
}

export interface Handle {
  pid: number
  cancel(): void
  /**
   * Put a message into the turn that is running, where the agent picks it up at its next step.
   * False when this process can't take one — not Claude, or already winding down.
   */
  steer?(message: string): boolean
  /** Stop one of the agent's background tasks; the process carries on. */
  stopTask?(taskId: string): void
}

export type Session = { kind: 'new' | 'resume'; id: string }

export const entry = (kind: EntryKind, channel: EntryChannel, text: string, isError = false): ConversationEntry => ({
  id: randomUUID(),
  kind,
  channel,
  text,
  isError,
  at: Date.now(),
})

/** What you sent: the text with its `[📎 N]` markers, and the files they stand for. */
export const userEntry = (channel: EntryChannel, text: string, attachments: string[] = []): ConversationEntry => ({
  ...entry('user', channel, text),
  attachments: attachments.length ? attachments : undefined,
})

export const truncate = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit)}…` : text)

/** `base` comes from settings; everything appended is quoted — the prompt is table text anyone edits. */
export const commandLine = (base: string, args: string[]): string => [base, ...args.map(shellQuote)].join(' ')

/** The env that points Claude Code at the Magpie gateway instead of its own login. */
export function modelEnvironment(model: AgentModel): Record<string, string> {
  if (model.provider !== 'magpie') return {}
  const key = readSecret('magpie.key') ?? 'magpie'
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: loadTeableConfig().magpieURL,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_API_KEY: key,
  }
  if (model.model) {
    env.ANTHROPIC_MODEL = model.model
    // Background work (titles, summaries) must not fall back to a model the gateway doesn't route.
    env.ANTHROPIC_SMALL_FAST_MODEL = model.model
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model.model
  }
  return env
}

// MARK: - Claude Code

const permissionModes: Record<AgentAccess, string> = {
  supervised: 'default',
  acceptEdits: 'acceptEdits',
  auto: 'auto',
  fullAccess: 'bypassPermissions',
}

export function accessArgs(access: AgentAccess): string[] {
  const args = ['--permission-mode', permissionModes[access]]
  if (access === 'fullAccess') args.push('--allow-dangerously-skip-permissions')
  return args
}

/** The default agent command skips permissions outright, which would override any mode. */
export const withoutSkipPermissions = (command: string): string => command.replace(/\s+--dangerously-skip-permissions\b/g, '')

/** `--effort` for the CLI's own levels; `ultracode` is `xhigh` plus its setting, `ultrathink` a prompt prefix. */
export function effortArgs(effort: AgentModel['effort']): string[] {
  if (!effort || effort === 'ultrathink') return []
  if (effort === 'ultracode') return ['--effort', 'xhigh', '--settings', JSON.stringify({ ultracode: true })]
  return ['--effort', effort]
}

export function runClaude(options: {
  prompt: string
  cwd: string
  session: Session
  model: AgentModel
  /** Undefined leaves `baseCommand`'s own permission flags alone. */
  access?: AgentAccess
  baseCommand: string
  appendSystemPrompt?: string
  extraArgs?: string[]
  /** On top of the model's. */
  env?: Record<string, string>
  channel: EntryChannel
  onEntry: (entry: ConversationEntry) => void
  /** Tokens now in context, after each model call. */
  onContext?: (used: number) => void
  /** What the agent has running in the background, each time that changes. */
  onBackground?: (tasks: BackgroundTask[]) => void
  /**
   * A turn ended but background tasks keep the process alive: the turn's outcome, settled now
   * rather than at the exit. The process takes a new message from here, and starts a turn of its
   * own when a task finishes.
   */
  onTurn?: (outcome: Outcome) => void
  /** After `onTurn`, the agent works again: a message went in, or a finished task woke it. */
  onWake?: () => void
  /** What's left since the last `onTurn`. */
  onExit: (outcome: Outcome) => void
}): Handle {
  const effort = options.model.effort
  const prompt = effort === 'ultrathink' ? `Ultrathink:\n${options.prompt}` : options.prompt
  // The prompt goes in on stdin, which stays open for the turn so messages can be steered into it.
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
  args.push(options.session.kind === 'new' ? '--session-id' : '--resume', options.session.id)
  if (options.model.model) args.push('--model', options.model.model)
  args.push(...effortArgs(effort))
  const baseCommand = options.access ? withoutSkipPermissions(options.baseCommand) : options.baseCommand
  if (options.access) args.push(...accessArgs(options.access))
  if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt)
  args.push(...(options.extraArgs ?? []))

  const parser = new StreamParser(options.channel, options.onContext)
  let cancelled = false
  let open = true
  // Between turns, waiting on background tasks.
  let idle = false
  // What `onTurn` has handed over already: results by count, cost as the running total it reached.
  let reportedResults = 0
  let reportedCost = 0
  // Claude's `total_cost_usd` counts the whole process, so each settlement takes the difference.
  const settlement = (exit: ExitReason) => {
    const outcome: Outcome = {
      exit,
      cancelled,
      finalText: parser.results.slice(reportedResults).filter(Boolean).join('\n\n'),
      costUSD: Math.max(0, parser.cost - reportedCost),
      isError: parser.isError || !isCleanExit(exit),
      contextWindow: parser.contextWindow,
      reported: reportedResults > 0 && reportedResults === parser.results.length,
    }
    reportedResults = parser.results.length
    reportedCost = parser.cost
    return outcome
  }
  const wake = () => {
    if (!idle) return
    idle = false
    options.onWake?.()
  }
  const close = () => {
    open = false
    child.process.stdin?.end()
  }
  const child = spawnShell(
    commandLine(baseCommand, args),
    options.cwd,
    { ...modelEnvironment(options.model), ...options.env },
    (line, stream) => {
      if (stream === 'stderr') {
        if (line.trim()) options.onEntry(entry('system', options.channel, line.trim(), true))
        return
      }
      const before = parser.background
      const parsed = parser.consume(line)
      if (parser.background !== before) {
        options.onBackground?.(parser.background)
        // The last task finished between turns. Claude still takes the turn it wakes up for, then exits.
        if (idle && open && !parser.background.length) close()
      }
      for (const item of parsed) {
        // The agent's own output means it works again. Not a background subagent's steps, nor a
        // task's notice: one that was stopped wakes nobody, and a finished one is followed by its turn.
        if (item.kind !== 'result' && item.kind !== 'task' && !item.parentToolUseId) wake()
        options.onEntry(item)
        if (item.kind !== 'result' || !open) continue
        // The turn is over. Claude still answers anything that came in too late to steer, then exits —
        // unless it left work in the background, which it waits for: until then it takes messages.
        if (!parser.background.length) close()
        else {
          idle = true
          options.onTurn?.(settlement({ code: 0, signal: null }))
        }
      }
    },
    { stdin: true },
  )
  const write = (text: string): boolean => {
    const stdin = child.process.stdin
    if (!open || !stdin?.writable) return false
    wake()
    stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`)
    return true
  }
  // A shell that failed to start closes the pipe; that surfaces as the exit, not as a crash here.
  child.process.stdin?.on('error', () => (open = false))
  write(prompt)
  void child.exited.then((exit) => options.onExit(settlement(exit)))
  return {
    pid: child.pid,
    cancel: () => {
      cancelled = true
      open = false
      killGroup(child.pid, 1000)
    },
    steer: write,
    stopTask: (taskId) => {
      const stdin = child.process.stdin
      if (!open || !stdin?.writable) return
      const request = { type: 'control_request', request_id: randomUUID(), request: { subtype: 'stop_task', task_id: taskId } }
      stdin.write(`${JSON.stringify(request)}\n`)
    },
  }
}

/** Claude's `stream-json` events → conversation lines. */
export class StreamParser {
  /** One per turn: a steered message that came too late for the running turn gets a turn of its own. */
  results: string[] = []
  cost = 0
  isError = false
  contextWindow?: number
  /** Replaced, not mutated, so a change shows as a new array. */
  background: BackgroundTask[] = []
  private lastUsageId = ''
  /** The agent's own background tasks — not what its subagents ran — by task id. */
  private tasks = new Map<string, BackgroundTask>()

  constructor(
    private readonly channel: EntryChannel,
    private readonly onContext?: (used: number) => void,
  ) {}

  consume(line: string): ConversationEntry[] {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line)
    } catch {
      return line.trim() ? [entry('system', this.channel, line.trim())] : []
    }
    const content = ((event.message as { content?: unknown })?.content ?? []) as Record<string, unknown>[]

    switch (event.type) {
      case 'system':
        return this.system(event)
      case 'assistant': {
        // One API call can arrive as several events (one per content block); report it once.
        const message = event.message as { id?: string; usage?: Record<string, number> } | undefined
        const usage = message?.usage
        if (usage && this.onContext && !event.parent_tool_use_id && message?.id !== this.lastUsageId) {
          this.lastUsageId = message?.id ?? ''
          this.onContext(
            (usage.input_tokens ?? 0) +
              (usage.cache_read_input_tokens ?? 0) +
              (usage.cache_creation_input_tokens ?? 0) +
              (usage.output_tokens ?? 0),
          )
        }
        // A subagent's steps belong under the call that runs it; what it says comes back as that call's result.
        const parentToolUseId = event.parent_tool_use_id ? String(event.parent_tool_use_id) : undefined
        return content.flatMap((block) => {
          if (block.type === 'text' && !parentToolUseId) {
            const text = String(block.text ?? '').trim()
            return text ? [entry('assistant', this.channel, text)] : []
          }
          if (block.type === 'tool_use') {
            const input = (block.input ?? {}) as Record<string, unknown>
            const line = entry('tool', this.channel, `${String(block.name ?? 'tool')}  ${summarize(input)}`)
            return [{ ...line, toolUseId: String(block.id ?? ''), parentToolUseId }]
          }
          return []
        })
      }
      case 'user': {
        const parentToolUseId = event.parent_tool_use_id ? String(event.parent_tool_use_id) : undefined
        return content.flatMap((block) => {
          if (block.type !== 'tool_result') return []
          const text = flatten(block.content)
          const failed = block.is_error === true
          return failed || text ? [{ ...entry('toolResult', this.channel, truncate(text, 1200), failed), parentToolUseId }] : []
        })
      }
      case 'result': {
        // One per turn, empty or not: what's been settled is counted in these.
        this.results.push(String(event.result ?? ''))
        // The process's running total; the turn's own share is what it added.
        const before = this.cost
        this.cost = Number(event.total_cost_usd ?? 0)
        const turnCost = Math.max(0, this.cost - before)
        this.isError = event.is_error === true
        const models = Object.values((event.modelUsage ?? {}) as Record<string, { contextWindow?: number }>)
        const windows = models.map((model) => model.contextWindow ?? 0).filter(Boolean)
        if (windows.length) this.contextWindow = Math.max(...windows)
        const seconds = Number(event.duration_ms ?? 0) / 1000
        const stats = { turns: Number(event.num_turns ?? 0), seconds: Math.round(seconds), costUSD: turnCost }
        const summary = t('完成 · {turns} 轮 · {seconds}s · ${cost}', { ...stats, cost: turnCost.toFixed(2) })
        return [{ ...entry('result', this.channel, summary, this.isError), stats }]
      }
      default:
        return []
    }
  }

  /** The session's start — reported again for each turn, which names its model — and background tasks. */
  private system(event: Record<string, unknown>): ConversationEntry[] {
    switch (event.subtype) {
      case 'init': {
        const model = String(event.model ?? '?')
        return [{ ...entry('system', this.channel, t('会话已连接 · {model}', { model })), connectedModel: model }]
      }
      case 'task_started': {
        // A subagent's own commands, and calls that run in the foreground, are its tool calls already.
        if (event.is_backgrounded !== true || event.owned_by_subagent === true) return []
        const id = String(event.task_id ?? '')
        const task: BackgroundTask = {
          id,
          kind: taskKinds[String(event.task_type)] ?? 'other',
          description: String(event.description ?? ''),
          startedAt: Date.now(),
        }
        this.tasks.set(id, task)
        this.background = [...this.background.filter((other) => other.id !== id), task]
        return []
      }
      case 'task_notification': {
        const id = String(event.task_id ?? '')
        const task = this.tasks.get(id)
        if (!task) return []
        this.tasks.delete(id)
        this.background = this.background.filter((other) => other.id !== id)
        const status = finishedStatuses.has(String(event.status))
          ? (String(event.status) as 'completed' | 'failed' | 'stopped')
          : 'completed'
        const summary = String(event.summary ?? '').trim() || task.description
        return [{ ...entry('task', this.channel, truncate(summary, 1200), status === 'failed'), task: { ...task, status } }]
      }
      case 'background_tasks_changed': {
        // Claude's own list is the authority: a task it dropped without a notification is gone too.
        const live = new Set(((event.tasks ?? []) as { task_id?: string }[]).map((task) => String(task.task_id)))
        const kept = this.background.filter((task) => live.has(task.id))
        if (kept.length !== this.background.length) this.background = kept
        return []
      }
      default:
        return []
    }
  }
}

const taskKinds: Record<string, BackgroundTask['kind']> = { local_bash: 'command', local_agent: 'agent' }

const finishedStatuses = new Set(['completed', 'failed', 'stopped'])

/** One line for a tool call — the path or command, not the input blob. */
function summarize(input: Record<string, unknown>): string {
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'description', 'prompt']) {
    if (typeof input[key] === 'string') return truncate(input[key] as string, 240)
  }
  return truncate(JSON.stringify(input), 240)
}

function flatten(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((block) => (block as { text?: string }).text ?? '').join('\n')
  return ''
}

// MARK: - Codex

const htmlNotice = (): string => t('（模型服务返回了一个 HTML 错误页，已省略）')
const connectionPattern = /Unable to connect|Connection refused|ECONNREFUSED|error sending request|stream disconnected|failed to connect/i

/** `codex exec` in a read-only sandbox: it can read the repo and run git, not edit. */
export function runCodexReview(options: {
  prompt: string
  cwd: string
  model: string
  onEntry: (entry: ConversationEntry) => void
  onExit: (outcome: Outcome) => void
}): Handle {
  const output = join(tmpdir(), `teabranch-review-${randomUUID()}.md`)
  const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--output-last-message', output]
  if (options.model) args.push('--model', options.model)
  args.push(options.prompt)

  // An HTML error page from a dead gateway is a hundred lines of CSS: collapse it to one line.
  let inHTML = false
  let connectionFailed = false
  let cancelled = false
  const child = spawnShell(commandLine('codex', args), options.cwd, {}, (raw) => {
    const line = raw.trim()
    if (!line) return
    if (connectionPattern.test(line)) connectionFailed = true
    const lower = line.toLowerCase()
    if (inHTML) {
      if (lower.includes('</html>')) inHTML = false
      return
    }
    if (lower.startsWith('<!doctype html') || lower.startsWith('<html')) {
      inHTML = !lower.includes('</html>')
      options.onEntry(entry('system', 'review', htmlNotice(), true))
      return
    }
    options.onEntry(entry('system', 'review', truncate(line, 600)))
  })

  void child.exited.then((exit) => {
    let text = ''
    try {
      text = readFileSync(output, 'utf8').trim()
    } catch {
      // Codex never got to write it.
    }
    rmSync(output, { force: true })
    options.onExit({
      exit,
      cancelled,
      finalText: text,
      costUSD: 0,
      isError: !isCleanExit(exit) || !text,
      diagnosis: connectionFailed ? t('Codex 连不上模型服务 — 检查 ~/.codex/config.toml 指向的服务（如 Magpie）是否在运行') : undefined,
    })
  })
  return {
    pid: child.pid,
    cancel: () => {
      cancelled = true
      killGroup(child.pid, 1000)
    },
  }
}

// MARK: - Models

/** Model ids the Magpie gateway routes, from its OpenAI-style `/v1/models`. */
export async function magpieModels(baseURL: string): Promise<string[]> {
  const key = readSecret('magpie.key')
  const response = await httpFetch(`${baseURL.replace(/[/\s]+$/, '')}/v1/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(5000),
  }).catch(() => null)
  if (!response?.ok) throw new Error(t('{url} 上的 Magpie 没有返回模型列表 — 它在运行吗？', { url: baseURL }))
  const payload = (await response.json()) as { data?: { id: string }[] }
  return (payload.data ?? []).map((model) => model.id).sort()
}

// MARK: - Context

/**
 * Tokens in a session's context as of its last model call, read from the transcript Claude Code
 * keeps under `~/.claude/projects`. For sessions that predate live tracking.
 */
export function sessionContextUsed(sessionId: string): number | undefined {
  const root = join(homedir(), '.claude/projects')
  let file: string | undefined
  try {
    file = readdirSync(root)
      .map((dir) => join(root, dir, `${sessionId}.jsonl`))
      .find((path) => existsSync(path))
  } catch {
    return undefined
  }
  if (!file) return undefined
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i])
      const usage = event.type === 'assistant' && !event.isSidechain ? event.message?.usage : undefined
      if (usage)
        return (
          (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.output_tokens ?? 0)
        )
    } catch {
      // Skip a partial line.
    }
  }
  return undefined
}
