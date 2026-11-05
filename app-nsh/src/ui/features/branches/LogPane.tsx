import { type JSX, List, type ListRef, Text, View, cleanup, effect, signal } from 'nsh'
import { t } from '../../../shared/i18n'
import type { LogLine } from '../../../shared/types'
import { Icon } from '../../components/Icon'
import { IconButton, Segmented, TextInput } from '../../components/kit'
import { api, on } from '../../lib/api'
import { type AnsiSegment, parseAnsi, stripAnsi } from '../../lib/ansi'
import { plural } from '../../lib/format'
import { cn } from '../../lib/utils'

type Tab = 'all' | 'backend' | 'frontend' | 'dev'

/** Mirrors the services' per-source cap, so the view never holds more than they do. */
const perSourceCap = 5000

interface Line extends LogLine {
  display: string
  /** ANSI-stripped and lowercased once, when the line arrives — what search matches on. */
  haystack: string
  segments: AnsiSegment[]
  severity?: 'error' | 'warn'
}

const toLine = (line: LogLine): Line => {
  const prefix = line.source ? `[${line.source}]` : ''
  let display = line.text
  if (prefix && display.startsWith(prefix)) display = display.slice(prefix.length).replace(/^ /, '')
  const haystack = stripAnsi(display).toLowerCase()
  return { ...line, display, haystack, segments: parseAnsi(display), severity: severityOf(haystack) }
}

const sourceColor: Record<string, string> = {
  backend: 'text-log-backend',
  frontend: 'text-log-frontend',
  dev: 'text-muted-foreground',
}
const sourceShort: Record<string, string> = { backend: 'be', frontend: 'fe', dev: 'dev' }

/** How loud a line is, from its words — so failures stand out of a scrolling wall. */
const severityOf = (haystack: string): 'error' | 'warn' | undefined => {
  if (/\b(error|failed|fatal|exception|unhandled|eaddrinuse|⛔|err!)\b/.test(haystack)) return 'error'
  if (/\b(warn|warning|deprecated)\b/.test(haystack)) return 'warn'
  return undefined
}

const clock = (at: number): string => new Date(at).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

/**
 * The console: source tabs, search with a match stepper, follow-the-tail with a jump-to-latest
 * button. Virtualised, because a busy branch holds fifteen thousand lines.
 */
export function LogPane(props: { branch: string }) {
  const lines = signal<Line[]>([])
  const tab = signal<Tab>('all')
  const query = signal('')
  const matchIndex = signal(0)
  const follow = signal(true)
  let list: ListRef | undefined

  effect(() => {
    const branch = props.branch
    let alive = true
    lines.set([])
    void api.logs(branch).then((initial) => alive && lines.set(initial.map(toLine)))
    const off = on('logs', (payload) => {
      if (payload.branch !== branch) return
      const next = [...lines(), ...payload.lines.map(toLine)]
      lines.set(next.length > perSourceCap * 4 ? next.slice(next.length - perSourceCap * 4) : next)
    })
    cleanup(() => {
      alive = false
      off()
    })
  })

  const shown = () => (tab() === 'all' ? lines() : lines().filter((line) => line.source === tab()))
  const counts = () => {
    const result: Record<string, number> = {}
    for (const line of lines()) if (line.source) result[line.source] = (result[line.source] ?? 0) + 1
    return result
  }
  const needle = () => query().trim().toLowerCase()
  const matches = () => (needle() ? shown().flatMap((line, index) => (line.haystack.includes(needle()) ? [index] : [])) : [])
  const errors = () => shown().reduce((n, line) => n + (line.severity === 'error' ? 1 : 0), 0)

  // Follow the tail while the user is at the bottom.
  effect(() => {
    const count = shown().length
    if (follow() && count) list?.scrollToEnd({ animated: false })
  })

  const step = (delta: number) => {
    const all = matches()
    if (!all.length) return
    const next = (matchIndex() + delta + all.length) % all.length
    matchIndex.set(next)
    follow.set(false)
    list?.scrollToIndex({ index: all[next], animated: false, viewPosition: 0.5 })
  }

  const tabs = (): { value: Tab; label: JSX.Element }[] => [
    { value: 'all', label: t('全部') },
    ...(['backend', 'frontend', 'dev'] as const)
      .filter((source) => counts()[source])
      .map((source) => ({
        value: source,
        label: (
          <View class="flex-row items-center gap-1">
            <Text class={cn('text-[12px]', tab() === source ? 'font-medium text-fg' : 'text-fg-2')}>{source}</Text>
            <Text class="text-[10px] text-muted-foreground tabular-nums">{counts()[source]}</Text>
          </View>
        ),
      })),
  ]

  return (
    <View class="flex-1">
      <View class="h-9 shrink-0 flex-row items-center gap-1.5 border-b border-border px-3">
        <Segmented value={tab()} options={tabs()} onChange={(value) => tab.set(value)} />
        <If when={errors() > 0}>
          <View
            class="shrink-0 rounded-md bg-err-soft px-2 py-0.5"
            role="button"
            tooltip={t('跳到第一个错误')}
            onPress={() => {
              const index = shown().findIndex((line) => line.severity === 'error')
              if (index >= 0) {
                follow.set(false)
                list?.scrollToIndex({ index, animated: false, viewPosition: 0.5 })
              }
            }}
          >
            <Text class="text-[11.5px] font-medium text-err">{plural(t('{n} 个错误', { n: errors() }))}</Text>
          </View>
        </If>
        <View class="min-w-2 flex-1" />
        <View class="h-[26px] w-56 min-w-20 shrink flex-row items-center gap-1.5 rounded-md bg-fill px-2">
          <Icon name="search" size={14} tint="fg-3" />
          <TextInput
            value={query()}
            onChange={(e) => {
              query.set(e.value)
              matchIndex.set(0)
            }}
            onSubmit={() => step(1)}
            placeholder={t('搜索日志')}
            class="h-6 flex-1 border-0 bg-transparent px-0 text-[12px] shadow-none"
          />
          <If when={needle()}>
            <Text class="text-[11px] text-fg-3 tabular-nums">{matches().length ? `${matchIndex() + 1}/${matches().length}` : '0'}</Text>
          </If>
        </View>
        <If when={needle()}>
          <IconButton label={t('上一个 (⇧⏎)')} onPress={() => step(-1)} disabled={!matches().length}>
            <Icon name="chevron-up" size={16} tint="fg-2" />
          </IconButton>
          <IconButton label={t('下一个 (⏎)')} onPress={() => step(1)} disabled={!matches().length}>
            <Icon name="chevron-down" size={16} tint="fg-2" />
          </IconButton>
        </If>
        <IconButton
          label={t('清空日志')}
          onPress={() => {
            void api.clearLogs(props.branch)
            lines.set([])
          }}
        >
          <Icon name="trash-2" size={14} tint="fg-2" />
        </IconButton>
      </View>
      <View class="relative min-h-0 flex-1 bg-log">
        <If
          when={shown().length > 0}
          else={
            <View class="flex-1 items-center justify-center gap-1">
              <Text class="text-[12.5px] text-muted-foreground">{t('还没有输出')}</Text>
              <Text class="text-[11.5px] text-muted-foreground opacity-70">{t('启动分支后，dev server 的日志会实时出现在这里')}</Text>
            </View>
          }
        >
          <List
            ref={(node) => (list = node)}
            each={shown()}
            keyExtractor={(line) => String(line.id)}
            estimatedItemSize={19}
            class="flex-1 py-1.5"
            onScroll={(e) => follow.set(e.contentSize.height - e.offset.y - e.size.height < 40)}
          >
            {(line, index) => <LogRow line={line()} showSource={tab() === 'all'} needle={needle()} current={matches()[matchIndex()] === index()} />}
          </List>
        </If>
        <If when={!follow()}>
          <View class="absolute right-3 bottom-3 flex-row items-center gap-1 rounded-full bg-brand px-3 py-1 shadow-lg" role="button" onPress={() => follow.set(true)}>
            <Icon name="arrow-down" size={14} tint="#ffffff" />
            <Text class="text-[12px] text-white">{t('最新输出')}</Text>
          </View>
        </If>
      </View>
    </View>
  )
}

