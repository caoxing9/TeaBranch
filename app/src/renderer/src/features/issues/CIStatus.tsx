import { CircleCheck, CircleDashed, CircleMinus, CircleX, RefreshCw, Send } from 'lucide-react'
import { useState } from 'react'
import type { CheckBucket, Issue, IssueRun, PRChecks } from '@shared/types'
import { ciFailures, ciPending } from '@shared/ci'
import { t } from '@shared/i18n'
import { Button } from '@/components/kit'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { cx } from '@/lib/format'
import { useIssues } from '@/store/issues'

/**
 * The PR's CI where you already are: a mark by the PR that says pass / fail / running, opening into
 * every check with its link — and the failures handed to the agent without a trip to GitHub.
 */

type Overall = 'fail' | 'pending' | 'pass'

const overall = (ci: PRChecks): Overall => (ciFailures(ci).length ? 'fail' : ciPending(ci) ? 'pending' : 'pass')

const bucketIcon: Record<CheckBucket, React.ReactNode> = {
  fail: <CircleX className="size-3 shrink-0 text-err" />,
  pending: <CircleDashed className="size-3 shrink-0 animate-spin text-warn [animation-duration:3s]" />,
  pass: <CircleCheck className="size-3 shrink-0 text-ok" />,
  skip: <CircleMinus className="size-3 shrink-0 text-fg-3" />,
}

const order: CheckBucket[] = ['fail', 'pending', 'pass', 'skip']

/** Just the mark, for a sidebar row: nothing until there's something to say. */
export function CIDot({ run }: { run: IssueRun }) {
  if (!run.ci || run.ci.state !== 'OPEN' || !run.ci.checks.length) return null
  const state = overall(run.ci)
  const title =
    state === 'fail' ? t('CI 失败 {n} 项', { n: ciFailures(run.ci).length }) : state === 'pending' ? t('CI 运行中') : t('CI 通过')
  return <span title={title}>{bucketIcon[state]}</span>
}

export function CIStatus({ issue, run, busy }: { issue: Issue; run: IssueRun; busy: boolean }) {
  const perform = useIssues((s) => s.perform)
  const [refreshing, setRefreshing] = useState(false)
  const ci = run.ci
  if (!run.prURL) return null

  const state = ci && ci.checks.length ? overall(ci) : undefined
  const failures = ci ? ciFailures(ci) : []
  const counts = ci ? order.map((bucket) => [bucket, ci.checks.filter((check) => check.bucket === bucket).length] as const) : []
  const label = !ci
    ? t('CI …')
    : ci.state !== 'OPEN'
      ? ci.state === 'MERGED'
        ? t('已合并')
        : t('已关闭')
      : state === 'fail'
        ? t('CI 失败 {n}', { n: failures.length })
        : state === 'pending'
          ? t('CI 运行中')
          : state === 'pass'
            ? t('CI 通过')
            : t('无 CI')

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cx(
              'inline-flex items-center gap-1 rounded px-1 hover:bg-fill-hover',
              state === 'fail' ? 'text-err' : state === 'pending' ? 'text-warn' : state === 'pass' ? 'text-ok' : 'text-fg-3',
            )}
          >
            {state && ci?.state === 'OPEN' && bucketIcon[state]}
            {label}
          </button>
        }
      />
      <PopoverContent align="start" sideOffset={6} className="w-[380px] p-0 text-[12px]">
        <div className="flex h-8 items-center gap-2 border-b border-border/70 px-3">
          <span className="font-semibold">CI</span>
          <span className="flex-1 truncate text-fg-3">
            {counts
              .filter(([, n]) => n > 0)
              .map(([bucket, n]) => `${n} ${bucketLabel(bucket)}`)
              .join(' · ')}
          </span>
          <button
            type="button"
            title={t('现在刷新')}
            aria-label={t('现在刷新')}
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true)
              await perform(() => api.refreshChecks(run.recordId))
              setRefreshing(false)
            }}
            className="flex size-6 items-center justify-center rounded-md text-fg-2 hover:bg-foreground/[0.07] hover:text-fg"
          >
            <RefreshCw className={cx('size-3', refreshing && 'animate-spin')} />
          </button>
        </div>
        <ChecksList issue={issue} run={run} busy={busy} className="max-h-72 overflow-y-auto" />
      </PopoverContent>
    </Popover>
  )
}

/** Every check, failures first, each opening its link — and the failures handed to the agent. */
export function ChecksList({ issue, run, busy, className }: { issue: Issue; run: IssueRun; busy: boolean; className?: string }) {
  const perform = useIssues((s) => s.perform)
  const maxRounds = useIssues((s) => s.config?.maxCIRounds ?? 2)
  const autoFix = useIssues((s) => s.config?.autoFixCI ?? true)
  const ci = run.ci
  const failures = ci ? ciFailures(ci) : []
  return (
    <>
      <div className={cx('py-1', className)}>
        {!ci && <div className="px-3 py-2 text-fg-3">{t('还没查过，稍等或点刷新')}</div>}
        {ci?.checks.length === 0 && <div className="px-3 py-2 text-fg-3">{t('这个 PR 没有 CI')}</div>}
        {ci &&
          [...ci.checks]
            .sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket))
            .map((check, index) => (
              <button
                key={`${check.name}-${index}`}
                type="button"
                disabled={!check.link}
                title={check.link}
                onClick={() => check.link && void api.openExternal(check.link)}
                className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-foreground/[0.05] disabled:hover:bg-transparent"
              >
                {bucketIcon[check.bucket]}
                <span className="shrink-0 font-medium">{check.name}</span>
                {check.description && <span className="truncate text-fg-3">{check.description}</span>}
              </button>
            ))}
      </div>
      {failures.length > 0 && ci?.state === 'OPEN' && (
        <div className="flex items-center gap-2 border-t border-border/70 px-3 py-2">
          <span className="flex-1 text-[11.5px] text-fg-3">
            {run.ciSentFor === ci.sha
              ? t('这次的失败已经发给 agent')
              : ciPending(ci)
                ? t('等其余的跑完会自动发给 agent')
                : !autoFix
                  ? t('自动发送已关闭')
                  : (run.ciRounds ?? 0) >= maxRounds
                    ? t('已到自动发送上限（{n} 轮）', { n: maxRounds })
                    : t('agent 空闲时会自动发')}
          </span>
          <Button
            tone="accent"
            className="h-6 px-2 text-[11px]"
            icon={<Send className="size-3" />}
            disabled={busy}
            title={busy ? t('Agent 正在运行，等它结束') : undefined}
            onClick={() => void perform(() => api.sendCIFailures(issue))}
          >
            {t('发给 agent 修')}
          </Button>
        </div>
      )}
    </>
  )
}

const bucketLabel = (bucket: CheckBucket): string => ({ fail: t('失败'), pending: t('运行中'), pass: t('通过'), skip: t('跳过') })[bucket]
