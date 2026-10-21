import { ChevronDown, ChevronRight, Filter, GitBranch, MoreHorizontal, Pause, Play, RefreshCw, Search } from 'lucide-react'
import { useRef, useState } from 'react'
import type { Issue, IssuePhase, IssueRun, Person } from '@shared/types'
import { isActivePhase, phaseLabel } from '@shared/types'
import { SectionSwitcher } from '@/components/SectionSwitcher'
import { Button, IconButton, type MenuEntry, MenuButton, Spinner, StatusDot, Toggle } from '@/components/kit'
import { api } from '@/lib/api'
import { assigneeGuess } from '@/lib/issues'
import { selectedRow } from '../branches/BranchSidebar'
import { issuePeople } from '@/lib/people'
import { PeopleStack, PersonAvatar } from '@/components/person'
import { cx } from '@/lib/format'
import { fixable, useIssues, visibleIssues } from '@/store/issues'

export const phaseColor: Record<IssuePhase, string> = {
  queued: 'text-agent',
  preparing: 'text-agent',
  fixing: 'text-agent',
  reviewing: 'text-agent',
  prOpen: 'text-ok',
  finished: 'text-fg-2',
  cancelled: 'text-fg-2',
  failed: 'text-err',
}

export function PhaseBadge({ phase }: { phase: IssuePhase }) {
  return (
    <span className={cx('inline-flex items-center gap-1 text-[10px] font-medium whitespace-nowrap', phaseColor[phase])}>
      {isActivePhase(phase) ? <Spinner className="size-2.5" /> : <span className="size-1.5 rounded-full bg-current" />}
      {phaseLabel[phase]}
    </span>
  )
}

