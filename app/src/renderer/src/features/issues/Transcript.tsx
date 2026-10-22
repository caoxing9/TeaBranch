import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  FilePen,
  FileSearch,
  Search,
  Settings2,
  Terminal,
  Users,
  Wrench,
} from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import type { ConversationEntry, EntryChannel } from '@shared/types'
import { cn } from '@/lib/utils'
import { ClaudeMark, modelDisplayName, useCatalog } from './AgentPickers'
import { Markdown } from './Markdown'

/**
 * The conversation, laid out the way MonoCode does it: each turn is your message, a
 * "Opus 5.5 working for 26s" line while the agent works (its tool calls as a live tree), then —
 * once it settles — a "worked for 7m 34s" fold over all that work, the final answer, and a footer
 * with copy, cost and time.
 */

export type Item =
  | { kind: 'user' | 'assistant' | 'review' | 'error' | 'result'; entry: ConversationEntry }
  | { kind: 'work'; id: string; steps: ConversationEntry[]; live: boolean; channel: EntryChannel }

export const itemId = (item: Item): string => (item.kind === 'work' ? item.id : item.entry.id)

const CONNECTED = '会话已连接 · '

/** Fold every run of tool calls, tool output and progress lines into one `work` item. */
export function buildItems(entries: ConversationEntry[], live: boolean): Item[] {
  const items: Item[] = []
  let pending: ConversationEntry[] = []
  const flush = () => {
    if (pending.length) items.push({ kind: 'work', id: pending[0].id, steps: pending, live: false, channel: pending[0].channel })
    pending = []
  }
  for (const entry of entries) {
    // "Session connected" only names the model, which the turn header already shows.
    if (entry.kind === 'system' && entry.text.startsWith(CONNECTED)) continue
    if (entry.kind === 'tool' || entry.kind === 'toolResult' || entry.kind === 'system') {
      // The fixer's work and the reviewer's are different stories even when adjacent.
      if (pending.length && pending[pending.length - 1].channel !== entry.channel) flush()
      pending.push(entry)
    } else {
      flush()
      items.push({ kind: entry.kind, entry })
    }
  }
  flush()
  const last = items[items.length - 1]
  if (live && last?.kind === 'work') last.live = true
  return items
}

export interface Turn {
  id: string
  user?: ConversationEntry
  /** Everything the agent did before its answer. */
  work: Item[]
  answer?: ConversationEntry
  result?: ConversationEntry
  /** What followed the agent's result: PR notices, the reviewer's work and verdict. */
  after: Item[]
  startedAt: number
  model?: string
  live: boolean
}

/** Split the transcript at each of your messages; within a turn, the agent's result settles it. */
export function buildTurns(entries: ConversationEntry[], live: boolean): Turn[] {
  const turns: Turn[] = []
  const segments: ConversationEntry[][] = []
  let current: ConversationEntry[] = []
  for (const entry of entries) {
    if (entry.kind === 'user' && current.length) {
      segments.push(current)
      current = []
    }
    current.push(entry)
  }
  if (current.length) segments.push(current)

  segments.forEach((segment, index) => {
    const user = segment[0].kind === 'user' ? segment[0] : undefined
    const body = user ? segment.slice(1) : segment
    const resultAt = body.findIndex((entry) => entry.kind === 'result' && entry.channel === 'agent')
    const before = resultAt < 0 ? body : body.slice(0, resultAt)
    const model = before.find((entry) => entry.kind === 'system' && entry.text.startsWith(CONNECTED))?.text.slice(CONNECTED.length)
    const isLast = index === segments.length - 1
    const turn: Turn = {
      id: segment[0].id,
      user,
      work: buildItems(before, live && isLast && resultAt < 0),
      result: resultAt < 0 ? undefined : body[resultAt],
      after: resultAt < 0 ? [] : buildItems(body.slice(resultAt + 1), live && isLast),
      startedAt: segment[0].at ?? 0,
      model,
      live: live && isLast && resultAt < 0,
    }
    // The last thing the agent said before settling is its answer; the rest is working out loud.
    if (turn.result) {
      const last = turn.work[turn.work.length - 1]
      if (last?.kind === 'assistant') {
        turn.answer = last.entry
        turn.work = turn.work.slice(0, -1)
      }
    }
    turns.push(turn)
  })
  return turns
}

// MARK: - Turn

