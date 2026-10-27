import { ArrowUpToLine, ChevronRight, GripVertical, Minus, Pause, Play, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { IssueRun } from '@shared/types'
import { isActivePhase } from '@shared/types'
import { t } from '@shared/i18n'
import { SectionSwitcher } from '@/components/SectionSwitcher'
import { Button, StatusDot } from '@/components/kit'
import { api } from '@/lib/api'
import { cx } from '@/lib/format'
import { useApp } from '@/store/app'
import { useIssues } from '@/store/issues'
import { PhaseBadge } from './IssueSidebar'

const inFlight = (run: IssueRun): boolean => (isActivePhase(run.phase) && run.phase !== 'queued') || run.phase === 'paused'

/** In the issue sidebar's foot: where the queue stands, and the way into its own tab. */
export function QueueBar() {
  const queue = useIssues((s) => s.queue)
  const runs = useIssues((s) => s.runs)
  const setApp = useApp((s) => s.set)
  if (!Object.values(runs).some(inFlight) && !queue.waiting.length) return null
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-t border-border bg-fill px-3 text-[11.5px] font-medium text-fg-2">
      <QueueStatus />
      <button
        type="button"
        title={t('打开任务队列')}
        aria-label={t('打开任务队列')}
        onClick={() => setApp({ section: 'queue' })}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-2 hover:bg-foreground/[0.07] hover:text-fg"
      >
        <ChevronRight className="size-3.5" />
      </button>
    </div>
  )
}

/** Paused, or how many run of how many may — with the button that resumes a paused queue. */
function QueueStatus() {
  const queue = useIssues((s) => s.queue)
  const runs = useIssues((s) => s.runs)
  const perform = useIssues((s) => s.perform)
  const pausedCount = Object.values(runs).filter((run) => run.phase === 'paused').length

  if (queue.paused)
    return (
      <>
        <Pause className="size-3.5 text-warn" />
        <span className="flex-1 truncate">{t('队列已暂停')}</span>
        <Button
          tone="accent"
          className="h-6 px-2 text-[11px]"
          icon={<Play className="size-3" />}
          onClick={() => void perform(() => api.resumeQueue())}
        >
          {t('全部继续')}
        </Button>
      </>
    )
  return (
    <>
      {queue.running.length > 0 && (
        <>
          <StatusDot color="bg-agent" pulse />
          <span className="truncate">{t('运行 {n}/{max}', { n: queue.running.length, max: queue.concurrency })}</span>
        </>
      )}
      {pausedCount > 0 && <span className="shrink-0 text-warn">{t('{n} 个已暂停', { n: pausedCount })}</span>}
      <div className="flex-1" />
      {queue.waiting.length > 0 && <span className="shrink-0">{t('排队 {n}', { n: queue.waiting.length })}</span>}
    </>
  )
}

/**
 * The queue as a download manager, a sidebar tab of its own: every running, paused and waiting
 * issue — pause or stop each, or all, and drag the waiting ones into order. The issue opens beside it.
 */
export function QueueSidebar() {
  const runs = useIssues((s) => s.runs)
  const queue = useIssues((s) => s.queue)
  const running = Object.values(runs)
    .filter(inFlight)
    .sort((a, b) => a.createdAt - b.createdAt)
  const empty = !running.length && !queue.waiting.length
  return (
    <>
      <div className="drag h-[38px] shrink-0" />
      <SectionSwitcher />
      {empty ? (
        <div className="flex-1 px-6 py-12 text-center text-[12.5px] text-fg-2">
          <div className="font-medium text-fg">{t('队列是空的')}</div>
          <div className="mt-1 text-fg-3">{t('在 Issues 里点“自动修复”，或勾选多个后“批量修复”')}</div>
        </div>
      ) : (
        <QueueList running={running} />
      )}
    </>
  )
}

