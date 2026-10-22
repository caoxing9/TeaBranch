import { randomUUID } from 'node:crypto'
import { httpFetch } from '../core/http'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentAccess, AgentModel, ConversationEntry, EntryChannel, EntryKind } from '@shared/types'
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
}

export interface Handle {
  pid: number
  cancel(): void
}

export type Session = { kind: 'new' | 'resume'; id: string }

export const entry = (
  kind: EntryKind,
  channel: EntryChannel,
  text: string,
  isError = false,
): ConversationEntry => ({ id: randomUUID(), kind, channel, text, isError, at: Date.now() })

export const truncate = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}…` : text

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
export const withoutSkipPermissions = (command: string): string =>
  command.replace(/\s+--dangerously-skip-permissions\b/g, '')

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
  channel: EntryChannel
  onEntry: (entry: ConversationEntry) => void
  /** Tokens now in context, after each model call. */
  onContext?: (used: number) => void
  onExit: (outcome: Outcome) => void
}): Handle {
  const effort = options.model.effort
  const prompt = effort === 'ultrathink' ? `Ultrathink:\n${options.prompt}` : options.prompt
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose']
  args.push(options.session.kind === 'new' ? '--session-id' : '--resume', options.session.id)
  if (options.model.model) args.push('--model', options.model.model)
  args.push(...effortArgs(effort))
  const baseCommand = options.access ? withoutSkipPermissions(options.baseCommand) : options.baseCommand
  if (options.access) args.push(...accessArgs(options.access))
  if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt)
  args.push(...(options.extraArgs ?? []))

  const parser = new StreamParser(options.channel, options.onContext)
  let cancelled = false
  const child = spawnShell(
    commandLine(baseCommand, args),
    options.cwd,
    modelEnvironment(options.model),
    (line, stream) => {
      if (stream === 'stderr') {
        if (line.trim()) options.onEntry(entry('system', options.channel, line.trim(), true))
        return
      }
      for (const parsed of parser.consume(line)) options.onEntry(parsed)
    },
  )
  void child.exited.then((exit) =>
    options.onExit({
      exit,
      cancelled,
      finalText: parser.result,
      costUSD: parser.cost,
      isError: parser.isError || !isCleanExit(exit),
      contextWindow: parser.contextWindow,
    }),
  )
  return {
    pid: child.pid,
    cancel: () => {
      cancelled = true
      killGroup(child.pid, 1000)
    },
  }
}

/** Claude's `stream-json` events → conversation lines. */
class StreamParser {
  result = ''
  cost = 0
  isError = false
  contextWindow?: number
  private lastUsageId = ''

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
        return event.subtype === 'init' ? [entry('system', this.channel, `会话已连接 · ${String(event.model ?? '?')}`)] : []
      case 'assistant': {
        // One API call can arrive as several events (one per content block); report it once.
        const message = event.message as { id?: string; usage?: Record<string, number> } | undefined
        const usage = message?.usage
        if (usage && this.onContext && !event.parent_tool_use_id && message?.id !== this.lastUsageId) {
          this.lastUsageId = message?.id ?? ''
          this.onContext(
            (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0),
          )
        }
        return content.flatMap((block) => {
          if (block.type === 'text') {
            const text = String(block.text ?? '').trim()
            return text ? [entry('assistant', this.channel, text)] : []
          }
          if (block.type === 'tool_use') {
            const input = (block.input ?? {}) as Record<string, unknown>
            return [entry('tool', this.channel, `${String(block.name ?? 'tool')}  ${summarize(input)}`)]
          }
          return []
        })
      }
      case 'user':
        return content.flatMap((block) => {
          if (block.type !== 'tool_result') return []
          const text = flatten(block.content)
          const failed = block.is_error === true
          return failed || text ? [entry('toolResult', this.channel, truncate(text, 1200), failed)] : []
        })
      case 'result': {
        this.result = String(event.result ?? '')
        this.cost = Number(event.total_cost_usd ?? 0)
        this.isError = event.is_error === true
        const models = Object.values((event.modelUsage ?? {}) as Record<string, { contextWindow?: number }>)
        const windows = models.map((model) => model.contextWindow ?? 0).filter(Boolean)
        if (windows.length) this.contextWindow = Math.max(...windows)
        const seconds = Number(event.duration_ms ?? 0) / 1000
        const summary = `完成 · ${Number(event.num_turns ?? 0)} 轮 · ${seconds.toFixed(0)}s · $${this.cost.toFixed(2)}`
        return [entry('result', this.channel, summary, this.isError)]
      }
      default:
        return []
    }
  }
}

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

const htmlNotice = '（模型服务返回了一个 HTML 错误页，已省略）'
const connectionPattern =
  /Unable to connect|Connection refused|ECONNREFUSED|error sending request|stream disconnected|failed to connect/i

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
      options.onEntry(entry('system', 'review', htmlNotice, true))
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
      diagnosis: connectionFailed
        ? 'Codex 连不上模型服务 — 检查 ~/.codex/config.toml 指向的服务（如 Magpie）是否在运行'
        : undefined,
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
  if (!response?.ok) throw new Error(`Magpie at ${baseURL} did not return a model list — is it running?`)
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
          (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0)
        )
    } catch {
      // Skip a partial line.
    }
  }
  return undefined
}
