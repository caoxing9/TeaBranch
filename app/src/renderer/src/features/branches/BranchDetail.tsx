import { Bot, Check, Code2, Globe, MoreHorizontal, PanelRight, Play, Square, Terminal } from 'lucide-react'
import { useState } from 'react'
import { isLive } from '@shared/types'
import { Button, EmptyState, IconButton, MenuButton, Spinner, StatusDot, TitleStrip } from '@/components/kit'
import { api } from '@/lib/api'
import { cx, formatBytes, formatDuration } from '@/lib/format'
import { statusOf, useApp } from '@/store/app'
import { branchMenu, statusColor } from './BranchSidebar'
import { Inspector } from './Inspector'
import { LogPane } from './LogPane'

const statusText = { running: 'Running', building: 'Building', error: 'Error', stopped: 'Stopped' } as const

export function BranchDetail() {
  const state = useApp()
  const branch = state.branches.find((b) => b.name === state.selectedBranch)
  const [inspector, setInspector] = useState(true)
  const creating = state.selectedBranch ? state.creating[state.selectedBranch] : undefined

  if (creating && state.selectedBranch && !branch)
    return <CreatingView branch={state.selectedBranch} step={creating.step} message={creating.message} />

  if (!branch) {
    return (
      <div className="flex h-full flex-col">
        <TitleStrip />
        <EmptyState
          icon={<PanelRight className="size-9" strokeWidth={1.2} />}
          title="选择一个分支"
          detail="从左侧选择，或按 ⌘N 新建 worktree。"
        />
      </div>
    )
  }

  const status = statusOf(branch)
  const live = isLive(status)
  const busy = state.busy.has(branch.name)
  const usage = state.usage[branch.name]
  const port = branch.environment?.port
  const act = (work: () => Promise<unknown>) => void state.run(null, work)

  return (
    <div className="flex h-full flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[14px] font-semibold">{branch.name}</h1>
            {branch.isCurrent && <span className="rounded bg-fill px-1.5 text-[10px] font-semibold text-fg-2">HEAD</span>}
          </div>
          <div className="mt-px flex items-center gap-1.5 text-[11.5px] text-fg-2">
            <StatusDot color={statusColor[status]} pulse={status === 'building'} />
            <span>{statusText[status]}</span>
            {port && live && <span>· localhost:{port}</span>}
            {usage && (
              <span className="tabular-nums">
                · {usage.cpuPercent.toFixed(0)}% CPU · {formatBytes(usage.residentBytes)} · up {formatDuration(usage.uptimeSeconds)}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-0.5">
          <Button
            tone={live ? 'danger' : 'accent'}
            className="mr-1.5"
            disabled={busy}
            icon={busy ? <Spinner /> : live ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
            onClick={() => void state.toggle(branch)}
          >
            {live ? 'Stop' : 'Start'}
          </Button>
          <Button
            tone="ghost"
            icon={<Globe className="size-3.5" />}
            disabled={!live || !port}
            onClick={() => act(() => api.openPreview(branch.name))}
            title={port ? `打开 http://<branch>.localhost:${port}` : '启动后可预览'}
          >
            Preview
          </Button>
          <Button
            tone="ghost"
            icon={<Bot className="size-3.5" />}
            onClick={() => act(() => api.openAgent(branch.name))}
            title={`在终端新标签里运行 ${state.settings?.agentCommand ?? ''}`}
          >
            Agent
          </Button>
          <Button
            tone="ghost"
            icon={<Terminal className="size-3.5" />}
            onClick={() => act(() => api.openTerminal(branch.name))}
            className={state.withTerminal.has(branch.name) ? 'text-agent' : undefined}
          >
            Terminal
          </Button>
          <Button tone="ghost" icon={<Code2 className="size-3.5" />} onClick={() => act(() => api.openEditor(branch.name))}>
            Code
          </Button>
          <IconButton
            label="端口、数据库和环境变量"
            onClick={() => setInspector(!inspector)}
            className={inspector ? 'bg-fill-hover text-fg' : undefined}
          >
            <PanelRight className="size-4" />
          </IconButton>
          <MenuButton label="更多操作" entries={() => branchMenu(branch, useApp.getState())}>
            <MoreHorizontal className="size-4" />
          </MenuButton>
        </div>
      </header>

      {creating && <CreationSteps step={creating.step} message={creating.message} />}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <LogPane key={branch.name} branch={branch.name} />
        </div>
        {inspector && (
          <div className="w-[300px] shrink-0 border-l border-border bg-sidebar">
            <Inspector key={branch.name} branch={branch} />
          </div>
        )}
      </div>
    </div>
  )
}

const creationSteps = [
  ['fetch', '拉取 develop'],
  ['branch', '创建分支'],
  ['env', '生成环境'],
  ['install', '安装依赖'],
  ['database', '数据库'],
  ['migrate', '迁移'],
] as const

/** Where a background creation has got to, as a row of steps. */
function CreationSteps({ step, message }: { step: string; message: string }) {
  const current = creationSteps.findIndex(([name]) => name === step)
  return (
    <div className="flex shrink-0 items-center gap-3 border-b bg-brand-soft px-4 py-2 text-[12px]">
      {creationSteps.map(([name, label], index) => (
        <span
          key={name}
          className={cx(
            'flex items-center gap-1.5',
            index < current ? 'text-foreground' : index === current ? 'font-medium text-brand' : 'text-muted-foreground',
          )}
        >
          {index < current ? (
            <Check className="size-3.5 text-ok" />
          ) : index === current ? (
            <Spinner className="size-3" />
          ) : (
            <span className="size-1.5 rounded-full bg-current opacity-50" />
          )}
          {label}
        </span>
      ))}
      <span className="ml-auto truncate text-muted-foreground">{message}</span>
    </div>
  )
}

/** A worktree still being created: progress, and the creation log as it streams. */
function CreatingView({ branch, step, message }: { branch: string; step: string; message: string }) {
  return (
    <div className="flex h-full flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center gap-2 border-b px-4">
        <Spinner className="text-brand" />
        <h1 className="truncate text-[14px] font-semibold">{branch}</h1>
        <span className="text-[12px] text-muted-foreground">创建中</span>
      </header>
      <CreationSteps step={step} message={message} />
      <div className="min-h-0 flex-1">
        <LogPane key={branch} branch={branch} />
      </div>
    </div>
  )
}
