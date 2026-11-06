import { type PressEvent, Scroll, Text, View, signal } from 'nsh'
import { Checkbox } from 'nsh/base'
import type { Issue, IssueRun, IssueShelf, Person } from '../../../shared/types'
import { isActivePhase } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { issuePeople } from '../../lib/people'
import { Icon } from '../../components/Icon'
import { Button, ContextMenuArea, IconButton, type MenuEntry, MenuButton, Spinner, TextInput, TitleStrip } from '../../components/kit'
import { PeopleStack, PersonAvatar } from '../../components/person'
import { SectionSwitcher } from '../../components/SectionSwitcher'
import { api } from '../../lib/api'
import { cn } from '../../lib/utils'
import { pref, setPref } from '../../prefs'
import { app } from '../../store/app'
import { autopilot } from '../../store/autopilot'
import { fixable, issues, visibleIssues } from '../../store/issues'
import { selectedRow } from '../branches/BranchSidebar'
import { CIDot } from './CIStatus'
import { IssueFilterButton } from './IssueFilter'
import { PhaseBadge } from './phase'
import { QueueBar } from './QueuePanel'

export function IssueSidebar() {
  const visible = () =>
    visibleIssues({ issues: issues.issues(), search: issues.search(), filter: issues.filter(), runs: issues.runs(), issueFilter: issues.issueFilter() })
  let lastClicked: string | null = null
  const active = () => Object.values(issues.runs()).filter((run) => isActivePhase(run.phase)).length
  const selectMode = signal(false)
  const showBatchBar = () => selectMode() || issues.checked().size > 0
  /**
   * A plain click opens the issue. Ticking is separate — the checkbox, or ⌘-click to toggle and
   * ⇧-click to tick a range from the last one — so a batch can be built while one issue is open.
   */
  const click = (issue: Issue, event: PressEvent) => {
    if (!event.modifiers.platform && !event.modifiers.shift) {
      lastClicked = issue.id
      issues.select(new Set([issue.id]))
      return
    }
    const next = new Set(issues.checked())
    const list = visible()
    if (event.modifiers.shift && lastClicked) {
      const from = list.findIndex((candidate) => candidate.id === lastClicked)
      const to = list.findIndex((candidate) => candidate.id === issue.id)
      if (from >= 0 && to >= 0) for (let i = Math.min(from, to); i <= Math.max(from, to); i++) next.add(list[i].id)
    } else if (next.has(issue.id)) next.delete(issue.id)
    else next.add(issue.id)
    lastClicked = issue.id
    issues.setChecked(next)
  }
  const toggleChecked = (id: string) => {
    const next = new Set(issues.checked())
    if (next.has(id)) next.delete(id)
    else next.add(id)
    lastClicked = id
    issues.setChecked(next)
  }
  const visibleIds = () => visible().map((issue) => issue.id)
  const checkedVisible = () => visibleIds().filter((id) => issues.checked().has(id)).length
  const allChecked = () => visibleIds().length > 0 && checkedVisible() === visibleIds().length
  const counter = () => (visible().length < issues.issues().length ? `${visible().length} / ${issues.issues().length}` : String(visible().length))
  return (
    <>
      <TitleStrip />
      <SectionSwitcher />
      <View class="shrink-0 border-b border-border/60 px-2 pt-2 pb-1.5">
        <View class="flex-row items-center gap-1">
          <View class="h-[26px] flex-1 flex-row items-center gap-1.5 rounded-md bg-fill px-2">
            <Icon name="search" size={14} tint="fg-3" />
            <TextInput
              value={issues.search()}
              onChange={(e) => issues.set({ search: e.value })}
              placeholder={t('搜索 issue')}
              class="h-6 flex-1 border-0 bg-transparent px-0 text-[12.5px] shadow-none"
            />
            <Text
              class={cn('shrink-0 text-[11px] tabular-nums', visible().length < issues.issues().length ? 'text-brand' : 'text-fg-3')}
              tooltip={
                visible().length < issues.issues().length
                  ? t('筛选后 {n} 个，共 {total} 个', { n: visible().length, total: issues.issues().length })
                  : t('当前列表里的 issue 数')
              }
            >
              {counter()}
            </Text>
          </View>
          <IssueFilterButton />
          <View
            class={cn('size-[26px] shrink-0 items-center justify-center rounded-md', showBatchBar() ? 'bg-fill-active' : 'hover:bg-fill-hover')}
            role="button"
            tooltip={t('勾选多个 issue 批量修复（⌘/⇧ 点击也能勾选）')}
            onPress={() => {
              if (showBatchBar()) {
                selectMode.set(false)
                issues.setChecked(new Set())
              } else selectMode.set(true)
            }}
          >
            <Icon name="list-checks" size={14} tint={showBatchBar() ? 'fg' : 'fg-2'} />
          </View>
        </View>
        <If when={showBatchBar()}>
          <View class="mt-1.5 h-6 flex-row items-center gap-2 rounded-md bg-fill px-1.5">
            <Checkbox
              checked={allChecked()}
              indeterminate={checkedVisible() > 0 && !allChecked()}
              disabled={!visible().length}
              class="size-3.5 rounded border border-input"
              checkedStyle={{}}
              onChange={() => issues.setChecked(allChecked() ? new Set() : new Set([...issues.checked(), ...visibleIds()]))}
              tooltip={t('全选当前列表（⌘A）')}
            />
            <If when={issues.checked().size > 0} else={<Text class="text-[11.5px] text-fg-3">{t('全选')}</Text>}>
              <Text class="text-[11.5px] text-fg">{t('已选 {n}', { n: issues.checked().size })}</Text>
            </If>
            <View class="flex-1" />
            <View
              class={cn('rounded px-1 hover:bg-fill-hover', !visible().length && 'opacity-40')}
              role="button"
              tooltip={t('当前列表里没勾的勾上、勾了的取消')}
              onPress={() => {
                const next = new Set(issues.checked())
                for (const id of visibleIds()) {
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                }
                issues.setChecked(next)
              }}
            >
              <Text class="text-[11.5px] text-fg-2">{t('反选')}</Text>
            </View>
            <View
              class={cn('rounded px-1 hover:bg-fill-hover', !issues.checked().size && 'opacity-40')}
              role="button"
              onPress={() => issues.setChecked(new Set())}
            >
              <Text class="text-[11.5px] text-fg-2">{t('清空')}</Text>
            </View>
          </View>
        </If>
      </View>
      <Scroll class="min-h-0 flex-1" contentClass="px-2 pb-2">
        <If when={issues.user()} else={<Text class="px-3 py-10 text-center text-[13px] text-fg-2">{t('未登录 Teable')}</Text>}>
          <If
            when={visible().length > 0}
            else={<Text class="px-3 py-10 text-center text-[13px] text-fg-2">{issues.loading() ? t('加载中…') : t('没有 issue')}</Text>}
          >
            <IssueGroups visible={visible()} click={click} toggleChecked={toggleChecked} selectMode={showBatchBar()} />
          </If>
        </If>
      </Scroll>
      <If when={issues.checked().size > 0}>
        <View class="h-10 shrink-0 flex-row items-center gap-2 border-t border-border bg-brand-soft px-3">
          <Text class="text-[12px] font-medium text-fg">{t('已选 {n} 个', { n: issues.checked().size })}</Text>
          <View class="flex-1" />
          <Button tone="accent" class="h-6 px-2" onPress={() => issues.select(new Set())}>
            {t('批量修复…')}
          </Button>
        </View>
      </If>
      <If when={issues.user()}>
        <QueueBar />
      </If>
      <View class="h-9 shrink-0 flex-row items-center gap-2 border-t border-border px-3">
        <If when={issues.user()}>{(user) => <PersonAvatar person={{ name: user().name, email: user().email, avatar: user().avatar }} />}</If>
        <Text class="text-[11.5px] font-medium text-fg" style={{ numberOfLines: 1 }}>
          {issues.user()?.name ?? t('未登录')}
        </Text>
        <If when={active() > 0}>
          <Text class="shrink-0 text-[11.5px] text-agent">· {t('{n} 进行中', { n: active() })}</Text>
        </If>
        <View class="flex-1" />
        <If when={issues.user() && issues.config()}>
          <ScopeSwitch />
        </If>
        <IconButton label={t('刷新')} disabled={!issues.user() || issues.loading()} onPress={() => void issues.reload()}>
          <Icon name="refresh-cw" size={14} tint="fg-2" />
        </IconButton>
        <MenuButton
          label={t('更多')}
          entries={() => {
            const queueable = fixable(visible(), issues.runs()).filter((issue) => !issues.runs()[issue.id])
            return [
              {
                label: t('把列表里 {n} 个未处理的加入队列', { n: queueable.length }),
                disabled: !queueable.length,
                onSelect: () => void issues.perform(() => api.enqueueFix(queueable)),
              },
              'separator',
              { label: t('Issue 设置…'), onSelect: () => app.openSettings('issueTeable') },
              { label: t('托管…'), onSelect: () => void autopilot.show() },
              ...(issues.user() ? [{ label: t('退出 Teable'), onSelect: () => void issues.signOut() }] : []),
            ]
          }}
        >
          <Icon name="more-horizontal" size={16} tint="fg-2" />
        </MenuButton>
      </View>
    </>
  )
}

