import { type JSX, Scroll, Text, View } from 'nsh'
import { t } from '../../../shared/i18n'
import { Icon, type IconName } from '../../components/Icon'
import { TitleStrip } from '../../components/kit'
import { SectionSwitcher } from '../../components/SectionSwitcher'
import { cn } from '../../lib/utils'
import { type SettingsPage, app } from '../../store/app'
import { type AutopilotPage, autopilot } from '../../store/autopilot'

/**
 * The settings' rail: the app's own pages, the models' rules, the Issue auto-fix pages, and the
 * way on to autopilot's — which keep their place in the autopilot section, so those entries lead
 * there.
 */
export function SettingsSidebar() {
  return (
    <>
      <TitleStrip />
      <SectionSwitcher />
      <Scroll class="mt-3 min-h-0 flex-1" contentClass="gap-0.5 px-2 pb-3">
        <NavGroup label={t('通用')} />
        <NavItem page="appearance" icon="eye" label={t('外观')} />
        <NavItem page="repo" icon="folder" label={t('仓库')} />
        <NavItem page="terminal" icon="terminal" label={t('终端')} />
        <NavGroup label="AI" />
        <NavItem page="models" icon="cpu" label={t('模型')} />
        <NavGroup label={t('Issue 自动修复')} />
        <NavItem page="issueTeable" icon="table-2" label={t('Teable 表')} />
        <NavItem page="issueFix" icon="wrench" label={t('修复')} />
        <NavItem page="issueReview" icon="badge-check" label="Review" />
        <NavItem page="issuePrompt" icon="file-text" label="Prompt" />
        <NavGroup label={t('托管')} />
        <Link page="teable" icon="table-2" label="Teable" />
        <Link page="feishu" icon="message-circle" label={t('飞书')} />
        <Link page="github" icon="git-pull-request" label="GitHub" />
        <Link page="router" icon="route" label="Router" />
        <Link page="worker" icon="bot" label="Worker" />
      </Scroll>
    </>
  )
}

function NavGroup(props: { label: string }) {
  return <Text class="px-2 pt-3 pb-1 text-[11px] font-medium text-fg-3">{props.label}</Text>
}

function NavItem(props: { page: SettingsPage; icon: IconName; label: string }) {
  const current = () => app.settingsPage() === props.page
  return <Entry icon={props.icon} label={props.label} current={current()} onPress={() => app.openSettings(props.page)} />
}

/** An autopilot page, reached from here: the arrow says it leaves the settings. */
function Link(props: { page: AutopilotPage; icon: IconName; label: string }) {
  return (
    <Entry
      icon={props.icon}
      label={props.label}
      current={false}
      trailing={<Icon name="arrow-up-right" size={13} tint="fg-3" />}
      onPress={() => void autopilot.show(props.page)}
    />
  )
}

function Entry(props: { icon: IconName; label: string; current: boolean; trailing?: JSX.Element; onPress: () => void }) {
  return (
    <View
      class={cn('h-8 flex-row items-center gap-2 rounded-lg px-2', props.current ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60')}
      role="button"
      onPress={props.onPress}
    >
      <Icon name={props.icon} size={16} tint={props.current ? 'fg' : 'fg-2'} />
      <Text class={cn('min-w-0 flex-1 text-[13px]', props.current ? 'font-medium text-fg' : 'text-fg-2')} style={{ numberOfLines: 1 }}>
        {props.label}
      </Text>
      {props.trailing}
    </View>
  )
}
