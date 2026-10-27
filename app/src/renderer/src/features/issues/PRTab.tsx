import { ChevronDown, ExternalLink, GitMerge, GitPullRequest, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { Issue, IssueRun, PRAction, PRDetails } from '@shared/types'
import { isActivePhase } from '@shared/types'
import { t } from '@shared/i18n'
import { Button, IconButton, MenuButton } from '@/components/kit'
import { api, messageOf } from '@/lib/api'
import { cx } from '@/lib/format'
import { useIssues } from '@/store/issues'
import { ChecksList } from './CIStatus'
import { Markdown } from './Markdown'

/**
 * The PR the way MonoCode's inbox shows one: where it stands, the buttons you'd go to GitHub for,
 * its checks — failures one press from the agent — and the description the agent wrote.
 */
export function PRTab({ issue, run }: { issue: Issue; run: IssueRun }) {
  const perform = useIssues((s) => s.perform)
  const busy = isActivePhase(run.phase)
  const [pr, setPR] = useState<PRDetails | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setPR(await api.prDetails(issue.id))
      setError(null)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setLoading(false)
    }
  }, [issue.id])

  // Again whenever the background poll brings new checks: a push or a merge changes the rest too.
  useEffect(() => void load(), [load, run.ci?.sha, run.ci?.state])

  const act = (action: PRAction, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return
    void perform(async () => {
      await api.prAction(issue.id, action)
      await load()
    })
  }

  const open = pr?.state === 'OPEN'
  return (
    <div className="h-full overflow-y-auto text-[12.5px]">
      <div className="space-y-2 border-b px-3 py-3">
        <div className="flex items-start gap-2">
          <StateBadge pr={pr} />
          <div className="min-w-0 flex-1 font-semibold leading-snug">{pr?.title ?? `PR #${run.prURL?.split('/').pop()}`}</div>
          <IconButton label={t('刷新')} onClick={() => void load()}>
            <RefreshCw className={cx('size-3.5', loading && 'animate-spin')} />
          </IconButton>
        </div>
        {pr && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-fg-2">
            <span className="font-mono">#{pr.number}</span>
            <span className="font-mono">
              {pr.baseRefName} ← {pr.headRefName}
            </span>
            <span>
              <span className="font-mono text-ok">+{pr.additions}</span> <span className="font-mono text-err">−{pr.deletions}</span>{' '}
              {t('{n} 个文件', { n: pr.changedFiles })}
            </span>
            {open && <MergeHint pr={pr} />}
          </div>
        )}
        {error && <div className="rounded-md bg-err-soft px-2 py-1.5 text-err">{error}</div>}
        <div className="flex flex-wrap items-center gap-1.5">
          {open && (
            <span className="inline-flex">
              <Button
                tone="accent"
                className="h-7 rounded-r-none px-2.5 text-[12px]"
                icon={<GitMerge className="size-3.5" />}
                disabled={pr.isDraft}
                title={pr.isDraft ? t('草稿不能合并，先标记为可以 review') : undefined}
                onClick={() => act('squash', t('Squash 合并 PR #{n}？', { n: pr.number }))}
              >
                {t('Squash 合并')}
              </Button>
              <MenuButton
                label={t('其他合并方式')}
                className="h-7 w-6 rounded-l-none border-l border-background/20 bg-foreground text-background hover:bg-foreground/90 hover:text-background"
                entries={() => [
                  {
                    label: t('普通合并（merge commit）'),
                    disabled: pr.isDraft,
                    onSelect: () => act('merge', t('合并 PR #{n}？', { n: pr.number })),
                  },
                  {
                    label: t('Rebase 合并'),
                    disabled: pr.isDraft,
                    onSelect: () => act('rebase', t('Rebase 合并 PR #{n}？', { n: pr.number })),
                  },
                ]}
              >
                <ChevronDown className="size-3.5" />
              </MenuButton>
            </span>
          )}
          {open &&
            (pr.isDraft ? (
              <Button className="h-7 px-2.5 text-[12px]" onClick={() => act('ready')}>
                {t('标记为可以 review')}
              </Button>
            ) : (
              <Button className="h-7 px-2.5 text-[12px]" onClick={() => act('draft')}>
                {t('转为草稿')}
              </Button>
            ))}
          {open && (
            <Button className="h-7 px-2.5 text-[12px]" onClick={() => act('close', t('关闭 PR #{n}？分支会保留。', { n: pr.number }))}>
              {t('关闭')}
            </Button>
          )}
          {run.prURL && (
            <Button
              className="h-7 px-2.5 text-[12px]"
              icon={<ExternalLink className="size-3" />}
              onClick={() => void api.openExternal(run.prURL!)}
            >
              GitHub
            </Button>
          )}
        </div>
      </div>

      <Section title={t('检查')}>
        <ChecksList issue={issue} run={run} busy={busy} />
      </Section>

      {pr && (
        <Section title={t('描述')}>
          <div className="px-3 pb-3">
            {pr.body.trim() ? <Markdown text={pr.body} /> : <span className="text-fg-3">{t('没有描述')}</span>}
          </div>
        </Section>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b">
      <div className="px-3 pt-3 pb-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</div>
      {children}
    </section>
  )
}

function StateBadge({ pr }: { pr: PRDetails | null }) {
  if (!pr) return <GitPullRequest className="mt-0.5 size-4 shrink-0 text-fg-3" />
  const [label, tone] =
    pr.state === 'MERGED'
      ? [t('已合并'), 'bg-violet-500/15 text-violet-600 dark:text-violet-400']
      : pr.state === 'CLOSED'
        ? [t('已关闭'), 'bg-err-soft text-err']
        : pr.isDraft
          ? [t('草稿'), 'bg-fill text-fg-2']
          : [t('开启'), 'bg-ok/15 text-ok']
  return <span className={cx('mt-px shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium', tone)}>{label}</span>
}

/** Why it can or can't merge, in the words you'd act on. */
function MergeHint({ pr }: { pr: PRDetails }) {
  const review =
    pr.reviewDecision === 'APPROVED'
      ? [t('已批准'), 'text-ok']
      : pr.reviewDecision === 'CHANGES_REQUESTED'
        ? [t('要求修改'), 'text-err']
        : pr.reviewDecision === 'REVIEW_REQUIRED'
          ? [t('需要 review'), 'text-warn']
          : null
  const merge =
    pr.mergeStateStatus === 'DIRTY'
      ? [t('有冲突'), 'text-err']
      : pr.mergeStateStatus === 'BEHIND'
        ? [t('落后于 {base}', { base: pr.baseRefName }), 'text-warn']
        : pr.mergeStateStatus === 'CLEAN'
          ? [t('可以合并'), 'text-ok']
          : null
  return (
    <>
      {review && <span className={review[1]}>· {review[0]}</span>}
      {merge && <span className={merge[1]}>· {merge[0]}</span>}
    </>
  )
}
