import { ArrowRight, ChevronRight, ExternalLink } from 'lucide-react'
import { useMemo, useState } from 'react'
import { t } from '@shared/i18n'
import type { ActivityItem } from '@shared/types'
import { cx } from '@/lib/format'
import { useApp } from '@/store/app'
import { useIssues } from '@/store/issues'
import { sourceName } from './parts'

/**
 * The feed as a pipeline: each event with where it went — filtered, straight to an agent, settled by a
 * rule, or to the router — and what came of it. Opened, it shows the full text, the router's own
 * account of its decision, and everything it did in answer.
 */

/** What an event went through, as the chip after the arrow says it. */
const routeLabel = (): Record<ActivityItem['outcome'], string> => ({
  ignored: t('过滤'),
  delivered: t('直达 agent'),
  routed: 'Router',
  action: t('规则处理'),
  replied: t('回复'),
  error: t('出错'),
})

const routeTone: Record<ActivityItem['outcome'], string> = {
  ignored: 'bg-fill text-fg-3',
  delivered: 'bg-agent-soft text-agent',
  routed: 'bg-brand-soft text-brand',
  action: 'bg-fill text-fg',
  replied: 'bg-fill text-fg',
  error: 'bg-err-soft text-err',
}

interface Entry {
  item: ActivityItem
  /** What the router did because of it. */
  actions: ActivityItem[]
}

/** Router actions sit under the event they answered; everything else is a line of its own. Newest first. */
function group(activity: ActivityItem[]): Entry[] {
  const byId = new Map<string, Entry>()
  const entries: Entry[] = []
  for (const item of activity) {
    const cause = item.source === 'router' ? item.causes?.find((id) => byId.has(id)) : undefined
    if (cause) {
      byId.get(cause)?.actions.push(item)
      continue
    }
    const entry = { item, actions: [] }
    byId.set(item.id, entry)
    entries.push(entry)
  }
  return entries.toReversed()
}

export function Pipeline({ activity, limit, showFiltered = true }: { activity: ActivityItem[]; limit?: number; showFiltered?: boolean }) {
  const entries = useMemo(() => {
    const grouped = group(activity).filter((entry) => showFiltered || entry.item.outcome !== 'ignored')
    return limit ? grouped.slice(0, limit) : grouped
  }, [activity, limit, showFiltered])
  if (!entries.length)
    return (
      <div className="px-4 py-10 text-center text-[12.5px] text-fg-2">{t('还没有动静。开启后，收到的消息和做过的事都会出现在这里。')}</div>
    )
  return (
    <ul className="divide-y divide-border/60">
      {entries.map((entry) => (
        <PipelineRow key={entry.item.id} entry={entry} />
      ))}
    </ul>
  )
}

function PipelineRow({ entry }: { entry: Entry }) {
  const [open, setOpen] = useState(false)
  const { item, actions } = entry
  const runs = useIssues((s) => s.runs)
  const task = item.recordId ? runs[item.recordId] : undefined
  const created = actions.find((action) => action.recordId)
  const taskKey = task?.issueKey ?? (created?.recordId ? runs[created.recordId]?.issueKey : undefined)
  const replied = actions.some((action) => action.outcome === 'replied')
  const outcome = item.decision ?? (taskKey ? taskKey : replied ? t('已回复') : item.detail)
  const labels = routeLabel()

  return (
    <li className={cx(item.outcome === 'ignored' && 'opacity-60')}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[12.5px] hover:bg-fill"
      >
        <span className="w-11 shrink-0 text-[11.5px] text-fg-3 tabular-nums">
          {new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
        <span className="w-28 shrink-0 truncate text-fg-2">
          <span className="font-medium text-fg">{sourceName(item.source)}</span>
          {item.author && <span> · {item.author}</span>}
        </span>
        <span className="min-w-0 flex-1 truncate">{item.text.replace(/\s+/g, ' ')}</span>
        <ArrowRight className="size-3 shrink-0 text-fg-3" />
        <span className={cx('shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium', routeTone[item.outcome])}>
          {labels[item.outcome]}
        </span>
        {outcome && <span className="max-w-48 shrink-0 truncate text-[11.5px] text-fg-2">{outcome}</span>}
        <ChevronRight className={cx('size-3.5 shrink-0 text-fg-3 transition-transform', open && 'rotate-90')} />
      </button>
      {open && <PipelineDetail entry={entry} />}
    </li>
  )
}

function PipelineDetail({ entry }: { entry: Entry }) {
  const { item, actions } = entry
  const recordIds = [...new Set([item.recordId, ...actions.map((action) => action.recordId)].filter((id): id is string => !!id))]
  return (
    <div className="mx-4 mb-3 ml-[4.25rem] space-y-2 border-l-2 border-border pl-3 text-[12.5px]">
      <DetailLine label={t('原文')}>
        <span className="selectable whitespace-pre-wrap break-words">{item.text}</span>
      </DetailLine>
      {item.thread && (
        <DetailLine label={t('会话')}>
          <span className="selectable font-mono text-[11.5px] text-fg-2">{item.thread}</span>
        </DetailLine>
      )}
      {item.detail && <DetailLine label={t('说明')}>{item.detail}</DetailLine>}
      {item.decision && <DetailLine label={t('Router 判断')}>{item.decision}</DetailLine>}
      {actions.map((action) => (
        <DetailLine key={action.id} label={action.outcome === 'replied' ? t('回复') : (action.detail ?? t('动作'))}>
          <span className="selectable whitespace-pre-wrap break-words">{action.text}</span>
        </DetailLine>
      ))}
      {recordIds.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {recordIds.map((id) => (
            <OpenIssue key={id} recordId={id} />
          ))}
        </div>
      )}
    </div>
  )
}

function DetailLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-20 shrink-0 text-fg-3">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}

/** Jump to the issue in the Issues section, with its conversation open. */
export function OpenIssue({ recordId }: { recordId: string }) {
  const run = useIssues((s) => s.runs[recordId])
  const select = useIssues((s) => s.select)
  const setApp = useApp((s) => s.set)
  return (
    <button
      type="button"
      onClick={() => {
        setApp({ section: 'issues' })
        select(new Set([recordId]))
      }}
      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] hover:bg-fill"
    >
      <ExternalLink className="size-3" />
      {t('打开 {key}', { key: run?.issueKey ?? recordId })}
    </button>
  )
}