type Group = 'active' | IssueShelf | 'untouched'

const groupLabel = (group: Group): string =>
  ({ active: t('进行中'), review: t('待审查'), attention: t('需要你处理'), untouched: t('未开始'), done: t('已处理') })[group]

/**
 * Where an issue sits in the issue-driven flow: what needs you now comes first. Groups are
 * TeaBranch's own, not the table's status; a settled issue can be filed elsewhere by hand.
 */
function groupOf(run: IssueRun | undefined, queued: boolean): Group {
  if (queued || (run && (isActivePhase(run.phase) || run.phase === 'paused'))) return 'active'
  if (!run) return 'untouched'
  if (run.shelf) return run.shelf
  if (run.phase === 'prOpen') return 'review'
  return 'attention'
}

const shelves: IssueShelf[] = ['review', 'attention', 'done']

/** Move a settled issue between groups; running ones go where their run takes them. */
export function shelfMenu(run: IssueRun | undefined, queued: boolean): MenuEntry[] {
  if (!run || queued || isActivePhase(run.phase) || run.phase === 'paused') return []
  const current = groupOf(run, queued)
  return [
    {
      label: t('移到'),
      items: [
        ...shelves.map((shelf) => ({
          label: groupLabel(shelf),
          checked: current === shelf,
          onSelect: () => void issues.perform(() => api.setIssueShelf(run.recordId, shelf)),
        })),
        ...(run.shelf ? [{ label: t('按状态自动分组'), onSelect: () => void issues.perform(() => api.setIssueShelf(run.recordId, null)) }] : []),
      ],
    },
  ]
}

