import { useVirtualizer } from '@tanstack/react-virtual'
import { t } from '@shared/i18n'
import { ArrowDown, ChevronDown, ChevronUp, Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LogLine } from '@shared/types'
import { IconButton, Segmented } from '@/components/kit'
import { api, on } from '@/lib/api'
import { renderAnsi, stripAnsi } from '@/lib/ansi'
import { cx, plural } from '@/lib/format'

type Tab = 'all' | 'backend' | 'frontend' | 'dev'

/** Mirrors the main-process per-source cap, so the view never holds more than main does. */
const perSourceCap = 5000

interface Line extends LogLine {
  display: string
  /** ANSI-stripped and lowercased once, when the line arrives — what search matches on. */
  haystack: string
  severity?: 'error' | 'warn'
}

const toLine = (line: LogLine): Line => {
  const prefix = line.source ? `[${line.source}]` : ''
  let display = line.text
  if (prefix && display.startsWith(prefix)) display = display.slice(prefix.length).replace(/^ /, '')
  const haystack = stripAnsi(display).toLowerCase()
  return { ...line, display, haystack, severity: severityOf(haystack) }
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

const clock = (at: number): string =>
  new Date(at).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

/**
 * The console: source tabs, search with a match stepper, follow-the-tail with a jump-to-latest
 * button. Virtualised, because a busy branch holds fifteen thousand lines.
 */
export function LogPane({ branch }: { branch: string }) {
  const [lines, setLines] = useState<Line[]>([])
  const [tab, setTab] = useState<Tab>('all')
  const [query, setQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const [follow, setFollow] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    void api.logs(branch).then((initial) => alive && setLines(initial.map(toLine)))
    const off = on('logs', (payload) => {
      if (payload.branch !== branch) return
      setLines((current) => {
        const next = [...current, ...payload.lines.map(toLine)]
        return next.length > perSourceCap * 4 ? next.slice(next.length - perSourceCap * 4) : next
      })
    })
    return () => {
      alive = false
      off()
    }
  }, [branch])

  const shown = useMemo(() => (tab === 'all' ? lines : lines.filter((line) => line.source === tab)), [lines, tab])
  const counts = useMemo(() => {
    const result: Record<string, number> = {}
    for (const line of lines) if (line.source) result[line.source] = (result[line.source] ?? 0) + 1
    return result
  }, [lines])

  const needle = query.trim().toLowerCase()
  const matches = useMemo(
    () => (needle ? shown.flatMap((line, index) => (line.haystack.includes(needle) ? [index] : [])) : []),
    [shown, needle],
  )

  const virtual = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 18,
    overscan: 30,
  })

  // Follow the tail while the user is at the bottom.
  useEffect(() => {
    if (follow && shown.length) virtual.scrollToIndex(shown.length - 1, { align: 'end' })
  }, [shown.length, follow, virtual])

  const step = (delta: number) => {
    if (!matches.length) return
    const next = (matchIndex + delta + matches.length) % matches.length
    setMatchIndex(next)
    setFollow(false)
    virtual.scrollToIndex(matches[next], { align: 'center' })
  }

  const errors = useMemo(() => shown.reduce((n, line) => n + (line.severity === 'error' ? 1 : 0), 0), [shown])

  const tabs: { value: Tab; label: React.ReactNode }[] = [
    { value: 'all', label: t('全部') },
    ...(['backend', 'frontend', 'dev'] as const)
      .filter((source) => counts[source])
      .map((source) => ({
        value: source,
        label: (
          <span className="flex items-center gap-1">
            {source}
            <span className="hidden text-[10px] text-muted-foreground tabular-nums @md:inline">{counts[source]}</span>
          </span>
        ),
      })),
  ]

  return (
    <div className="flex h-full flex-col">
      {/* Narrow pane: counts drop first, then the search shrinks, then the tabs scroll. Nothing spills out. */}
      <div className="@container flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-3">
        <div className="min-w-0 shrink overflow-x-auto [scrollbar-width:none]">
          <Segmented value={tab} options={tabs} onChange={setTab} className="w-max" />
        </div>
        {errors > 0 && (
          <button
            type="button"
            className="shrink-0 rounded-md bg-err-soft px-2 py-0.5 text-[11.5px] font-medium whitespace-nowrap text-err"
            title={t('跳到第一个错误')}
            onClick={() => {
              const index = shown.findIndex((line) => line.severity === 'error')
              if (index >= 0) {
                setFollow(false)
                virtual.scrollToIndex(index, { align: 'center' })
              }
            }}
          >
            <span className="@md:hidden">{errors}</span>
            <span className="hidden @md:inline">{plural(t('{n} 个错误', { n: errors }))}</span>
          </button>
        )}
        <div className="min-w-2 flex-1" />
        {/* The search gives way first when the pane is narrow. */}
        <div className="flex h-[26px] w-56 min-w-20 shrink items-center gap-1.5 rounded-md bg-fill px-2">
          <Search className="size-3.5 text-fg-3" />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setMatchIndex(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') step(event.shiftKey ? -1 : 1)
              if (event.key === 'Escape') setQuery('')
            }}
            placeholder={t('搜索日志')}
            className="selectable w-full bg-transparent text-[12px] outline-none placeholder:text-fg-3"
          />
          {needle && (
            <span className="text-[11px] whitespace-nowrap text-fg-3 tabular-nums">
              {matches.length ? `${matchIndex + 1}/${matches.length}` : '0'}
            </span>
          )}
        </div>
        {needle && (
          <>
            <IconButton label={t('上一个 (⇧⏎)')} onClick={() => step(-1)} disabled={!matches.length}>
              <ChevronUp className="size-4" />
            </IconButton>
            <IconButton label={t('下一个 (⏎)')} onClick={() => step(1)} disabled={!matches.length}>
              <ChevronDown className="size-4" />
            </IconButton>
          </>
        )}
        <IconButton
          label={t('清空日志')}
          onClick={() => {
            void api.clearLogs(branch)
            setLines([])
          }}
        >
          <Trash2 className="size-3.5" />
        </IconButton>
      </div>

      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget
          setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 40)
        }}
        className="selectable relative min-h-0 flex-1 overflow-auto bg-log py-1.5 font-mono text-[11.5px] leading-[19px] text-log-fg"
      >
        {shown.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 font-sans text-[12.5px] text-muted-foreground">
            <span>{t('还没有输出')}</span>
            <span className="text-[11.5px] opacity-70">{t('启动分支后，dev server 的日志会实时出现在这里')}</span>
          </div>
        ) : (
          <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
            {virtual.getVirtualItems().map((item) => {
              const line = shown[item.index]
              const current = matches[matchIndex] === item.index
              return (
                <div
                  key={line.id}
                  data-index={item.index}
                  ref={virtual.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${item.start}px)` }}
                  className={cx(
                    'group flex gap-3 pr-4 pl-3 whitespace-pre-wrap hover:bg-foreground/[0.04]',
                    line.severity === 'error' && 'bg-err-soft',
                    line.severity === 'warn' && 'bg-warn/10',
                    current && 'bg-yellow-300/25',
                  )}
                >
                  <span className="w-[52px] shrink-0 text-log-dim tabular-nums opacity-60 group-hover:opacity-100">{clock(line.at)}</span>
                  {tab === 'all' && (
                    <span className={cx('w-6 shrink-0 text-right text-[10.5px]', line.source ? sourceColor[line.source] : '')}>
                      {line.source ? sourceShort[line.source] : ''}
                    </span>
                  )}
                  <span className="min-w-0 break-all">{renderAnsi(line.display, needle || undefined)}</span>
                </div>
              )
            })}
          </div>
        )}
        {!follow && (
          <button
            type="button"
            onClick={() => setFollow(true)}
            className="sticky bottom-3 left-full mr-3 flex items-center gap-1 rounded-full bg-brand px-3 py-1 font-sans text-[12px] text-white shadow-lg"
          >
            <ArrowDown className="size-3.5" />
            {t('最新输出')}
          </button>
        )}
      </div>
    </div>
  )
}
