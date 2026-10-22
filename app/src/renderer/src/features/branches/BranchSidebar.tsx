import { ChevronDown, ChevronRight, MoreHorizontal, Plus, Search, Terminal } from 'lucide-react'
import type { Branch, DevCategory } from '@shared/types'
import { categoryLabel, isLive } from '@shared/types'
import { SectionSwitcher } from '@/components/SectionSwitcher'
import { ContextMenuArea, IconButton, type MenuEntry, type MenuItem, MenuButton, Spinner, StatusDot } from '@/components/kit'
import { api } from '@/lib/api'
import { cx } from '@/lib/format'
import { categoryOf, statusOf, useApp, visibleBranches } from '@/store/app'

const lanes: DevCategory[] = ['developing', 'todo', 'done']

/**
 * The selected row is a raised card, not a tint: over the translucent sidebar a 2% grey
 * difference simply disappears.
 */
export const selectedRow = 'bg-background text-foreground shadow-sm ring-1 ring-border'

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
  const state = useApp()
  const visible = visibleBranches(state)
  const live = state.branches.filter((branch) => isLive(statusOf(branch))).length

  return (
    <>
      <div className="drag h-[38px] shrink-0" />
      <SectionSwitcher />
      <div className="shrink-0 px-2 pt-2 pb-1">
        <div className="flex items-center gap-1">
          <div className="flex h-[26px] flex-1 items-center gap-1.5 rounded-md bg-fill px-2">
            <Search className="size-3.5 text-fg-3" />
            <input
              value={state.search}
              onChange={(event) => state.set({ search: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Escape') state.set({ search: '' })
                if (event.key === 'Enter' && visible[0]) state.set({ selectedBranch: visible[0].name })
              }}
              placeholder="搜索分支"
              className="selectable w-full bg-transparent text-[12.5px] outline-none placeholder:text-fg-3"
            />
          </div>
          <IconButton label="新建分支 (⌘N)" onClick={() => state.set({ showCreate: true })}>
            <Plus className="size-4" />
          </IconButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {Object.entries(state.creating)
          .filter(([name]) => !state.branches.some((branch) => branch.name === name))
          .map(([name, progress]) => (
            <button
              key={name}
              type="button"
              onClick={() => state.set({ selectedBranch: name })}
              className={cx(
                'relative mt-1 mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left',
                state.selectedBranch === name ? selectedRow : 'hover:bg-foreground/[0.06]',
              )}
            >
              <Spinner className="size-3 text-brand" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{name}</div>
                <div className="truncate text-[11px] text-fg-2">{progress.message}</div>
              </div>
            </button>
          ))}
        {state.branches.length === 0 && Object.keys(state.creating).length === 0 ? (
          <div className="px-3 py-10 text-center text-[13px] text-fg-2">
            {state.error ? '读取仓库失败' : '还没有分支，按 ⌘N 新建 worktree。'}
          </div>
        ) : visible.length === 0 ? (
          <div className="px-3 py-10 text-center text-[13px] text-fg-2">没有匹配的分支</div>
        ) : (
          lanes.map((lane) => {
            const branches = visible.filter((branch) => categoryOf(state.categories, branch.name) === lane)
            if (!branches.length) return null
            const collapsed = state.collapsedLanes.includes(lane)
            return (
              <section key={lane} className="mb-1">
                <button
                  type="button"
                  onClick={() => state.toggleLane(lane)}
                  className="flex w-full items-center gap-1 px-2 pt-2 pb-1 text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase hover:text-fg-2"
                >
                  {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                  {categoryLabel[lane]}
                  <span className="font-normal text-fg-3">{branches.length}</span>
                </button>
                {!collapsed && branches.map((branch) => <BranchRow key={branch.name} branch={branch} />)}
              </section>
            )
          })
        )}
      </div>

      <div className="flex h-9 shrink-0 items-center gap-2 border-t border-border px-3 text-[11.5px] text-fg-2">
        {live > 0 ? (
          <span className="flex items-center gap-1.5">
            <StatusDot color="bg-ok" />
            {live} running
          </span>
        ) : (
          <span>{state.branches.length} branches</span>
        )}
        <div className="flex-1" />
        <MenuButton label="排序、外观和设置" entries={() => appMenu(state)}>
          <MoreHorizontal className="size-4" />
        </MenuButton>
      </div>
    </>
  )
}

function appMenu(state: ReturnType<typeof useApp.getState>): MenuEntry[] {
  const sort = (key: typeof state.sortKey, label: string): MenuItem => ({
    label,
    checked: state.sortKey === key,
    onSelect: () => state.set({ sortKey: key, sortAscending: state.sortKey === key ? !state.sortAscending : true }),
  })
  return [
    { label: '排序', items: [sort('name', '名称'), sort('status', '状态'), sort('category', '分类')] },
    {
      label: '外观',
      items: [
        { label: '跟随系统', checked: state.theme === 'system', onSelect: () => state.setTheme('system') },
        { label: '浅色', checked: state.theme === 'light', onSelect: () => state.setTheme('light') },
        { label: '深色', checked: state.theme === 'dark', onSelect: () => state.setTheme('dark') },
      ],
    },
    'separator',
    { label: '打开仓库…', onSelect: () => void state.chooseProject() },
    { label: '设置…', onSelect: () => state.set({ showSettings: true }) },
  ]
}

export function branchMenu(branch: Branch, state: ReturnType<typeof useApp.getState>): MenuEntry[] {
  const live = isLive(statusOf(branch))
  const category = categoryOf(state.categories, branch.name)
  return [
    { label: live ? '停止' : '启动', onSelect: () => void state.toggle(branch), disabled: state.busy.has(branch.name) },
    {
      label: '打开预览',
      onSelect: () => void state.run(null, () => api.openPreview(branch.name)),
      disabled: !branch.environment?.port || !live,
    },
    'separator',
    { label: '打开 Agent', onSelect: () => void state.run(null, () => api.openAgent(branch.name)) },
    { label: '在终端打开', onSelect: () => void state.run(null, () => api.openTerminal(branch.name)) },
    { label: '在 VS Code 打开', onSelect: () => void state.run(null, () => api.openEditor(branch.name)) },
    'separator',
    {
      label: '分类',
      items: lanes.map((lane) => ({
        label: categoryLabel[lane],
        checked: lane === category,
        onSelect: () => void state.setCategory(branch.name, lane),
      })),
    },
    'separator',
    {
      label: '删除 Worktree…',
      danger: true,
      disabled: !branch.managed || branch.isCurrent,
      onSelect: () => state.set({ pendingDelete: branch.name }),
    },
  ]
}

function BranchRow({ branch }: { branch: Branch }) {
  const state = useApp()
  const status = statusOf(branch)
  const selected = state.selectedBranch === branch.name
  const creating = state.creating[branch.name]
  const busy = state.busy.has(branch.name) || !!creating
  const port = branch.environment?.port

  return (
    <ContextMenuArea entries={() => branchMenu(branch, useApp.getState())}>
      <button
        type="button"
        onClick={() => state.set({ selectedBranch: branch.name })}
        className={cx(
          'relative mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left transition-colors',
          selected ? selectedRow : 'hover:bg-foreground/[0.06]',
        )}
      >
        {busy ? <Spinner className="size-2.5 text-fg-2" /> : <StatusDot color={statusColor[status]} pulse={status === 'building'} />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={cx('truncate text-[13px]', selected ? 'font-semibold' : 'font-medium')}>{branch.name}</span>
            {branch.isCurrent && <span className="rounded border px-1 text-[9px] font-semibold text-fg-2">HEAD</span>}
          </div>
          {(isLive(status) || busy) && (
            <div className="mt-px text-[11px] text-fg-2 tabular-nums">
              {creating ? creating.message : busy ? 'Working…' : status === 'running' ? 'Running' : status === 'building' ? 'Building' : ''}
              {port && isLive(status) ? ` · :${port}` : ''}
            </div>
          )}
        </div>
        {state.withTerminal.has(branch.name) && <Terminal className="size-3.5 text-fg-3" aria-label="终端已打开" />}
      </button>
    </ContextMenuArea>
  )
}
