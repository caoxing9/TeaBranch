import { ChevronDown, Code2, FileDiff, GitCommitHorizontal, Globe, Play, RefreshCw, Square, Terminal } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { BranchChanges, Issue, IssueRun } from '@shared/types'
import { isLive } from '@shared/types'
import { Button, IconButton, type MenuEntry, MenuButton, Segmented, Spinner, StatusDot } from '@/components/kit'
import { PersonAvatar } from '@/components/person'
import { t } from '@shared/i18n'
import { api, messageOf } from '@/lib/api'
import { formatBytes, formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { statusOf, useApp } from '@/store/app'
import { useIssues } from '@/store/issues'
import { Attachments } from './IssueExtras'
import { Markdown } from './Markdown'
import { PRTab } from './PRTab'
import { LogPane } from '../branches/LogPane'
import { statusColor } from '../branches/BranchSidebar'

type Tab = 'run' | 'changes' | 'pr' | 'details'

/**
 * Everything reviewing an issue needs beside its conversation: run the fix, see what it changed,
 * read the record — without leaving for the branch page.
 */
export function IssuePanel({ issue, run }: { issue: Issue; run?: IssueRun }) {
  const [tab, setTab] = useState<Tab>(run ? 'run' : 'details')
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b px-3 py-2">
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'run', label: t('运行') },
            { value: 'changes', label: t('改动') },
            ...(run?.prURL ? [{ value: 'pr' as const, label: 'PR' }] : []),
            { value: 'details', label: t('详情') },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1">
        {tab === 'details' ? (
          <Details issue={issue} />
        ) : !run ? (
          <div className="p-6 text-center text-[12.5px] text-muted-foreground">{t('开始修复后，这里可以运行它的分支、查看改动。')}</div>
        ) : tab === 'run' ? (
          <RunTab branch={run.branch} />
        ) : tab === 'pr' && run.prURL ? (
          <PRTab issue={issue} run={run} />
        ) : (
          <ChangesTab branch={run.branch} prURL={run.prURL} />
        )}
      </div>
    </div>
  )
}

/**
 * The issue branch's dev server, from the header: one press starts it and opens the preview once
 * it is up; while it runs the same button is the preview. The rest is in the menu beside it.
 */
export function RunControl({ branch: name }: { branch: string }) {
  const app = useApp()
  const branch = app.branches.find((candidate) => candidate.name === name)
  const status = branch ? statusOf(branch) : 'stopped'
  const [previewWhenUp, setPreviewWhenUp] = useState(false)

  useEffect(() => {
    if (!previewWhenUp || status !== 'running') return
    setPreviewWhenUp(false)
    void app.run(null, () => api.openPreview(name))
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- fire on the status change, not on every store update
  }, [previewWhenUp, status, name])

  // No worktree yet: nothing to run.
  if (!branch) return null
  const live = isLive(status)
  const busy = app.busy.has(name) || status === 'building'
  const port = branch.environment?.port
  const act = (work: () => Promise<unknown>) => void app.run(null, work)
  const start = async () => {
    setPreviewWhenUp(true)
    await app.toggle(branch)
    // It didn't come up (the error is shown): don't pop a preview later out of nowhere.
    const after = useApp.getState().branches.find((candidate) => candidate.name === name)
    if (!after || !isLive(statusOf(after))) setPreviewWhenUp(false)
  }
  const menu = (): MenuEntry[] => [
    { label: t('在分支页打开'), onSelect: () => app.set({ section: 'branches', selectedBranch: name }) },
    'separator',
    { label: t('打开预览'), disabled: status !== 'running' || !port, onSelect: () => act(() => api.openPreview(name)) },
    { label: t('重启'), disabled: !live || app.busy.has(name), onSelect: () => void app.restart(name) },
    { label: live ? t('停止') : t('启动'), disabled: app.busy.has(name), onSelect: () => void app.toggle(branch) },
    'separator',
    { label: t('在终端打开'), onSelect: () => act(() => api.openTerminal(name)) },
    { label: t('在 VS Code 打开'), onSelect: () => act(() => api.openEditor(name)) },
  ]

  return (
    <div className="flex items-center">
      {status === 'running' ? (
        <Button icon={<Globe className="size-3.5" />} title={t('打开预览')} onClick={() => act(() => api.openPreview(name))}>
          {t('预览')}
          {port ? ` :${port}` : ''}
        </Button>
      ) : (
        <Button
          tone="accent"
          disabled={busy}
          icon={busy ? <Spinner /> : <Play className="size-3.5" />}
          title={t('启动这个分支的 dev server，起来后打开预览')}
          onClick={() => void start()}
        >
          {status === 'building' ? t('启动中') : t('启动')}
        </Button>
      )}
      <MenuButton label={t('分支操作')} entries={menu}>
        <ChevronDown className="size-3.5" />
      </MenuButton>
    </div>
  )
}