export function IssueSidebar() {
  const state = useIssues()
  const visible = visibleIssues(state)
  const lastClicked = useRef<string | null>(null)
  const active = Object.values(state.runs).filter((run) => isActivePhase(run.phase)).length
  const assignee = state.config && assigneeGuess(state.config, state.fields)
  const filterCount = Object.values(state.fieldFilters).filter((values) => values.length).length

  /**
   * A plain click opens the issue. Ticking is separate — the checkbox, or ⌘-click to toggle and
   * ⇧-click to tick a range from the last one — so a batch can be built while one issue is open.
   */
  const click = (issue: Issue, event: React.MouseEvent) => {
    if (!event.metaKey && !event.shiftKey) {
      lastClicked.current = issue.id
      state.select(new Set([issue.id]))
      return
    }
    const next = new Set(state.checked)
    if (event.shiftKey && lastClicked.current) {
      const from = visible.findIndex((candidate) => candidate.id === lastClicked.current)
      const to = visible.findIndex((candidate) => candidate.id === issue.id)
      if (from >= 0 && to >= 0) {
        for (let i = Math.min(from, to); i <= Math.max(from, to); i++) next.add(visible[i].id)
      }
    } else if (next.has(issue.id)) {
      next.delete(issue.id)
    } else {
      next.add(issue.id)
    }
    lastClicked.current = issue.id
    state.setChecked(next)
  }

  const toggleChecked = (id: string) => {
    const next = new Set(state.checked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    lastClicked.current = id
    state.setChecked(next)
  }

  const visibleIds = visible.map((issue) => issue.id)
  const checkedVisible = visibleIds.filter((id) => state.checked.has(id)).length
  const allChecked = visibleIds.length > 0 && checkedVisible === visibleIds.length

  const filterMenu = (): MenuEntry[] => {
    const selectable = state.fields.filter(
      (field) => (field.type === 'singleSelect' || field.type === 'multipleSelect') && field.choices.length,
    )
    const entries: MenuEntry[] = selectable.length
      ? selectable.map((field) => ({
          label: field.name,
          items: field.choices.map((choice) => ({
            label: choice,
            checked: state.fieldFilters[field.name]?.includes(choice),
            onSelect: () => state.toggleFieldFilter(field.name, choice),
          })),
        }))
      : [{ label: '没有可筛选的单选/多选字段', disabled: true }]
    if (filterCount) entries.push('separator', { label: '清除筛选', onSelect: state.clearFieldFilters })
    return entries
  }

  return (
    <>
      <div className="drag h-[38px] shrink-0" />
      <SectionSwitcher />
      <div
        className="shrink-0 px-2 pt-2 pb-1"
        onKeyDown={(event) => {
          if (event.key === 'a' && event.metaKey) {
            event.preventDefault()
            state.setChecked(new Set(visible.map((issue) => issue.id)))
          }
        }}
      >
        <div className="flex items-center gap-1">
          <div className="flex h-[26px] flex-1 items-center gap-1.5 rounded-md bg-fill px-2">
            <Search className="size-3.5 text-fg-3" />
            <input
              value={state.search}
              onChange={(event) => useIssues.setState({ search: event.target.value })}
              placeholder="搜索 issue"
              className="selectable w-full bg-transparent text-[12.5px] outline-none placeholder:text-fg-3"
            />
          </div>
          <MenuButton label="按字段筛选" entries={filterMenu} className={filterCount ? 'text-brand' : undefined}>
            <Filter className="size-4" fill={filterCount ? 'currentColor' : 'none'} />
          </MenuButton>
        </div>
        <div className="mt-2 flex items-center gap-2 px-0.5 text-[11.5px] text-fg-2">
          <Toggle
            checked={state.config?.onlyMine ?? true}
            onChange={(onlyMine) => void state.updateConfig({ onlyMine })}
            label={<span>只看我的{state.config?.onlyMine && assignee ? <span className="text-fg-3">（{assignee} = 我）</span> : null}</span>}
          />
          <div className="flex-1" />
          <span className="tabular-nums">{visible.length} 个</span>
        </div>
        <div className="mt-1.5 flex h-6 items-center gap-2 rounded-md px-1 text-[11.5px] text-fg-2">
          <input
            type="checkbox"
            title="全选当前列表（⌘A）"
            className="size-3.5 accent-brand"
            disabled={!visible.length}
            checked={allChecked}
            ref={(element) => {
              if (element) element.indeterminate = checkedVisible > 0 && !allChecked
            }}
            onChange={() => state.setChecked(allChecked ? new Set() : new Set([...state.checked, ...visibleIds]))}
          />
          {state.checked.size > 0 ? (
            <>
              <span className="text-fg">已选 {state.checked.size}</span>
              <button
                type="button"
                className="hover:text-fg"
                title="当前列表里没勾的勾上、勾了的取消"
                onClick={() => {
                  const next = new Set(state.checked)
                  for (const id of visibleIds) {
                    if (next.has(id)) next.delete(id)
                    else next.add(id)
                  }
                  state.setChecked(next)
                }}
              >
                反选
              </button>
              <button type="button" className="hover:text-fg" onClick={() => state.setChecked(new Set())}>
                清空
              </button>
            </>
          ) : (
            <span className="text-fg-3">勾选 issue 批量修复</span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" tabIndex={-1}>
        {!state.user ? (
          <div className="px-3 py-10 text-center text-[13px] text-fg-2">未登录 Teable</div>
        ) : visible.length === 0 ? (
          <div className="px-3 py-10 text-center text-[13px] text-fg-2">{state.loading ? '加载中…' : '没有 issue'}</div>
        ) : (
          <IssueGroups visible={visible} click={click} toggleChecked={toggleChecked} />
        )}
      </div>

      {state.checked.size > 0 && (
        <div className="flex h-10 shrink-0 items-center gap-2 border-t border-border bg-brand-soft px-3 text-[12px]">
          <span className="font-medium">已选 {state.checked.size} 个</span>
          <div className="flex-1" />
          <Button tone="accent" className="h-6 px-2 text-[11.5px]" onClick={() => state.select(new Set())}>
            批量修复…
          </Button>
        </div>
      )}
      {state.user && <QueueBar />}

      <div className="flex h-9 shrink-0 items-center gap-2 border-t border-border px-3 text-[11.5px] text-fg-2">
        {state.user && <PersonAvatar person={{ name: state.user.name, email: state.user.email, avatar: state.user.avatar }} />}
        <span className="truncate font-medium text-fg">{state.user?.name ?? '未登录'}</span>
        {active > 0 && <span className="text-agent">· {active} 进行中</span>}
        <div className="flex-1" />
        <IconButton label="刷新" disabled={!state.user || state.loading} onClick={() => void state.reload()}>
          <RefreshCw className={cx('size-3.5', state.loading && 'animate-spin')} />
        </IconButton>
        <MenuButton
          label="更多"
          entries={() => {
            const queueable = fixable(visible, state.runs).filter((issue) => !state.runs[issue.id])
            return [
              {
                label: `把列表里 ${queueable.length} 个未处理的加入队列`,
                disabled: !queueable.length,
                onSelect: () => void state.perform(() => api.enqueueFix(queueable)),
              },
              'separator',
              { label: 'Issue 设置…', onSelect: () => useIssues.setState({ showSettings: true }) },
              ...(state.user ? [{ label: '退出 Teable', onSelect: () => void state.signOut() }] : []),
            ]
          }}
        >
          <MoreHorizontal className="size-4" />
        </MenuButton>
      </div>
    </>
  )
}

type Group = 'active' | 'review' | 'attention' | 'untouched'

const groupLabel: Record<Group, string> = {
  active: '进行中',
  review: '待审查',
  attention: '需要你处理',
  untouched: '未开始',
}

/** Where an issue sits in the issue-driven flow: what needs you now comes first. */
function groupOf(run: IssueRun | undefined, queued: boolean): Group {
  if (queued || (run && isActivePhase(run.phase))) return 'active'
  if (!run) return 'untouched'
  if (run.phase === 'prOpen') return 'review'
  return 'attention'
}

const loadCollapsed = (): Group[] => {
  try {
    return JSON.parse(localStorage.getItem('teabranch.issueGroups') ?? '[]')
  } catch {
    return []
  }
}

function IssueGroups({
  visible,
  click,
  toggleChecked,
}: {
  visible: Issue[]
  click: (issue: Issue, event: React.MouseEvent) => void
  toggleChecked: (id: string) => void
}) {
  const state = useIssues()
  const [collapsed, setCollapsed] = useState<Group[]>(loadCollapsed)
  const toggle = (group: Group) => {
    const next = collapsed.includes(group) ? collapsed.filter((g) => g !== group) : [...collapsed, group]
    localStorage.setItem('teabranch.issueGroups', JSON.stringify(next))
    setCollapsed(next)
  }
  const groups = (['active', 'review', 'attention', 'untouched'] as Group[]).map((group) => ({
    group,
    issues: visible.filter((issue) => groupOf(state.runs[issue.id], state.queue.waiting.includes(issue.id)) === group),
  }))
  return (
    <>
      {groups.map(({ group, issues }) =>
        issues.length === 0 ? null : (
          <section key={group} className="mb-1">
            <button
              type="button"
              onClick={() => toggle(group)}
              className="flex w-full items-center gap-1 px-2 pt-2 pb-1 text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase hover:text-fg-2"
            >
              {collapsed.includes(group) ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
              {groupLabel[group]}
              <span className="font-normal">{issues.length}</span>
            </button>
            {!collapsed.includes(group) &&
              issues.map((issue) => (
                <IssueRow
                  key={issue.id}
                  issue={issue}
                  people={issuePeople(issue, state.config, state.fields)}
                  run={state.runs[issue.id]}
                  queuePosition={state.queue.waiting.indexOf(issue.id) + 1 || undefined}
                  selected={state.selection.has(issue.id)}
                  checked={state.checked.has(issue.id)}
                  checking={state.checked.size > 0}
                  onClick={(event) => click(issue, event)}
                  onToggleCheck={() => toggleChecked(issue.id)}
                />
              ))}
          </section>
        ),
      )}
    </>
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
function IssueRow({
  issue,
  people,
  run,
  queuePosition,
  selected,
  checked,
  checking,
  onClick,
  onToggleCheck,
}: {
  issue: Issue
  people: Person[]
  run?: IssueRun
  queuePosition?: number
  selected: boolean
  checked: boolean
  /** Something is ticked: every row shows its checkbox, not just the hovered one. */
  checking: boolean
  onClick: (event: React.MouseEvent) => void
  onToggleCheck: () => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      className={cx(
        'group relative mb-0.5 flex w-full cursor-default gap-2 rounded-lg py-2 pr-2.5 pl-1.5 text-left transition-colors',
        selected ? selectedRow : checked ? 'bg-brand-soft' : 'hover:bg-foreground/[0.06]',
      )}
    >
      <span className="flex w-4 shrink-0 justify-center pt-[3px]">
        <input
          type="checkbox"
          checked={checked}
          onClick={(event) => event.stopPropagation()}
          onChange={onToggleCheck}
          aria-label={`勾选 ${issue.key}`}
          className={cx('size-3.5 cursor-pointer accent-brand', checked || checking ? 'opacity-100' : 'opacity-50 group-hover:opacity-100')}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[11px] text-fg-3">
          <span className="font-mono">{issue.key}</span>
          {issue.status && (
            <>
              <span>·</span>
              <span className="truncate">{issue.status}</span>
            </>
          )}
          <div className="flex-1" />
          {run && <span className="tabular-nums">{age(run.updatedAt)}</span>}
          {people.length > 0 && <PeopleStack people={people} max={2} className="ml-1" />}
        </div>
        <div className={cx('mt-0.5 line-clamp-2 text-[13px] leading-snug', selected ? 'font-semibold' : 'font-medium')}>
          {issue.title}
        </div>
        {(run || queuePosition) && (
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-fg-2">
            {run && (
              <>
                <GitBranch className="size-3 shrink-0 text-fg-3" />
                <span className="truncate font-mono">{run.branch}</span>
              </>
            )}
            <div className="flex-1" />
            {queuePosition ? <span>排队第 {queuePosition}</span> : run ? <PhaseBadge phase={run.phase} /> : null}
          </div>
        )}
      </div>
    </div>
  )
}

/** The batch in progress and the queue behind it, with the go-ahead for the next batch. */
function QueueBar() {
  const queue = useIssues((s) => s.queue)
  const batchSize = useIssues((s) => s.config?.batchSize ?? 3)
  const perform = useIssues((s) => s.perform)
  if (!queue.batch.length && !queue.waiting.length) return null
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-t border-border bg-fill px-3 text-[11.5px] font-medium text-fg-2">
      {queue.awaitingNextBatch ? (
        <>
          <Pause className="size-3.5 text-warn" />
          <span className="flex-1">本批已完成，等你审查</span>
          <Button
            tone="accent"
            className="h-6 px-2 text-[11px]"
            icon={<Play className="size-3" />}
            title={`从排队的 ${queue.waiting.length} 个里取下一批 ${Math.min(queue.waiting.length, batchSize)} 个`}
            onClick={() => void perform(() => api.startNextBatch())}
          >
            开始下一批
          </Button>
        </>
      ) : (
        <>
          {queue.batch.length > 0 && (
            <>
              <StatusDot color="bg-agent" pulse />
              <span>
                本批 {queue.settled}/{queue.batch.length} 完成
              </span>
            </>
          )}
          <div className="flex-1" />
          {queue.waiting.length > 0 && <span>排队 {queue.waiting.length}</span>}
        </>
      )}
    </div>
  )
}