function QueueList({ running }: { running: IssueRun[] }) {
  const queue = useIssues((s) => s.queue)
  const runs = useIssues((s) => s.runs)
  const perform = useIssues((s) => s.perform)
  const select = useIssues((s) => s.select)
  const issues = useIssues((s) => s.issues)
  const updateConfig = useIssues((s) => s.updateConfig)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [dragged, setDragged] = useState<string | null>(null)
  const [over, setOver] = useState<number | null>(null)

  // "全部取消" asks once: a second click within a few seconds.
  useEffect(() => {
    if (!confirmCancel) return
    const timer = setTimeout(() => setConfirmCancel(false), 3000)
    return () => clearTimeout(timer)
  }, [confirmCancel])

  const canPause = running.some((run) => run.phase !== 'paused')
  const moveTo = (id: string, index: number) => {
    const rest = queue.waiting.filter((candidate) => candidate !== id)
    rest.splice(Math.min(index, rest.length), 0, id)
    void perform(() => api.reorderQueue(rest))
  }

  return (
    <div className="mt-2 min-h-0 flex-1 overflow-y-auto pb-2 text-[12px]">
      <div className="sticky top-0 z-10 border-b border-border/70 bg-sidebar px-3 pb-1.5">
        <div className="flex h-8 items-center gap-1">
          <span className="font-semibold text-fg">{t('任务队列')}</span>
          <div className="flex-1" />
          {queue.paused ? (
            <PanelAction primary icon={<Play className="size-3" />} onClick={() => void perform(() => api.resumeQueue())}>
              {t('全部继续')}
            </PanelAction>
          ) : (
            <PanelAction
              icon={<Pause className="size-3" />}
              disabled={!canPause && !queue.waiting.length}
              title={t('暂停正在跑的，并且不再从队列里取新的')}
              onClick={() => void perform(() => api.pauseQueue())}
            >
              {t('全部暂停')}
            </PanelAction>
          )}
          <PanelAction
            icon={<X className="size-3" />}
            danger
            title={t('停止正在跑的，清空排队')}
            onClick={() => {
              if (!confirmCancel) return setConfirmCancel(true)
              setConfirmCancel(false)
              void perform(() => api.cancelQueue())
            }}
          >
            {confirmCancel ? t('再点一次确认') : t('全部取消')}
          </PanelAction>
        </div>
        <div className="flex items-center gap-1.5 text-[11.5px] text-fg-2">
          {queue.paused ? (
            <>
              <Pause className="size-3 shrink-0 text-warn" />
              <span className="truncate">{t('已暂停：正在跑的停下了，排队的不会开始')}</span>
            </>
          ) : (
            <>
              {queue.running.length > 0 && <StatusDot color="bg-agent" pulse />}
              <span className="truncate">
                {t('运行 {n}/{max}，空出来就补上排队的下一个', { n: queue.running.length, max: queue.concurrency })}
              </span>
            </>
          )}
          <div className="flex-1" />
          <span className="flex shrink-0 items-center gap-0.5" title={t('最多同时跑几个')}>
            <RowButton
              label={t('少跑一个')}
              disabled={queue.concurrency <= 1}
              onClick={() => void updateConfig({ batchSize: queue.concurrency - 1 })}
            >
              <Minus className="size-3" />
            </RowButton>
            <span className="w-4 text-center tabular-nums">{queue.concurrency}</span>
            <RowButton
              label={t('多跑一个')}
              disabled={queue.concurrency >= 10}
              onClick={() => void updateConfig({ batchSize: queue.concurrency + 1 })}
            >
              <Plus className="size-3" />
            </RowButton>
          </span>
        </div>
      </div>

      <SectionTitle>{t('进行中 {n}', { n: running.length })}</SectionTitle>
      {running.length === 0 && <div className="px-3 py-1 text-fg-3">{t('没有在跑的任务')}</div>}
      {running.map((run) => (
        <QueueRow key={run.recordId} run={run} onOpen={() => select(new Set([run.recordId]))}>
          <PhaseBadge phase={run.phase} />
          {run.phase === 'paused' ? (
            <RowButton label={t('继续')} onClick={() => void perform(() => api.resumeIssue(run.recordId))}>
              <Play className="size-3" />
            </RowButton>
          ) : (
            <RowButton label={t('暂停')} onClick={() => void perform(() => api.pauseIssue(run.recordId))}>
              <Pause className="size-3" />
            </RowButton>
          )}
          <RowButton label={t('停止')} danger onClick={() => void perform(() => api.cancelIssue(run.recordId))}>
            <X className="size-3" />
          </RowButton>
        </QueueRow>
      ))}

      {queue.waiting.length > 0 && (
        <>
          <SectionTitle hint={t('拖动调整顺序')}>{t('排队 {n}', { n: queue.waiting.length })}</SectionTitle>
          {queue.waiting.map((id, index) => {
            const run = runs[id]
            if (!run) return null
            return (
              <QueueRow
                key={id}
                run={run}
                onOpen={() => select(new Set([id]))}
                draggable
                dropBefore={over === index && dragged !== id}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move'
                  setDragged(id)
                }}
                onDragOver={(event) => {
                  if (!dragged) return
                  event.preventDefault()
                  setOver(index)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  if (dragged && dragged !== id) moveTo(dragged, queue.waiting.filter((candidate) => candidate !== dragged).indexOf(id))
                  setDragged(null)
                  setOver(null)
                }}
                onDragEnd={() => {
                  setDragged(null)
                  setOver(null)
                }}
                lead={
                  <span className="flex w-7 shrink-0 cursor-grab items-center gap-0.5 text-fg-3 tabular-nums">
                    <GripVertical className="size-3" />
                    {index + 1}
                  </span>
                }
              >
                <RowButton
                  label={t('立即开始')}
                  disabled={!issues.some((issue) => issue.id === id)}
                  onClick={() => {
                    const issue = issues.find((candidate) => candidate.id === id)
                    if (issue) void perform(() => api.fixNow(issue))
                  }}
                >
                  <Play className="size-3" />
                </RowButton>
                <RowButton label={t('移到最前')} disabled={index === 0} onClick={() => moveTo(id, 0)}>
                  <ArrowUpToLine className="size-3" />
                </RowButton>
                <RowButton label={t('移出队列')} danger onClick={() => void perform(() => api.cancelIssue(id))}>
                  <X className="size-3" />
                </RowButton>
              </QueueRow>
            )
          })}
        </>
      )}
    </div>
  )
}

