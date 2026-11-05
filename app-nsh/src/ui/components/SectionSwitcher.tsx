import { Text, View } from 'nsh'
import { isActivePhase } from '../../shared/types'
import { t } from '../../shared/i18n'
import { type Section, app } from '../store/app'
import { autopilot } from '../store/autopilot'
import { issues } from '../store/issues'
import { Icon } from './Icon'
import { IconButton, StatusDot, TabBar } from './kit'

/** Issues ⇄ Branches ⇄ Autopilot, under the title bar of every sidebar so it never moves — and the settings gear beside it. */
export function SectionSwitcher() {
  // Waiting, running and paused: what the queue tab lists.
  const queued = () =>
    issues.queue().waiting.length +
    Object.values(issues.runs()).filter((run) => run.phase === 'paused' || (isActivePhase(run.phase) && run.phase !== 'queued')).length
  const enabled = () => !!autopilot.status()?.enabled
  const thinking = () => autopilot.status()?.router === 'thinking'
  const selected = () => app.section() === 'autopilot'
  return (
    <TabBar<Section>
      value={app.section() === 'queue' ? 'autopilot' : app.section()}
      onChange={(value) => app.go({ section: value })}
      options={[
        { value: 'issues', label: 'Issues' },
        { value: 'branches', label: t('分支') },
        {
          value: 'autopilot',
          label: (
            <View class="flex-row items-center gap-1">
              <Text class={selected() ? 'text-[12px] font-medium text-fg' : 'text-[12px] text-fg-2'}>{t('托管')}</Text>
              <If when={enabled()}>
                <StatusDot color="bg-ok" pulse={thinking()} />
              </If>
              <If when={queued() > 0}>
                <Text class="text-[11px] text-fg-3 tabular-nums">{queued()}</Text>
              </If>
            </View>
          ),
        },
      ]}
      trailing={
        <IconButton label={t('设置')} class="shrink-0" onPress={() => app.set({ showSettings: true })}>
          <Icon name="settings" size={15} tint="fg-2" />
        </IconButton>
      }
    />
  )
}