const GROUPS_KEY = 'teabranch.issueGroups'

function IssueGroups(props: { visible: Issue[]; click: (issue: Issue, event: PressEvent) => void; toggleChecked: (id: string) => void; selectMode: boolean }) {
  // Done is out of the way until you open it.
  const collapsed = signal<Group[]>(pref<Group[]>(GROUPS_KEY, ['done']))
  const toggle = (group: Group) => {
    const next = collapsed().includes(group) ? collapsed().filter((g) => g !== group) : [...collapsed(), group]
    setPref(GROUPS_KEY, next)
    collapsed.set(next)
  }
  const groups = () =>
    (['active', 'review', 'attention', 'untouched', 'done'] as Group[])
      .map((group) => ({
        group,
        issues: props.visible.filter((issue) => groupOf(issues.runs()[issue.id], issues.queue().waiting.includes(issue.id)) === group),
      }))
      .filter((entry) => entry.issues.length > 0)
  return (
    <Each of={groups()} key={(entry) => entry.group}>
      {(entry) => (
        <View class="mb-1">
          <View class="flex-row items-center gap-1 rounded-md px-2 pt-2 pb-1" role="button" onPress={() => toggle(entry().group)}>
            <Icon name={collapsed().includes(entry().group) ? 'chevron-right' : 'chevron-down'} size={12} tint="fg-3" />
            <Text class="text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase">{groupLabel(entry().group)}</Text>
            <Text class="text-[10.5px] text-fg-3">{entry().issues.length}</Text>
          </View>
          <If when={!collapsed().includes(entry().group)}>
            <Each of={entry().issues} key={(issue) => issue.id}>
              {(issue) => (
                <IssueRow
                  issue={issue()}
                  menu={() => shelfMenu(issues.runs()[issue().id], issues.queue().waiting.includes(issue().id))}
                  people={issuePeople(issue(), issues.config(), issues.fields())}
                  run={issues.runs()[issue().id]}
                  queuePosition={issues.queue().waiting.indexOf(issue().id) + 1 || undefined}
                  selected={issues.selection().has(issue().id)}
                  checked={issues.checked().has(issue().id)}
                  checking={props.selectMode}
                  onPress={(event) => props.click(issue(), event)}
                  onToggleCheck={() => props.toggleChecked(issue().id)}
                />
              )}
            </Each>
          </If>
        </View>
      )}
    </Each>
  )
}

