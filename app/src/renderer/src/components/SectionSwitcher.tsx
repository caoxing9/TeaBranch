import { Settings } from 'lucide-react'
import { isActivePhase } from '@shared/types'
import { IconButton, StatusDot, TabBar } from './kit'
import { t } from '@shared/i18n'
import { type Section, useApp } from '@/store/app'
import { useAutopilot } from '@/store/autopilot'
import { useIssues } from '@/store/issues'

/** Issues ⇄ Branches ⇄ Autopilot, under the title bar of every sidebar so it never moves — and the settings gear beside it. */
export function SectionSwitcher() {
  const section = useApp((s) => s.section)
  const set = useApp((s) => s.set)
  // Waiting, running and paused: what the queue tab lists.
  const queued = useIssues(
    (s) =>
      s.queue.waiting.length +
      Object.values(s.runs).filter((run) => run.phase === 'paused' || (isActivePhase(run.phase) && run.phase !== 'queued')).length,
  )
  const autopilot = useAutopilot((s) => !!s.status?.enabled)
  const thinking = useAutopilot((s) => s.status?.router === 'thinking')
  return (
    <TabBar<Section>
      value={section}
      onChange={(value) => set({ section: value })}
      options={[
        { value: 'issues', label: 'Issues' },
        { value: 'branches', label: t('分支') },
        {
          value: 'autopilot',
          label: (
            <span className="inline-flex items-center gap-1">
              {t('托管')}
              {autopilot && <StatusDot color="bg-ok" pulse={thinking} />}
              {queued > 0 && <span className="text-[11px] text-fg-3 tabular-nums">{queued}</span>}
            </span>
          ),
        },
      ]}
      trailing={
        <IconButton label={t('设置')} onClick={() => set({ showSettings: true })} className="shrink-0">
          <Settings className="size-4" />
        </IconButton>
      }
    />
  )
}
