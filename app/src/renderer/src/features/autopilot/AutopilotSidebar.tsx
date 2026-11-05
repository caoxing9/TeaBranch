import { Activity, Bot, GitPullRequest, House, MessageCircle, Plus, Route, Table2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { t } from '@shared/i18n'
import type { SourceId } from '@shared/types'
import { isActivePhase } from '@shared/types'
import { SectionSwitcher } from '@/components/SectionSwitcher'
import { StatusDot } from '@/components/kit'
import { cx } from '@/lib/format'
import { type AutopilotPage, useAutopilot } from '@/store/autopilot'
import { useIssues } from '@/store/issues'
import { SourceDot } from './parts'

/** The rail follows the architecture: what comes in, who decides, who does the work, what happened. */
export function AutopilotSidebar() {
  const status = useAutopilot((s) => s.status)
  const newProbe = useAutopilot((s) => s.newProbe)
  const running = useIssues((s) => Object.values(s.runs).filter((run) => isActivePhase(run.phase) && run.phase !== 'queued').length)
  const source = (id: SourceId) => status?.sources?.find((candidate) => candidate.id === id)
  const sourceDot = (id: SourceId) => <SourceDot state={source(id)?.state ?? 'off'} />
  const router = status?.router ?? 'off'

  return (
    <>
      <div className="drag h-[38px] shrink-0" />
      <SectionSwitcher />
      <nav className="mt-3 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3 text-[13px]">
        <button
          type="button"
          onClick={() => void newProbe()}
          className="mb-1 flex h-8 items-center gap-2 rounded-lg px-2 text-left font-medium text-fg hover:bg-sidebar-accent"
        >
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Plus className="size-3" strokeWidth={2.5} />
          </span>
          {t('新探查')}
        </button>
        <NavItem page="overview" icon={<House />} label={t('总览')} />
        <NavGroup>{t('数据源')}</NavGroup>
        <NavItem page="teable" icon={<Table2 />} label="Teable" trailing={sourceDot('teable')} />
        <NavItem page="feishu" icon={<MessageCircle />} label={t('飞书')} trailing={sourceDot('feishu')} />
        <NavItem page="github" icon={<GitPullRequest />} label="GitHub" trailing={sourceDot('github')} />
        <NavGroup>{t('处理')}</NavGroup>
        <NavItem
          page="router"
          icon={<Route />}
          label="Router"
          trailing={
            router === 'off' ? undefined : (
              <StatusDot
                color={router === 'error' ? 'bg-err' : router === 'thinking' ? 'bg-brand' : 'bg-ok'}
                pulse={router === 'thinking'}
              />
            )
          }
        />
        <NavItem
          page="worker"
          icon={<Bot />}
          label="Worker"
          trailing={running > 0 ? <span className="text-[11px] text-fg-2 tabular-nums">{running}</span> : undefined}
        />
        <NavGroup>{t('记录')}</NavGroup>
        <NavItem page="activity" icon={<Activity />} label={t('动态')} />
      </nav>
      <div className="flex h-9 shrink-0 items-center gap-2 border-t border-sidebar-border px-3 text-[11.5px] text-fg-2">
        <StatusDot color={status?.enabled ? 'bg-ok' : 'bg-fg-3'} pulse={status?.router === 'thinking'} />
        {status?.enabled ? t('托管运行中') : t('托管已关闭')}
      </div>
    </>
  )
}

function NavGroup({ children }: { children: ReactNode }) {
  return <div className="px-2 pt-3 pb-1 text-[11px] font-medium text-fg-3">{children}</div>
}

function NavItem({ page, icon, label, trailing }: { page: AutopilotPage; icon: ReactNode; label: string; trailing?: ReactNode }) {
  const current = useAutopilot((s) => s.page)
  const show = useAutopilot((s) => s.show)
  return (
    <button
      type="button"
      onClick={() => void show(page)}
      className={cx(
        'flex h-8 items-center gap-2 rounded-lg px-2 text-left [&>svg]:size-4 [&>svg]:shrink-0',
        current === page ? 'bg-sidebar-accent font-medium text-fg' : 'text-fg-2 hover:bg-sidebar-accent/60 hover:text-fg',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  )
}
