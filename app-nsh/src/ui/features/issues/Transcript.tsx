import { type JSX, Scroll, type ScrollEvent, type ScrollRef, Text, View, cleanup, effect, signal } from 'nsh'
import { Clipboard } from 'nsh'
import { t } from '../../../shared/i18n'
import type { BackgroundTask, ConversationEntry, EntryChannel } from '../../../shared/types'
import { Icon, type IconName } from '../../components/Icon'
import { Markdown } from '../../components/Markdown'
import { plural } from '../../lib/format'
import { cn } from '../../lib/utils'
import { ClaudeMark, catalogStore, modelDisplayName } from './AgentPickers'
import { WithAttachments } from './Attachments'

/**
 * The conversation, laid out the way MonoCode does it: each turn is your message, a
 * "Opus 5.5 working for 26s" line while the agent works (its tool calls as a live tree), then —
 * once it settles — a "worked for 7m 34s" fold over all that work, the final answer, and a footer
 * with copy, cost and time.
 */

/** Each `Agent` call's own steps, by its tool-use id: they show under that call, not among the agent's. */
export type Subagents = Map<string, ConversationEntry[]>

export type Item =
  | { kind: 'user' | 'assistant' | 'review' | 'error' | 'result' | 'task'; entry: ConversationEntry }
  | { kind: 'work'; id: string; steps: ConversationEntry[]; live: boolean; channel: EntryChannel; subagents: Subagents }

export const itemId = (item: Item): string => (item.kind === 'work' ? item.id : item.entry.id)

/** Main writes "会话已连接 · <model>" (or its English form) when a session starts. */
const CONNECTED = /^(?:会话已连接|Session connected) · / // i18n-ignore: parses main's output in either language

/** The model a "session connected" line names: the structured field, or parsed from older transcripts. */
const connectedModel = (entry: ConversationEntry): string | undefined =>
  entry.kind !== 'system' ? undefined : (entry.connectedModel ?? (CONNECTED.test(entry.text) ? entry.text.replace(CONNECTED, '') : undefined))

