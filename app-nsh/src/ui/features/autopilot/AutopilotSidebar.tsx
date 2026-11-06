import { type JSX, Scroll, Text, View } from 'nsh'
import { t } from '../../../shared/i18n'
import type { SourceId } from '../../../shared/types'
import { isActivePhase } from '../../../shared/types'
import { Icon, type IconName } from '../../components/Icon'
import { StatusDot, TitleStrip } from '../../components/kit'
import { SectionSwitcher } from '../../components/SectionSwitcher'
import { cn } from '../../lib/utils'
import { type AutopilotPage, autopilot } from '../../store/autopilot'
import { issues } from '../../store/issues'
import { SourceDot } from './parts'

/** The rail follows the architecture: what comes in, who decides, who does the work, what happened. */
export function AutopilotSidebar() {
  const status = () => autopilot.status()
  const running = () => Object.values(issues.runs()).filter((run) => isActivePhase(run.phase) && run.phase !== 'queued').length
  const source = (id: SourceId) => status()?.sources?.find((candidate) => candidate.id === id)
  const router = () => status()?.router ?? 'off'
  return (
    <>
      <TitleStrip />
      <SectionSwitcher />
      <Scroll class="mt-3 min-h-0 flex-1" contentClass="gap-0.5 px-2 pb-3">
        <View class="mb-1 h-8 flex-row items-center gap-2 rounded-lg px-2 hover:bg-sidebar-accent" role="button" onPress={() => void autopilot.newProbe()}>
          <View class="size-5 shrink-0 items-center justify-center rounded-full bg-primary">
            <Icon name="plus" size={12} tint="#ffffff" />
          </View>
          <Text class="text-[13px] font-medium text-fg">{t('新探查')}</Text>
        </View>
        <NavItem page="overview" icon="house" label={t('总览')} />
        <NavGroup label={t('数据源')} />
        <NavItem page="teable" icon="table-2" label="Teable" trailing={<SourceDot state={source('teable')?.state ?? 'off'} />} />
        <NavItem page="feishu" icon="message-circle" label={t('飞书')} trailing={<SourceDot state={source('feishu')?.state ?? 'off'} />} />
        <NavItem page="github" icon="git-pull-request" label="GitHub" trailing={<SourceDot state={source('github')?.state ?? 'off'} />} />
        <NavGroup label={t('处理')} />
        <NavItem
          page="router"
          icon="route"
          label="Router"
          trailing={
            <If when={router() !== 'off'}>
              <StatusDot color={router() === 'error' ? 'bg-err' : router() === 'thinking' ? 'bg-brand' : 'bg-ok'} pulse={router() === 'thinking'} />
            </If>
          }
        />
        <NavItem
          page="worker"
          icon="bot"
          label="Worker"
          trailing={
            <If when={running() > 0}>
              <Text class="text-[11px] text-fg-2 tabular-nums">{running()}</Text>
            </If>
          }
        />
        <NavGroup label={t('记录')} />
        <NavItem page="activity" icon="activity" label={t('动态')} />
      </Scroll>
      <View class="h-9 shrink-0 flex-row items-center gap-2 border-t border-sidebar-border px-3">
        <StatusDot color={status()?.enabled ? 'bg-ok' : 'bg-fg-3'} pulse={status()?.router === 'thinking'} />
        <Text class="text-[11.5px] text-fg-2">{status()?.enabled ? t('托管运行中') : t('托管已关闭')}</Text>
      </View>
    </>
  )
}

function NavGroup(props: { label: string }) {
  return <Text class="px-2 pt-3 pb-1 text-[11px] font-medium text-fg-3">{props.label}</Text>
}

function NavItem(props: { page: AutopilotPage; icon: IconName; label: string; trailing?: JSX.Element }) {
  const current = () => autopilot.page() === props.page
  return (
    <View
      class={cn('h-8 flex-row items-center gap-2 rounded-lg px-2', current() ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60')}
      role="button"
      onPress={() => void autopilot.show(props.page)}
    >
      <Icon name={props.icon} size={16} tint={current() ? 'fg' : 'fg-2'} />
      <Text class={cn('min-w-0 flex-1 text-[13px]', current() ? 'font-medium text-fg' : 'text-fg-2')} style={{ numberOfLines: 1 }}>
        {props.label}
      </Text>
      {props.trailing}
    </View>
  )
}
