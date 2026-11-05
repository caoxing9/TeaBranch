import { Scroll, Text, View } from 'nsh'
import type { Branch, DevCategory } from '../../../shared/types'
import { isLive } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { Icon } from '../../components/Icon'
import { ContextMenuArea, IconButton, type MenuEntry, type MenuItem, MenuButton, Spinner, StatusDot, TextInput, TitleStrip } from '../../components/kit'
import { SectionSwitcher } from '../../components/SectionSwitcher'
import { api } from '../../lib/api'
import { plural } from '../../lib/format'
import { cn } from '../../lib/utils'
import { type SortKey, app, categoryOf, statusOf, visibleBranches } from '../../store/app'

const lanes: DevCategory[] = ['developing', 'todo', 'done']

export const laneLabel = (lane: DevCategory): string => ({ developing: t('开发中'), todo: t('待开发'), done: t('已完成') })[lane]

/** The selected row is a raised card, not a tint: over the sidebar a 2% grey difference simply disappears. */
export const selectedRow = 'bg-bg shadow-sm border border-border'

export const statusColor = {
  running: 'bg-ok',
  building: 'bg-warn',
  error: 'bg-err',
  stopped: 'bg-fg-3',
} as const

/**
 * Every branch, all the time, grouped into lanes. The whole premise is running several branches at
 * once, so "what else is running?" must never need navigating away from what you are reading.
 */
export function BranchSidebar() {
  const visible = () =>
    visibleBranches({ branches: app.branches(), search: app.search(), sortKey: app.sortKey(), sortAscending: app.sortAscending(), categories: app.categories() })
  const live = () => app.branches().filter((branch) => isLive(statusOf(branch))).length
  const pending = () => Object.entries(app.creating()).filter(([name]) => !app.branches().some((branch) => branch.name === name))
  return (
    <>
      <TitleStrip />
      <SectionSwitcher />
      <View class="shrink-0 px-2 pt-2 pb-1">
        <View class="flex-row items-center gap-1">
          <View class="h-[26px] flex-1 flex-row items-center gap-1.5 rounded-md bg-fill px-2">
            <Icon name="search" size={14} tint="fg-3" />
            <TextInput
              value={app.search()}
              onChange={(e) => app.set({ search: e.value })}
              onSubmit={() => visible()[0] && app.set({ selectedBranch: visible()[0].name })}
              placeholder={t('搜索分支')}
              class="h-6 flex-1 border-0 bg-transparent px-0 text-[12.5px] shadow-none"
            />
          </View>
          <IconButton label={t('新建分支 (⌘N)')} onPress={() => app.set({ showCreate: true })}>
            <Icon name="plus" size={16} tint="fg-2" />
          </IconButton>
        </View>
      </View>
      <Scroll class="min-h-0 flex-1" contentClass="px-2 pb-2">
        <Each of={pending()} key={([name]) => name}>
          {(entry) => (
            <View
              class={cn('mt-1 mb-0.5 flex-row items-center gap-2.5 rounded-lg px-2.5 py-[7px]', app.selectedBranch() === entry()[0] ? selectedRow : 'hover:bg-fill-hover')}
              role="button"
              onPress={() => app.set({ selectedBranch: entry()[0] })}
            >
              <Spinner size={12} />
              <View class="min-w-0 flex-1">
                <Text class="text-[13px] font-medium text-fg" style={{ numberOfLines: 1 }}>
                  {entry()[0]}
                </Text>
                <Text class="text-[11px] text-fg-2" style={{ numberOfLines: 1 }}>
                  {entry()[1].message}
                </Text>
              </View>
            </View>
          )}
        </Each>
        <If
          when={app.branches().length > 0 || Object.keys(app.creating()).length > 0}
          else={<Text class="px-3 py-10 text-center text-[13px] text-fg-2">{app.error() ? t('读取仓库失败') : t('还没有分支，按 ⌘N 新建 worktree。')}</Text>}
        >
          <If when={visible().length > 0} else={<Text class="px-3 py-10 text-center text-[13px] text-fg-2">{t('没有匹配的分支')}</Text>}>
            <Each of={lanes} key={(lane) => lane}>
              {(lane) => <Lane lane={lane()} branches={visible().filter((branch) => categoryOf(app.categories(), branch.name) === lane())} />}
            </Each>
          </If>
        </If>
      </Scroll>
      <View class="h-9 shrink-0 flex-row items-center gap-2 border-t border-border px-3">
        <If when={live() > 0} else={<Text class="text-[11.5px] text-fg-2">{plural(t('{n} 个分支', { n: app.branches().length }))}</Text>}>
          <View class="flex-row items-center gap-1.5">
            <StatusDot color="bg-ok" />
            <Text class="text-[11.5px] text-fg-2">{t('{n} 个运行中', { n: live() })}</Text>
          </View>
        </If>
        <View class="flex-1" />
        <MenuButton label={t('排序、外观和设置')} entries={appMenu}>
          <Icon name="more-horizontal" size={16} tint="fg-2" />
        </MenuButton>
      </View>
    </>
  )
}