/** Fold every run of tool calls, tool output and progress lines into one `work` item. */
export function buildItems(entries: ConversationEntry[], live: boolean, subagents: Subagents = new Map()): Item[] {
  const items: Item[] = []
  let pending: ConversationEntry[] = []
  const flush = () => {
    if (pending.length) items.push({ kind: 'work', id: pending[0].id, steps: pending, live: false, channel: pending[0].channel, subagents })
    pending = []
  }
  for (const entry of entries) {
    // "Session connected" only names the model, which the turn header already shows.
    if (connectedModel(entry) !== undefined) continue
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
  /** A background task that finished and woke the agent, when it — not you — started the turn. */
  wake?: ConversationEntry
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

/**
 * Split the transcript at each of your messages, and where a finished background task wakes the
 * agent after its turn; within a turn, the agent's result settles it.
 */
export function buildTurns(entries: ConversationEntry[], live: boolean): Turn[] {
  const turns: Turn[] = []
  const segments: ConversationEntry[][] = []
  const subagents: Subagents = new Map()
  let current: ConversationEntry[] = []
  for (const entry of entries) {
    if (entry.parentToolUseId) {
      subagents.set(entry.parentToolUseId, [...(subagents.get(entry.parentToolUseId) ?? []), entry])
      continue
    }
    const settled = current.some((other) => other.kind === 'result' && other.channel === 'agent')
    if ((entry.kind === 'user' || (entry.kind === 'task' && settled)) && current.length) {
      segments.push(current)
      current = []
    }
    current.push(entry)
  }
  if (current.length) segments.push(current)
  segments.forEach((segment, index) => {
    const user = segment[0].kind === 'user' ? segment[0] : undefined
    const wake = segment[0].kind === 'task' && index > 0 ? segment[0] : undefined
    const body = user || wake ? segment.slice(1) : segment
    const resultAt = body.findIndex((entry) => entry.kind === 'result' && entry.channel === 'agent')
    const before = resultAt < 0 ? body : body.slice(0, resultAt)
    const model = before.map(connectedModel).find((name) => name !== undefined)
    const isLast = index === segments.length - 1
    const turn: Turn = {
      id: segment[0].id,
      user,
      wake,
      work: buildItems(before, live && isLast && resultAt < 0, subagents),
      result: resultAt < 0 ? undefined : body[resultAt],
      after: resultAt < 0 ? [] : buildItems(body.slice(resultAt + 1), live && isLast, subagents),
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

// MARK: - Scrolling

/**
 * Scrolling the way Claude's apps do it: the view follows the bottom while you are there, and a
 * message you send brings you back down however far up you'd scrolled. `change` names what
 * grew: when it changes and the view is pinned, it scrolls to the end.
 */
export function TranscriptScroll(props: { change: string; sent?: string; children: JSX.Element }) {
  let scroll: ScrollRef | undefined
  let pinned = true
  effect(() => {
    props.change
    if (pinned) scroll?.scrollToEnd({ animated: false })
  })
  effect(() => {
    if (props.sent) {
      pinned = true
      scroll?.scrollToEnd({ animated: false })
    }
  })
  const onScroll = (e: ScrollEvent) => {
    pinned = e.contentSize.height - e.offset.y - e.size.height < 60
  }
  return (
    <Scroll ref={(node) => (scroll = node)} class="min-h-0 flex-1" contentClass="items-center" onScroll={onScroll}>
      <View class="w-full max-w-[760px] gap-5 px-6 py-6">{props.children}</View>
    </Scroll>
  )
}

// MARK: - Turn

export function TurnView(props: { turn: Turn; layout: 'document' | 'chat'; renderItem: (item: Item) => JSX.Element }) {
  const open = signal(false)
  const model = () => (props.turn.model ? modelDisplayName(props.turn.model, catalogStore.catalog()) : undefined)
  const endedAt = () => props.turn.result?.at
  const render = (item: Item) => (item.kind === 'task' ? <TaskNotice entry={item.entry} /> : props.renderItem(item))
  const duration = () => (endedAt() && props.turn.startedAt ? (endedAt() as number) - props.turn.startedAt : null)
  return (
    <View class="gap-4">
      <If when={props.turn.user}>{(user) => <UserMessage entry={user()} layout={props.layout} />}</If>
      <If when={props.turn.wake}>{(wake) => <TaskNotice entry={wake()} />}</If>
      <If when={props.turn.live}>
        <WorkingLine startedAt={props.turn.startedAt} model={model()} />
      </If>
      <If
        when={props.turn.result}
        else={
          <Each of={props.turn.work} key={itemId}>
            {(item) => <View>{render(item())}</View>}
          </Each>
        }
      >
        <If
          when={props.turn.work.length > 0}
          else={
            <If when={endedAt()}>
              <View class="flex-row items-center gap-2">
                <ClaudeMark />
                <Text class="text-[13px] text-fg-2">{workedFor(model(), duration(), true)}</Text>
              </View>
            </If>
          }
        >
          {/* Only a turn that did work in between has anything to unfold. */}
          <View class="flex-row items-center gap-2 self-start" role="button" onPress={() => open.set(!open())}>
            <ClaudeMark />
            <Text class="text-[13px] text-fg-2">{workedFor(model(), duration(), true)}</Text>
            <Icon name={open() ? 'chevron-down' : 'chevron-right'} size={14} tint="fg-3" />
          </View>
        </If>
        <If when={open()}>
          <View class="gap-4 border-l border-border pl-4">
            <Each of={props.turn.work} key={itemId}>
              {(item) => <View>{render(item())}</View>}
            </Each>
          </View>
        </If>
        <If when={props.turn.answer}>{(answer) => <Markdown text={answer().text} class="text-[14px] leading-[1.65] text-fg" />}</If>
        <If when={props.turn.result}>{(result) => <TurnFooter answer={props.turn.answer} result={result()} />}</If>
      </If>
      <Each of={props.turn.after} key={itemId}>
        {(item) => <View>{render(item())}</View>}
      </Each>
    </View>
  )
}

/** A background task the agent left running has finished: what it reported, which the agent now picks up. */
function TaskNotice(props: { entry: ConversationEntry }) {
  const open = signal(false)
  const task = () => props.entry.task
  const title = () => (task()?.kind === 'agent' ? t('后台子 agent 结束') : task()?.kind === 'command' ? t('后台命令结束') : t('后台任务结束'))
  const status = () => ({ completed: undefined, failed: t('失败'), stopped: t('已停止') })[task()?.status ?? 'completed']
  const long = () => props.entry.text.length > 160 || props.entry.text.includes('\n')
  return (
    <View>
      <View class="max-w-full flex-row items-center gap-2" role="button" onPress={() => long() && open.set(!open())}>
        <Icon name="bell-ring" size={14} tint={props.entry.isError ? 'err' : 'fg-2'} />
        <Text class="shrink-0 text-[13px] text-fg-2">{status() ? `${title()} · ${status()}` : title()}</Text>
        <If when={task()?.description}>
          <Text class="text-[13px] text-fg-3" style={{ numberOfLines: 1 }}>
            {task()?.description}
          </Text>
        </If>
        <If when={long()}>
          <Icon name={open() ? 'chevron-up' : 'chevron-down'} size={14} tint="fg-3" />
        </If>
      </View>
      <If when={(open() || !long()) && props.entry.text !== task()?.description}>
        <Text class="mt-1 ml-[22px] text-[12.5px] text-fg-2" style={{ userSelect: 'text' }}>
          {props.entry.text}
        </Text>
      </If>
    </View>
  )
}

function UserMessage(props: { entry: ConversationEntry; layout: 'document' | 'chat' }) {
  const expanded = signal(false)
  const attachments = () => props.entry.attachments ?? []
  const long = () => !attachments().length && (props.entry.text.length > 280 || props.entry.text.split('\n').length > 4)
  const body = () => (
    <>
      <If when={attachments().length > 0} else={<Text class="text-[13.5px] leading-relaxed text-fg" style={{ userSelect: 'text', numberOfLines: long() && !expanded() ? 4 : undefined }}>{props.entry.text}</Text>}>
        <WithAttachments text={props.entry.text} attachments={attachments()} />
      </If>
      <If when={long()}>
        <View class="mt-1 self-start" role="button" onPress={() => expanded.set(!expanded())}>
          <Text class="text-[12px] text-fg-2">{expanded() ? t('收起') : t('展开')}</Text>
        </View>
      </If>
    </>
  )
  return (
    <If when={props.layout === 'chat'} else={<View class="rounded-lg border border-brand/20 bg-brand-soft px-4 py-2.5">{body()}</View>}>
      <View class="flex-row justify-end pl-16">
        <View class="max-w-[80%] rounded-2xl rounded-br-md bg-muted px-3.5 py-2">{body()}</View>
      </View>
    </If>
  )
}

function WorkingLine(props: { startedAt: number; model?: string }) {
  const now = signal(Date.now())
  effect(() => {
    const timer = setInterval(() => now.set(Date.now()), 1000)
    cleanup(() => clearInterval(timer))
  })
  return (
    <View class="flex-row items-center gap-2">
      <ClaudeMark />
      <Text class="text-[13px] text-fg-2">{workedFor(props.model, props.startedAt ? now() - props.startedAt : null, false)}</Text>
    </View>
  )
}

function workedFor(model: string | undefined, ms: number | null, done: boolean): string {
  if (ms == null || ms <= 0) {
    if (done) return model ? t('{model} 工作完成', { model }) : t('工作完成')
    return model ? t('{model} 工作中…', { model }) : t('工作中…')
  }
  const seconds = Math.max(1, Math.round(ms / 1000))
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60 ? ` ${seconds % 60}s` : ''}`
  if (done) return model ? t('{model} 工作了 {elapsed}', { model, elapsed }) : t('工作了 {elapsed}', { elapsed })
  return model ? t('{model} 已工作 {elapsed}', { model, elapsed }) : t('已工作 {elapsed}', { elapsed })
}

/** Copy, then what the turn cost and when it landed. Parsed from "完成 · 58 轮 · 454s · $2.32" or "Done · 58 turns · …". */
function TurnFooter(props: { answer?: ConversationEntry; result: ConversationEntry }) {
  const copied = signal(false)
  // Structured stats when main recorded them; older transcripts only have the text.
  const turns = () => props.result.stats?.turns ?? /(\d+) (?:轮|turns?)\b/.exec(props.result.text)?.[1] // i18n-ignore: parses main's output in either language
  const cost = () => (props.result.stats ? `$${props.result.stats.costUSD.toFixed(2)}` : /\$[\d.]+/.exec(props.result.text)?.[0])
  const time = () => new Date(props.result.at ?? Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return (
    <View class="-mt-1 flex-row items-center gap-1">
      <If when={props.answer}>
        {(answer) => (
          <View
            class="size-6 items-center justify-center rounded-md hover:bg-accent"
            role="button"
            tooltip={t('复制回答')}
            onPress={() => {
              void Clipboard.writeText(answer().text)
              copied.set(true)
              setTimeout(() => copied.set(false), 1200)
            }}
          >
            <Icon name={copied() ? 'check' : 'copy'} size={14} tint="fg-2" />
          </View>
        )}
      </If>
      <If when={props.result.isError}>
        <View class="flex-row items-center gap-1">
          <Icon name="circle-alert" size={12} tint="err" />
          <Text class="text-[12px] text-err">{t('出错结束')}</Text>
        </View>
      </If>
      <Text class="px-1 text-[12px] text-fg-2 tabular-nums">{[turns() && plural(t('{n} 轮', { n: turns() as string })), cost(), time()].filter(Boolean).join(' · ')}</Text>
    </View>
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

const kindIcon: Record<WorkKind, IconName> = {
  read: 'file-search',
  search: 'search',
  edit: 'file-pen',
  run: 'terminal',
  agent: 'users',
  setup: 'settings-2',
  other: 'wrench',
}

/** One clause per kind, present tense while live: "Running 3 commands" → "Ran 3 commands · Read 2 files". */
function clause(kind: WorkKind, n: number, live: boolean): string {
  const vars = { n }
  const [doing, done] = {
    read: [t('正在查看 {n} 个文件', vars), t('查看了 {n} 个文件', vars)],
    search: [t('正在搜索 {n} 次项目', vars), t('搜索了 {n} 次项目', vars)],
    edit: [t('正在编辑 {n} 个文件', vars), t('编辑了 {n} 个文件', vars)],
    run: [t('正在运行 {n} 条命令', vars), t('运行了 {n} 条命令', vars)],
    agent: [t('正在运行 {n} 个子 agent', vars), t('运行了 {n} 个子 agent', vars)],
    setup: [t('正在准备 {n} 个步骤', vars), t('完成了 {n} 个步骤', vars)],
    other: [t('正在使用 {n} 个工具', vars), t('使用了 {n} 个工具', vars)],
  }[kind]
  return plural(live ? doing : done)
}

/** A stretch of tool calls: a summary line, and while live (or opened) the calls as a tree. */
export function ActivityGroup(props: { steps: ConversationEntry[]; live: boolean; review: boolean; subagents?: Subagents }) {
  const open = signal(false)
  const calls = () => props.steps.filter((step) => step.kind === 'tool')
  const order = () => {
    const counts = new Map<WorkKind, number>()
    for (const call of calls()) counts.set(workKindOf(call), (counts.get(workKindOf(call)) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1])
  }
  const dominant = (): WorkKind => order()[0]?.[0] ?? 'setup'
  const latest = () => calls()[calls().length - 1]
  const summary = () =>
    calls().length
      ? order()
          .map(([kind, n]) => clause(kind, n, props.live && latest() !== undefined && workKindOf(latest()) === kind))
          .join(' · ')
      : (props.steps[props.steps.length - 1]?.text ?? '')
  const failed = () => props.steps.some((step) => step.isError)
  const expanded = () => props.live || open()
  // Setup lines (worktree progress) have no calls: the latest is the summary, the earlier ones the tree.
  const rows = () => (calls().length ? calls() : props.steps.slice(0, -1))
  const expandable = () => rows().length > 0
  const subagents = () => props.subagents ?? new Map<string, ConversationEntry[]>()
  return (
    <View>
      <View class="max-w-full flex-row items-center gap-2" role="button" disabled={props.live || !expandable()} onPress={() => open.set(!open())}>
        <Icon name={kindIcon[dominant()]} size={14} tint="fg-2" />
        <Text class="text-[13px] text-fg-2" style={{ numberOfLines: 1 }}>
          {props.review ? t('评审 · {summary}', { summary: summary() }) : summary()}
        </Text>
        <If when={failed() && !props.live}>
          <Icon name="circle-alert" size={12} tint="err" />
        </If>
        <If when={!props.live && expandable()}>
          <Icon name={open() ? 'chevron-up' : 'chevron-down'} size={14} tint="fg-3" />
        </If>
      </View>
      <If when={expanded() && expandable()}>
        <View class="mt-1.5 ml-[7px]">
          <Each of={rows()} key={(row) => row.id}>
            {(row, index) => (
              <TreeRow
                entry={row()}
                output={calls().length ? outputOf(props.steps, row()) : undefined}
                steps={row().toolUseId ? subagents().get(row().toolUseId as string) : undefined}
                live={props.live}
                last={index() === rows().length - 1}
              />
            )}
          </Each>
        </View>
      </If>
    </View>
  )
}

/**
 * What the agent left running after its turn, at the foot of the conversation the way Claude Code
 * shows it: a live summary over each command or subagent and how long it has been going.
 */
export function BackgroundActivity(props: { tasks: BackgroundTask[]; onStop: (taskId?: string) => void }) {
  const now = signal(Date.now())
  effect(() => {
    const timer = setInterval(() => now.set(Date.now()), 1000)
    cleanup(() => clearInterval(timer))
  })
  const commands = () => props.tasks.filter((task) => task.kind !== 'agent').length
  const agents = () => props.tasks.length - commands()
  const summary = () =>
    [commands() && plural(t('后台运行 {n} 条命令', { n: commands() })), agents() && plural(t('后台运行 {n} 个子 agent', { n: agents() }))].filter(Boolean).join(' · ')
  return (
    <View>
      <View class="max-w-full flex-row items-center gap-2" tooltip={t('结束后 agent 会接着处理')}>
        <ClaudeMark />
        <Text class="text-[13px] text-fg-2" style={{ numberOfLines: 1 }}>
          {summary()}
        </Text>
        <If when={props.tasks.length > 1}>
          <View class="shrink-0 rounded px-1.5 py-0.5 hover:bg-accent" role="button" onPress={() => props.onStop()}>
            <Text class="text-[11.5px] text-fg-2">{t('全部停止')}</Text>
          </View>
        </If>
      </View>
      <View class="mt-1.5 ml-[7px]">
        <Each of={props.tasks} key={(task) => task.id}>
          {(task, index) => (
            <View class="relative pl-4">
              <If when={index() < props.tasks.length - 1}>
                <View class="absolute top-0 bottom-0 left-0 border-l border-border" />
              </If>
              <View class="absolute top-0 left-0 h-[13px] w-2.5 rounded-bl-md border-b border-l border-border" />
              <View class="flex-row items-center gap-2 py-[3px]" tooltip={task().description}>
                <If when={task().kind === 'agent'}>
                  <Icon name="users" size={12} tint="fg-2" />
                </If>
                <Text class="min-w-0 flex-1 font-mono text-[12.5px] text-fg-2" style={{ numberOfLines: 1 }}>
                  {task().description}
                </Text>
                <Text class="shrink-0 text-[11px] text-fg-2 tabular-nums">{elapsed(now() - task().startedAt)}</Text>
                <View class="size-5 shrink-0 items-center justify-center rounded hover:bg-accent" role="button" tooltip={t('停止')} onPress={() => props.onStop(task().id)}>
                  <Icon name="square" size={10} tint="fg-2" />
                </View>
              </View>
            </View>
          )}
        </Each>
      </View>
    </View>
  )
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const outputOf = (steps: ConversationEntry[], call: ConversationEntry): ConversationEntry | undefined => {
  const next = steps[steps.indexOf(call) + 1]
  return next?.kind === 'toolResult' ? next : undefined
}

function TreeRow(props: { entry: ConversationEntry; output?: ConversationEntry; steps?: ConversationEntry[]; live?: boolean; last: boolean }) {
  const open = signal(false)
  const showSteps = signal(false)
  const calls = () => props.steps?.filter((step) => step.kind === 'tool') ?? []
  // While it works, its latest few; once done, all of them behind a toggle.
  const shownCalls = () => (showSteps() ? calls() : props.live ? calls().slice(-3) : [])
  const text = () => (props.entry.kind !== 'tool' ? props.entry.text : workKindOf(props.entry) === 'run' ? toolArg(props.entry) || toolName(props.entry) : props.entry.text)
  return (
    <View class="relative pl-4">
      {/* The tree's guide: a rail down the side, an elbow into each row. */}
      <If when={!props.last}>
        <View class="absolute top-0 bottom-0 left-0 border-l border-border" />
      </If>
      <View class="absolute top-0 left-0 h-[13px] w-2.5 rounded-bl-md border-b border-l border-border" />
      <View role="button" tooltip={props.entry.text} onPress={() => props.output && open.set(!open())}>
        <Text class={cn('py-[3px] font-mono text-[12.5px]', props.entry.isError ? 'text-err' : 'text-fg-2')} style={{ numberOfLines: 1 }}>
          {text()}
        </Text>
      </View>
      <If when={calls().length > 0}>
        <View class="mb-1 ml-1">
          <If when={!showSteps()}>
            <View role="button" onPress={() => showSteps.set(true)}>
              <Text class="py-[2px] text-[11.5px] text-fg-2">{plural(t('子 agent 的 {n} 个步骤', { n: calls().length }))}</Text>
            </View>
          </If>
          <Each of={shownCalls()} key={(call) => call.id}>
            {(call, index) => <TreeRow entry={call()} output={outputOf(props.steps ?? [], call())} last={index() === shownCalls().length - 1} />}
          </Each>
        </View>
      </If>
      <If when={open() ? props.output : undefined}>
        {(output) => (
          <Scroll class="mb-1.5 max-h-60 rounded-md bg-muted/60" contentClass="px-2.5 py-1.5">
            <Text class={cn('font-mono text-[11px]', output().isError ? 'text-err' : 'text-fg-2')} style={{ userSelect: 'text' }}>
              {output().text}
            </Text>
          </Scroll>
        )}
      </If>
    </View>
  )
}
