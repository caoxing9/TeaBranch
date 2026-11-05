import { ArrowUpRight } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { t } from '@shared/i18n'
import type { ActivityItem } from '@shared/types'
import { useApp } from '@/store/app'
import { useIssues } from '@/store/issues'
import { Markdown } from '../issues/Markdown'
import { WithAttachments } from '../issues/Transcript'
import { Spark } from './parts'

/**
 * The conversation with the router, from the activity on the app's thread: your messages on the
 * right, its replies on the left under its mark, and what it did in between as chips that open the
 * task. Worker reports and watchdog notes stay out — the router relays what matters, in words.
 */
export function RouterChat({ items, thinking }: { items: ActivityItem[]; thinking: boolean }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [items.length, thinking])
  return (
    <div className="flex flex-col gap-5">
      {items.map((item) => (
        <Line key={item.id} item={item} />
      ))}
      {thinking && (
        <div className="flex items-center gap-3 text-[13px]">
          <Spark className="size-4 shrink-0 text-brand" />
          <span className="shimmer">{t('Router 正在看…')}</span>
        </div>
      )}
      <div ref={end} />
    </div>
  )
}

/** What the router did, as the chip says it. */
function actionLabel(item: ActivityItem): string {
  const detail = item.detail ?? ''
  const label =
    detail === 'investigate'
      ? t('开始探查')
      : detail === 'create_task'
        ? t('建了任务')
        : detail.startsWith('send_to_task')
          ? t('转给了任务')
          : detail === 'fix_issue'
            ? t('开始修复')
            : detail
  return `${label} ${item.text}`.trim()
}

function Line({ item }: { item: ActivityItem }) {
  if (item.source === 'me')
    return (
      <div className="flex flex-col items-end gap-1.5 pl-16">
        <div className="selectable max-w-[85%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-[13.5px] leading-relaxed break-words whitespace-pre-wrap">
          {item.files?.length ? <WithAttachments text={item.text} attachments={item.files} /> : item.text}
        </div>
        {item.outcome === 'action' && <ActionChip label={item.detail ?? ''} recordId={item.recordId} />}
      </div>
    )
  if (item.source !== 'router') return null
  if (item.outcome === 'replied')
    return (
      <div className="flex gap-3 pr-10">
        <Spark className="mt-1 size-4 shrink-0 text-brand" />
        <div className="min-w-0 flex-1 text-[13.5px]">
          <Markdown text={item.text} />
        </div>
      </div>
    )
  if (item.outcome === 'action')
    return (
      <div className="pl-7">
        <ActionChip label={actionLabel(item)} recordId={item.recordId} />
      </div>
    )
  if (item.outcome === 'error')
    return <div className="pl-7 text-[12.5px] text-err">{t('Router 这一轮没跑完：{error}', { error: item.detail ?? '' })}</div>
  return null
}

/** A thing the router did; with a task behind it, a click opens that task's conversation. */
function ActionChip({ label, recordId }: { label: string; recordId?: string }) {
  const select = useIssues((s) => s.select)
  const setApp = useApp((s) => s.set)
  const open = () => {
    if (!recordId) return
    setApp({ section: 'issues' })
    select(new Set([recordId]))
  }
  return (
    <button
      type="button"
      onClick={open}
      disabled={!recordId}
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-[12px] text-fg-2 enabled:hover:border-border-strong enabled:hover:text-fg"
    >
      <span className="truncate">{label}</span>
      {recordId && <ArrowUpRight className="size-3 shrink-0" />}
    </button>
  )
}