function Lane(props: { lane: DevCategory; branches: Branch[] }) {
  const collapsed = () => app.collapsedLanes().includes(props.lane)
  return (
    <If when={props.branches.length > 0}>
      <View class="mb-1">
        <View class="flex-row items-center gap-1 px-2 pt-2 pb-1" role="button" onPress={() => app.toggleLane(props.lane)}>
          <Icon name={collapsed() ? 'chevron-right' : 'chevron-down'} size={12} tint="fg-3" />
          <Text class="text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase">{laneLabel(props.lane)}</Text>
          <Text class="text-[10.5px] text-fg-3">{props.branches.length}</Text>
        </View>
        <If when={!collapsed()}>
          <Each of={props.branches} key={(branch) => branch.name}>
            {(branch) => <BranchRow branch={branch()} />}
          </Each>
        </If>
      </View>
    </If>
  )
}

function appMenu(): MenuEntry[] {
  const sort = (key: SortKey, label: string): MenuItem => ({
    label,
    checked: app.sortKey() === key,
    onSelect: () => app.set({ sortKey: key, sortAscending: app.sortKey() === key ? !app.sortAscending() : true }),
  })
  return [
    { label: t('排序'), items: [sort('name', t('名称')), sort('status', t('状态')), sort('category', t('分类'))] },
    {
      label: t('外观'),
      items: [
        { label: t('跟随系统'), checked: app.theme() === 'system', onSelect: () => app.setTheme('system') },
        { label: t('浅色'), checked: app.theme() === 'light', onSelect: () => app.setTheme('light') },
        { label: t('深色'), checked: app.theme() === 'dark', onSelect: () => app.setTheme('dark') },
      ],
    },
    'separator',
    { label: t('打开仓库…'), onSelect: () => void app.chooseProject() },
    { label: t('设置…'), onSelect: () => app.set({ showSettings: true }) },
  ]
}

export function branchMenu(branch: Branch): MenuEntry[] {
  const live = isLive(statusOf(branch))
  const category = categoryOf(app.categories(), branch.name)
  return [
    { label: live ? t('停止') : t('启动'), onSelect: () => void app.toggle(branch), disabled: app.busy().has(branch.name) },
    {
      label: t('打开预览'),
      onSelect: () => void app.run(null, () => api.openPreview(branch.name)),
      disabled: !branch.environment?.port || !live,
    },
    'separator',
    { label: t('打开 Agent'), onSelect: () => void app.run(null, () => api.openAgent(branch.name)) },
    { label: t('在终端打开'), onSelect: () => void app.run(null, () => api.openTerminal(branch.name)) },
    { label: t('在 VS Code 打开'), onSelect: () => void app.run(null, () => api.openEditor(branch.name)) },
    'separator',
    {
      label: t('分类'),
      items: lanes.map((lane) => ({ label: laneLabel(lane), checked: lane === category, onSelect: () => void app.setCategory(branch.name, lane) })),
    },
    'separator',
    {
      label: t('删除 Worktree…'),
      danger: true,
      disabled: !branch.managed || branch.isCurrent,
      onSelect: () => app.set({ pendingDelete: branch.name }),
    },
  ]
}

function BranchRow(props: { branch: Branch }) {
  const status = () => statusOf(props.branch)
  const selected = () => app.selectedBranch() === props.branch.name
  const creating = () => app.creating()[props.branch.name]
  const busy = () => app.busy().has(props.branch.name) || !!creating()
  const port = () => props.branch.environment?.port
  const line = () => {
    const current = creating()
    if (current) return current.message
    if (busy()) return t('处理中…')
    const text = status() === 'running' ? t('运行中') : status() === 'building' ? t('构建中') : ''
    return port() && isLive(status()) ? `${text} · :${port()}` : text
  }
  return (
    <ContextMenuArea entries={() => branchMenu(props.branch)}>
      <View
        class={cn('mb-0.5 flex-row items-center gap-2.5 rounded-lg px-2.5 py-[7px]', selected() ? selectedRow : 'hover:bg-fill-hover')}
        role="button"
        onPress={() => app.set({ selectedBranch: props.branch.name })}
      >
        <If when={busy()} else={<StatusDot color={statusColor[status()]} pulse={status() === 'building'} />}>
          <Spinner size={10} />
        </If>
        <View class="min-w-0 flex-1">
          <View class="flex-row items-center gap-1.5">
            <Text class={cn('text-[13px] text-fg', selected() ? 'font-semibold' : 'font-medium')} style={{ numberOfLines: 1 }}>
              {props.branch.name}
            </Text>
            <If when={props.branch.isCurrent}>
              <View class="rounded border border-border px-1">
                <Text class="text-[9px] font-semibold text-fg-2">HEAD</Text>
              </View>
            </If>
          </View>
          <If when={isLive(status()) || busy()}>
            <Text class="mt-px text-[11px] text-fg-2 tabular-nums" style={{ numberOfLines: 1 }}>
              {line()}
            </Text>
          </If>
        </View>
        <If when={app.withTerminal().has(props.branch.name)}>
          <Icon name="terminal" size={14} tint="fg-3" />
        </If>
      </View>
    </ContextMenuArea>
  )
}
