import { TabBar } from './kit'
import { t } from '@shared/i18n'
import { type Section, useApp } from '@/store/app'

/** Branches ⇄ Issues, under the title bar of both sidebars so it never moves. */
export function SectionSwitcher() {
  const section = useApp((s) => s.section)
  const set = useApp((s) => s.set)
  return (
    <TabBar<Section>
      value={section}
      onChange={(value) => set({ section: value })}
      options={[
        { value: 'issues', label: 'Issues' },
        { value: 'branches', label: t('分支') },
      ]}
    />
  )
}