/** Relative age, MonoCode-style: 3m, 22m, 7h, 2d. */
function age(ms: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

/** A card per issue: id and status above, the title, then where its agent stands. */
function IssueRow(props: {
  issue: Issue
  menu: () => MenuEntry[]
  people: Person[]
  run?: IssueRun
  queuePosition?: number
  selected: boolean
  checked: boolean
  /** Something is ticked: every row shows its checkbox, not just the hovered one. */
  checking: boolean
  onPress: (event: PressEvent) => void
  onToggleCheck: () => void
}) {
  return (
    <ContextMenuArea entries={props.menu}>
      <View
        class={cn(
          'mb-0.5 flex-row gap-2 rounded-lg py-2 pr-2.5 pl-1.5',
          props.selected ? selectedRow : props.checked ? 'bg-brand-soft' : 'hover:bg-fill-hover',
        )}
        role="button"
        onPress={props.onPress}
      >
        <View class="w-4 shrink-0 items-center pt-[3px]">
          <Checkbox
            checked={props.checked}
            class={cn('size-3.5 rounded border border-input', props.checked || props.checking ? 'opacity-100' : 'opacity-50')}
            checkedStyle={{}}
            accessibilityLabel={t('勾选 {key}', { key: props.issue.key })}
            onChange={props.onToggleCheck}
          />
        </View>
        <View class="min-w-0 flex-1">
          <View class="flex-row items-center gap-1.5">
            <Text class="font-mono text-[11px] text-fg-3">{props.issue.key}</Text>
            <If when={props.issue.status}>
              <Text class="text-[11px] text-fg-3">·</Text>
              <Text class="text-[11px] text-fg-3" style={{ numberOfLines: 1 }}>
                {props.issue.status}
              </Text>
            </If>
            <View class="flex-1" />
            <If when={props.run}>{(run) => <Text class="text-[11px] text-fg-3 tabular-nums">{age(run().updatedAt)}</Text>}</If>
            <If when={props.people.length > 0}>
              <PeopleStack people={props.people} max={2} class="ml-1" />
            </If>
          </View>
          <Text class={cn('mt-0.5 text-[13px] leading-snug text-fg', props.selected ? 'font-semibold' : 'font-medium')} style={{ numberOfLines: 2 }}>
            {props.issue.title}
          </Text>
          <If when={props.run || props.queuePosition}>
            <View class="mt-1 flex-row items-center gap-1.5">
              <If when={props.run}>
                {(run) => (
                  <>
                    <Icon name="git-branch" size={12} tint="fg-3" />
                    <Text class="font-mono text-[11px] text-fg-2" style={{ numberOfLines: 1 }}>
                      {run().branch}
                    </Text>
                  </>
                )}
              </If>
              <View class="flex-1" />
              <If when={props.run?.background?.length}>
                <View class="shrink-0 flex-row items-center gap-0.5" tooltip={t('后台还有 {n} 个任务在跑', { n: props.run?.background?.length ?? 0 })}>
                  <Icon name="terminal" size={12} tint="fg-3" />
                  <Text class="text-[11px] text-fg-3 tabular-nums">{props.run?.background?.length}</Text>
                </View>
              </If>
              <If when={props.run}>{(run) => <CIDot run={run()} />}</If>
              <If when={props.queuePosition} else={<If when={props.run}>{(run) => <PhaseBadge phase={run().phase} recordId={run().recordId} />}</If>}>
                <Text class="text-[11px] text-fg-2">{t('排队第 {n}', { n: props.queuePosition ?? 0 })}</Text>
              </If>
            </View>
          </If>
        </View>
      </View>
    </ContextMenuArea>
  )
}

/**
 * "只看我的" out where it's seen: which issues Teable sends at all, not a view over them — so
 * flipping it reloads, and auto mode only ever sees what this lets through.
 */
function ScopeSwitch() {
  const onlyMine = () => issues.config()?.onlyMine ?? true
  const options = [
    { value: true, label: t('我的') },
    { value: false, label: t('全部') },
  ]
  return (
    <View
      class="h-[22px] shrink-0 flex-row items-center rounded-md bg-fill p-0.5"
      tooltip={t('只拉分配给我的 issue，还是视图里的全部（在 Teable 服务端筛选）')}
    >
      <Each of={options} key={(option) => String(option.value)}>
        {(option) => (
          <View
            class={cn('h-full justify-center rounded-[5px] px-1.5', onlyMine() === option().value && 'bg-bg shadow-xs', issues.loading() && 'opacity-60')}
            role="button"
            disabled={issues.loading()}
            onPress={() => onlyMine() !== option().value && void issues.updateConfig({ onlyMine: option().value })}
          >
            <Text class={cn('text-[11px]', onlyMine() === option().value ? 'font-medium text-fg' : 'text-fg-2')}>{option().label}</Text>
          </View>
        )}
      </Each>
    </View>
  )
}