export function TurnView({ turn, layout, renderItem }: { turn: Turn; layout: 'document' | 'chat'; renderItem: (item: Item) => ReactNode }) {
  const catalog = useCatalog((s) => s.catalog)
  const [open, setOpen] = useState(false)
  const model = turn.model ? modelDisplayName(turn.model, catalog) : undefined
  const endedAt = turn.result?.at
  const work = turn.work.map((item) => <div key={itemId(item)}>{renderItem(item)}</div>)

  return (
    <div className="flex flex-col gap-4">
      {turn.user && <UserMessage entry={turn.user} layout={layout} />}
      {turn.live && <WorkingLine startedAt={turn.startedAt} model={model} />}
      {turn.result ? (
        <>
          {turn.work.length > 0 ? (
            // Only a turn that did work in between has anything to unfold.
            <button
              type="button"
              onClick={() => setOpen(!open)}
              className="group flex w-fit items-center gap-2 text-[13px] text-muted-foreground outline-none hover:text-foreground"
            >
              <ClaudeMark />
              <span>{workedFor(model, endedAt && turn.startedAt ? endedAt - turn.startedAt : null, true)}</span>
              <ChevronRight className={cn('size-3.5 opacity-60 transition-transform group-hover:opacity-100', open && 'rotate-90')} />
            </button>
          ) : (
            endedAt && (
              <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <ClaudeMark />
                <span>{workedFor(model, turn.startedAt ? endedAt - turn.startedAt : null, true)}</span>
              </div>
            )
          )}
          {open && <div className="flex flex-col gap-4 border-l pl-4">{work}</div>}
          {turn.answer && (
            <div className="min-w-0 text-[14px] [&_.prose-chat>:first-child]:mt-0 [&>*:first-child]:mt-0">
              <Markdown text={turn.answer.text} />
            </div>
          )}
          <TurnFooter answer={turn.answer} result={turn.result} />
        </>
      ) : (
        work
      )}
      {turn.after.map((item) => (
        <div key={itemId(item)}>{renderItem(item)}</div>
      ))}
    </div>
  )
}

function UserMessage({ entry, layout }: { entry: ConversationEntry; layout: 'document' | 'chat' }) {
  const [expanded, setExpanded] = useState(false)
  const long = entry.text.length > 280 || entry.text.split('\n').length > 4
  const text = (
    <>
      <div className={cn('selectable text-[13.5px] leading-relaxed break-words whitespace-pre-wrap', !expanded && 'line-clamp-4')}>
        {entry.text}
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-[12px] text-muted-foreground hover:text-foreground"
        >
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </>
  )
  if (layout === 'chat') {
    return (
      <div className="flex justify-end pl-16">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-muted px-3.5 py-2">{text}</div>
      </div>
    )
  }
  return <div className="rounded-lg border border-brand/20 bg-brand/[0.07] px-4 py-2.5">{text}</div>
}

function WorkingLine({ startedAt, model }: { startedAt: number; model?: string }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="flex items-center gap-2 text-[13px]">
      <ClaudeMark className="animate-[spin_3s_linear_infinite]" />
      <span className="shimmer">{workedFor(model, startedAt ? now - startedAt : null, false)}</span>
    </div>
  )
}

