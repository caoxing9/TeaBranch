import { isActivePhase } from '@shared/types'
import { TabBar } from './kit'
import { t } from '@shared/i18n'
import { type Section, useApp } from '@/store/app'
import { useIssues } from '@/store/issues'

/** Issues ⇄ Branches ⇄ Queue, under the title bar of every sidebar so it never moves. */
export function SectionSwitcher() {
  const section = useApp((s) => s.section)
  const set = useApp((s) => s.set)
  // Waiting, running and paused: what the queue tab lists.
  const queued = useIssues(
    (s) =>
      s.queue.waiting.length +
      Object.values(s.runs).filter((run) => run.phase === 'paused' || (isActivePhase(run.phase) && run.phase !== 'queued')).length,
  )
  return (
    <TabBar<Section>
      value={section}
      onChange={(value) => set({ section: value })}
      options={[
        { value: 'issues', label: 'Issues' },
        { value: 'branches', label: t('分支') },
        {
          value: 'queue',
          label: (
            <span className="inline-flex items-center gap-1">
              {t('队列')}
              {queued > 0 && <span className="text-[11px] text-fg-3 tabular-nums">{queued}</span>}
            </span>
          ),
        },
      ]}
    />
  )
}