function LogRow(props: { line: Line; showSource: boolean; needle: string; current: boolean }) {
  return (
    <View
      class={cn(
        'flex-row gap-3 pr-4 pl-3 hover:bg-fill',
        props.line.severity === 'error' && 'bg-err-soft',
        props.line.severity === 'warn' && 'bg-warn/10',
        props.current && 'bg-yellow-300/25',
      )}
    >
      <Text class="w-[52px] shrink-0 font-mono text-[11.5px] leading-[19px] text-log-dim tabular-nums opacity-60">{clock(props.line.at)}</Text>
      <If when={props.showSource}>
        <Text class={cn('w-6 shrink-0 text-right font-mono text-[10.5px] leading-[19px]', props.line.source ? sourceColor[props.line.source] : '')}>
          {props.line.source ? sourceShort[props.line.source] : ''}
        </Text>
      </If>
      <Text class="min-w-0 flex-1 font-mono text-[11.5px] leading-[19px] text-log-fg" style={{ userSelect: 'text' }}>
        <Each of={props.line.segments} key="index">
          {(segment) => <AnsiText segment={segment()} needle={props.needle} />}
        </Each>
      </Text>
    </View>
  )
}

/** One run of styled text; the search hit inside it marked. */
function AnsiText(props: { segment: AnsiSegment; needle: string }) {
  const style = () => ({
    color: props.segment.fg,
    backgroundColor: props.segment.bg,
    fontWeight: props.segment.bold ? ('600' as const) : undefined,
    opacity: props.segment.dim ? 0.65 : undefined,
    fontStyle: props.segment.italic ? ('italic' as const) : undefined,
    textDecorationLine: props.segment.underline ? ('underline' as const) : undefined,
  })
  const pieces = () => {
    if (!props.needle) return [{ text: props.segment.text, hit: false }]
    const text = props.segment.text
    const lower = text.toLowerCase()
    const out: { text: string; hit: boolean }[] = []
    let from = 0
    for (let at = lower.indexOf(props.needle); at >= 0; at = lower.indexOf(props.needle, at + props.needle.length)) {
      if (at > from) out.push({ text: text.slice(from, at), hit: false })
      out.push({ text: text.slice(at, at + props.needle.length), hit: true })
      from = at + props.needle.length
    }
    if (from < text.length) out.push({ text: text.slice(from), hit: false })
    return out
  }
  return (
    <Text style={style()}>
      <Each of={pieces()} key="index">
        {(piece) => <Text class={piece().hit ? 'rounded-sm bg-yellow-300/70 text-black' : undefined}>{piece().text}</Text>}
      </Each>
    </Text>
  )
}