function workedFor(model: string | undefined, ms: number | null, done: boolean): string {
  const verb = done ? (model ? 'worked' : 'Worked') : model ? 'working' : 'Working'
  const head = model ? `${model} ${verb}` : verb
  if (ms == null || ms <= 0) return done ? head : `${head}…`
  const seconds = Math.max(1, Math.round(ms / 1000))
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60 ? ` ${seconds % 60}s` : ''}`
  return `${head} for ${elapsed}`
}

/** Copy, then what the turn cost and when it landed. Parsed from "完成 · 58 轮 · 454s · $2.32". */
function TurnFooter({ answer, result }: { answer?: ConversationEntry; result: ConversationEntry }) {
  const [copied, setCopied] = useState(false)
  const turns = /(\d+) 轮/.exec(result.text)?.[1]
  const cost = /\$[\d.]+/.exec(result.text)?.[0]
  const time = new Date(result.at ?? Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return (
    <div className="-mt-1 flex items-center gap-1 text-[12px] text-muted-foreground">
      {answer && (
        <button
          type="button"
          title="复制回答"
          onClick={() => {
            void navigator.clipboard.writeText(answer.text)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
          className="grid size-6 place-items-center rounded-md hover:bg-accent hover:text-foreground"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      )}
      {result.isError && (
        <span className="flex items-center gap-1 text-err">
          <CircleAlert className="size-3" />
          出错结束
        </span>
      )}
      <span className="flex items-center gap-1.5 px-1 tabular-nums">
        {[turns && `${turns} 轮`, cost, time].filter(Boolean).join(' · ')}
      </span>
    </div>
  )
}

// MARK: - Activity

type WorkKind = 'read' | 'search' | 'edit' | 'run' | 'agent' | 'setup' | 'other'

const toolName = (entry: ConversationEntry) => entry.text.split(/\s+/)[0]
const toolArg = (entry: ConversationEntry) => entry.text.slice(toolName(entry).length).trim()

const workKindOf = (entry: ConversationEntry): WorkKind => {
  if (entry.kind !== 'tool') return 'setup'
  const name = toolName(entry)
  if (['Read', 'NotebookRead', 'WebFetch'].includes(name)) return 'read'
  if (['Glob', 'Grep', 'LS', 'WebSearch', 'ToolSearch'].includes(name)) return 'search'
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name)) return 'edit'
  if (['Bash', 'BashOutput', 'KillShell', 'Monitor'].includes(name)) return 'run'
  if (['Task', 'Agent'].includes(name)) return 'agent'
  return 'other'
}

const kindIcon: Record<WorkKind, typeof Terminal> = {
  read: FileSearch,
  search: Search,
  edit: FilePen,
  run: Terminal,
  agent: Users,
  setup: Settings2,
  other: Wrench,
}

/** One clause per kind, present tense while live: "正在运行 3 条命令" → "运行了 3 条命令 · 查看了 2 个文件". */
function clause(kind: WorkKind, n: number, live: boolean): string {
  const [doing, done, unit] = {
    read: ['正在查看', '查看了', '个文件'],
    search: ['正在搜索', '搜索了', '次项目'],
    edit: ['正在编辑', '编辑了', '个文件'],
    run: ['正在运行', '运行了', '条命令'],
    agent: ['正在运行', '运行了', '个子 agent'],
    setup: ['正在准备', '完成了', '个步骤'],
    other: ['正在使用', '使用了', '个工具'],
  }[kind]
  return `${live ? doing : done} ${n} ${unit}`
}

/** A stretch of tool calls: a summary line, and while live (or opened) the calls as a tree. */
export function ActivityGroup({ steps, live, review }: { steps: ConversationEntry[]; live: boolean; review: boolean }) {
  const [open, setOpen] = useState(false)
  const calls = steps.filter((step) => step.kind === 'tool')
  const counts = new Map<WorkKind, number>()
  for (const call of calls) counts.set(workKindOf(call), (counts.get(workKindOf(call)) ?? 0) + 1)
  const order = [...counts].sort((a, b) => b[1] - a[1])
  const dominant = order[0]?.[0] ?? 'setup'
  const Icon = kindIcon[dominant]
  const latest = calls[calls.length - 1]
  const summary = calls.length
    ? order.map(([kind, n]) => clause(kind, n, live && latest !== undefined && workKindOf(latest) === kind)).join(' · ')
    : (steps[steps.length - 1]?.text ?? '')
  const failed = steps.some((step) => step.isError)
  const expanded = live || open
  // Setup lines (worktree progress) have no calls; show them as the tree instead.
  const rows = calls.length ? calls : steps

  return (
    <div className="text-[13px]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={live}
        className="group flex max-w-full items-center gap-2 text-left text-muted-foreground enabled:hover:text-foreground"
      >
        <Icon className="size-3.5 shrink-0" />
        <span className={cn('truncate', live && 'shimmer')}>{review ? `Reviewer · ${summary}` : summary}</span>
        {failed && !live && <CircleAlert className="size-3 shrink-0 text-err" />}
        {!live && (
          <ChevronDown className={cn('size-3.5 shrink-0 opacity-0 transition group-hover:opacity-60', open && 'rotate-180 opacity-60')} />
        )}
      </button>
      {expanded && (
        <div className="mt-1.5 ml-[7px]">
          {rows.map((row, index) => (
            <TreeRow key={row.id} entry={row} output={calls.length ? outputOf(steps, row) : undefined} last={index === rows.length - 1} />
          ))}
        </div>
      )}
    </div>
  )
}

const outputOf = (steps: ConversationEntry[], call: ConversationEntry): ConversationEntry | undefined => {
  const next = steps[steps.indexOf(call) + 1]
  return next?.kind === 'toolResult' ? next : undefined
}

function TreeRow({ entry, output, last }: { entry: ConversationEntry; output?: ConversationEntry; last: boolean }) {
  const [open, setOpen] = useState(false)
  const kind = workKindOf(entry)
  const text = entry.kind !== 'tool' ? entry.text : kind === 'run' ? toolArg(entry) || toolName(entry) : entry.text
  return (
    <div className="relative pl-4">
      {/* The tree's guide: a rail down the side, an elbow into each row. */}
      {!last && <span className="absolute top-0 bottom-0 left-0 border-l" />}
      <span className="absolute top-0 left-0 h-[13px] w-2.5 rounded-bl-md border-b border-l" />
      <button
        type="button"
        onClick={() => output && setOpen(!open)}
        className={cn(
          'block w-full truncate py-[3px] text-left font-mono text-[12.5px] text-muted-foreground',
          output && 'hover:text-foreground',
          entry.isError && 'text-err',
        )}
        title={entry.text}
      >
        {text}
      </button>
      {open && output && (
        <pre
          className={cn(
            'selectable mb-1.5 max-h-60 overflow-auto rounded-md bg-muted/60 px-2.5 py-1.5 font-mono text-[11px] whitespace-pre-wrap break-all',
            output.isError ? 'text-err' : 'text-muted-foreground',
          )}
        >
          {output.text}
        </pre>
      )}
    </div>
  )
}