function RunTab({ branch: name }: { branch: string }) {
  const app = useApp()
  const branch = app.branches.find((candidate) => candidate.name === name)
  if (!branch) return <div className="p-6 text-center text-[12.5px] text-muted-foreground">{t('worktree 还在创建中…')}</div>

  const status = statusOf(branch)
  const live = isLive(status)
  const busy = app.busy.has(name)
  const usage = app.usage[name]
  const environment = branch.environment
  const act = (work: () => Promise<unknown>) => void app.run(null, work)

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-3 border-b p-3">
        <div className="flex items-center gap-2">
          <StatusDot color={statusColor[status]} pulse={status === 'building'} />
          <span className="text-[13px] font-medium">{live ? (status === 'building' ? t('启动中') : t('运行中')) : t('未运行')}</span>
          {usage && (
            <span className="text-[11.5px] text-muted-foreground tabular-nums">
              {usage.cpuPercent.toFixed(0)}% · {formatBytes(usage.residentBytes)} · {formatDuration(usage.uptimeSeconds)}
            </span>
          )}
          <div className="flex-1" />
          <Button
            tone={live ? 'danger' : 'accent'}
            disabled={busy}
            icon={busy ? <Spinner /> : live ? <Square className="size-3" /> : <Play className="size-3.5" />}
            onClick={() => void app.toggle(branch)}
          >
            {live ? t('停止') : t('启动')}
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Button
            icon={<Globe className="size-3.5" />}
            disabled={!live || !environment?.port}
            onClick={() => act(() => api.openPreview(name))}
          >
            {t('预览')}
            {environment?.port && live ? ` :${environment.port}` : ''}
          </Button>
          <IconButton label={t('在终端打开')} onClick={() => act(() => api.openTerminal(name))}>
            <Terminal className="size-4" />
          </IconButton>
          <IconButton label={t('在 VS Code 打开')} onClick={() => act(() => api.openEditor(name))}>
            <Code2 className="size-4" />
          </IconButton>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <LogPane key={name} branch={name} />
      </div>
    </div>
  )
}

function ChangesTab({ branch, prURL }: { branch: string; prURL?: string }) {
  const [changes, setChanges] = useState<BranchChanges | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setChanges(await api.branchChanges(branch))
      setError(null)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setLoading(false)
    }
  }, [branch])

  useEffect(() => void load(), [load])

  const added = changes?.files.reduce((sum, file) => sum + file.added, 0) ?? 0
  const removed = changes?.files.reduce((sum, file) => sum + file.removed, 0) ?? 0

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-[12px]">
        <FileDiff className="size-3.5 text-muted-foreground" />
        <span className="font-medium">{t('{n} 个文件', { n: changes?.files.length ?? 0 })}</span>
        <span className="font-mono text-ok">+{added}</span>
        <span className="font-mono text-err">−{removed}</span>
        <span className="text-muted-foreground">vs {changes?.base ?? 'develop'}</span>
        <div className="flex-1" />
        {prURL && (
          <Button className="h-6 px-2 text-[11.5px]" onClick={() => void api.openExternal(prURL)}>
            PR #{prURL.split('/').pop()}
          </Button>
        )}
        <IconButton label={t('刷新')} onClick={() => void load()}>
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
        </IconButton>
      </div>
      {error && <div className="m-3 rounded-md bg-err-soft px-3 py-2 text-[12px] text-err">{error}</div>}
      {changes && changes.dirty.length > 0 && (
        <div className="mx-3 mt-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-[12px]">
          {t('还有 {n} 个未提交的改动 —— agent 可能还没 commit。', { n: changes.dirty.length })}
        </div>
      )}
      {changes && (
        <>
          <div className="px-3 pt-3 pb-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">{t('文件')}</div>
          {changes.files.length === 0 && <div className="px-3 py-2 text-[12px] text-muted-foreground">{t('还没有提交的改动')}</div>}
          {changes.files.map((file) => (
            <button
              key={file.path}
              type="button"
              title={t('在 VS Code 打开')}
              onClick={() => void api.openFileInEditor(branch, file.path)}
              className="flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] hover:bg-accent"
            >
              <span className="min-w-0 flex-1 truncate font-mono">
                <span className="text-muted-foreground">{file.path.split('/').slice(0, -1).join('/')}/</span>
                {file.path.split('/').pop()}
              </span>
              <span className="font-mono text-[11px] text-ok">+{file.added}</span>
              <span className="font-mono text-[11px] text-err">−{file.removed}</span>
            </button>
          ))}
          {changes.commits.length > 0 && (
            <>
              <div className="px-3 pt-4 pb-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">{t('提交')}</div>
              {changes.commits.map((commit) => (
                <div key={commit.hash} className="flex items-start gap-2 px-3 py-1 text-[12px]">
                  <GitCommitHorizontal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <span className="font-mono text-muted-foreground">{commit.hash}</span>
                  <span className="min-w-0 flex-1">{commit.subject}</span>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  )
}

function Details({ issue }: { issue: Issue }) {
  const fields = useIssues((s) => s.fields)
  const shown = fields.filter((field) => issue.record.fields[field.name])
  return (
    <div className="selectable h-full space-y-3 overflow-y-auto p-3">
      {shown.map((field) => (
        <div key={field.id}>
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">{field.name}</div>
          {issue.record.attachments?.[field.name] ? (
            <Attachments attachments={issue.record.attachments[field.name]} />
          ) : issue.record.people?.[field.name] ? (
            <div className="flex flex-wrap gap-2 text-[12.5px]">
              {issue.record.people[field.name].map((person) => (
                <span key={person.name} className="inline-flex items-center gap-1.5">
                  <PersonAvatar person={person} tooltip={false} />
                  {person.name}
                </span>
              ))}
            </div>
          ) : field.type === 'longText' ? (
            // Long text is where people write Markdown: steps, code, links.
            <div className="text-[12.5px] [&>.prose-chat>:first-child]:mt-0">
              <Markdown text={issue.record.fields[field.name]} />
            </div>
          ) : (
            <div className="text-[12.5px] break-words whitespace-pre-wrap">{issue.record.fields[field.name]}</div>
          )}
        </div>
      ))}
    </div>
  )
}