function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-center px-3 pt-2 pb-0.5 text-[10.5px] font-semibold tracking-wide text-fg-3">
      <span>{children}</span>
      <div className="flex-1" />
      {hint && <span className="font-normal">{hint}</span>}
    </div>
  )
}

function QueueRow({
  run,
  onOpen,
  lead,
  dropBefore,
  children,
  ...drag
}: {
  run: IssueRun
  onOpen: () => void
  lead?: React.ReactNode
  dropBefore?: boolean
  children: React.ReactNode
} & Pick<React.HTMLAttributes<HTMLDivElement>, 'draggable' | 'onDragStart' | 'onDragOver' | 'onDrop' | 'onDragEnd'>) {
  return (
    <div
      {...drag}
      className={cx(
        'group mx-1 flex h-7 items-center gap-1.5 rounded-md px-2 hover:bg-foreground/[0.05]',
        dropBefore && 'shadow-[inset_0_2px_0_var(--brand)]',
      )}
    >
      {lead}
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={run.title}>
        <span className="shrink-0 font-mono text-[11px] text-fg-3">{run.issueKey}</span>
        <span className="truncate text-fg">{run.title}</span>
      </button>
      <span className="flex shrink-0 items-center gap-0.5">{children}</span>
    </div>
  )
}

function RowButton({
  label,
  danger,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; danger?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      {...props}
      className={cx(
        'flex size-5 items-center justify-center rounded text-fg-3 hover:bg-foreground/[0.08] disabled:opacity-30',
        danger ? 'hover:text-err' : 'hover:text-fg',
      )}
    >
      {children}
    </button>
  )
}

function PanelAction({
  icon,
  danger,
  primary,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: React.ReactNode; danger?: boolean; primary?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        'inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] disabled:opacity-40',
        primary ? 'font-medium text-brand hover:bg-brand-soft' : 'text-fg-2 hover:bg-foreground/[0.07]',
        danger ? 'hover:text-err' : !primary && 'hover:text-fg',
      )}
    >
      {icon}
      {children}
    </button>
  )
}
