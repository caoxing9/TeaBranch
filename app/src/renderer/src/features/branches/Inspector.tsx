import { FolderOpen, Lock, Plus, Sparkles, Trash2 } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import type { Branch, EnvEntry } from '@shared/types'
import { isLive } from '@shared/types'
import { Button, inputClass, Segmented, Spinner } from '@/components/kit'
import { api, messageOf } from '@/lib/api'
import { cx, formatBytes, formatDuration } from '@/lib/format'
import { statusOf, useApp } from '@/store/app'

export function Inspector({ branch }: { branch: Branch }) {
  const [tab, setTab] = useState<'info' | 'env'>('info')
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-2 py-1.5">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'info', label: '信息' },
            { value: 'env', label: '环境变量' },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{tab === 'info' ? <Info branch={branch} /> : <EnvEditor branch={branch} />}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border px-3.5 py-3">
      <h3 className="mb-2 text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase">{title}</h3>
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-[12px]">
      <span className="text-fg-2">{label}</span>
      <span className="selectable min-w-0 truncate text-right tabular-nums">{children}</span>
    </div>
  )
}

function Info({ branch }: { branch: Branch }) {
  const state = useApp()
  const environment = branch.environment
  const usage = state.usage[branch.name]
  const live = isLive(statusOf(branch))
  const tunnelHere = state.ngrok?.branchName === branch.name ? state.ngrok : null
  const [ngrokBusy, setNgrokBusy] = useState(false)
  const [hasAgentFiles, setHasAgentFiles] = useState(true)

  return (
    <>
      <Section title="资源">
        {usage ? (
          <>
            <Row label="CPU">{usage.cpuPercent.toFixed(1)}%</Row>
            <Row label="内存">{formatBytes(usage.residentBytes)}</Row>
            <Row label="运行时长">{formatDuration(usage.uptimeSeconds)}</Row>
            <div className="mt-2 space-y-0.5">
              {usage.processes.slice(0, 12).map((process) => (
                <div
                  key={process.pid}
                  title={`pid ${process.pid} · up ${formatDuration(process.elapsedSeconds)}`}
                  className="flex items-center gap-2 text-[11px] text-fg-2"
                >
                  <span className="w-14 shrink-0 truncate text-fg-3">{process.group}</span>
                  <span className="min-w-0 flex-1 truncate font-mono">{process.name}</span>
                  <span className="tabular-nums">{formatBytes(process.residentBytes)}</span>
                </div>
              ))}
              {usage.processes.length > 12 && (
                <div className="text-[11px] text-fg-3">另有 {usage.processes.length - 12} 个进程</div>
              )}
            </div>
          </>
        ) : (
          <div className="text-[12px] text-fg-3">{live ? '采样中…' : '未运行'}</div>
        )}
      </Section>

      <Section title="端口">
        {live && environment ? (
          <>
            {environment.port && <Row label="前端">:{environment.port}</Row>}
            {environment.backendPort && <Row label="后端">:{environment.backendPort}</Row>}
            {environment.socketPort && environment.socketPort !== environment.backendPort && (
              <Row label="Socket">:{environment.socketPort}</Row>
            )}
          </>
        ) : (
          <div className="text-[12px] text-fg-3">未运行</div>
        )}
        <div className="mt-2 flex items-center gap-2">
          <Button
            className="h-6 text-[12px]"
            disabled={ngrokBusy}
            icon={ngrokBusy ? <Spinner /> : undefined}
            onClick={async () => {
              setNgrokBusy(true)
              try {
                await api.toggleNgrok(branch.name)
              } catch (error) {
                useApp.setState({ error: messageOf(error) })
              } finally {
                setNgrokBusy(false)
              }
            }}
          >
            {tunnelHere ? '关闭 ngrok 隧道' : 'ngrok 隧道'}
          </Button>
        </div>
        {tunnelHere && (
          <div className="mt-1.5 text-[11px]">
            <a href={tunnelHere.publicURL} target="_blank" rel="noreferrer" className="selectable break-all text-brand">
              {tunnelHere.publicURL}
            </a>
            <span className="text-fg-3"> → :{tunnelHere.port}</span>
          </div>
        )}
      </Section>

      <Section title="Worktree">
        <div className="selectable mb-2 font-mono text-[11px] break-all text-fg-2">
          {environment?.worktreePath ?? branch.worktreePath}
        </div>
        {environment?.databaseName && <Row label="数据库">{environment.databaseName}</Row>}
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button
            className="h-6 text-[12px]"
            icon={<FolderOpen className="size-3.5" />}
            onClick={() => void state.run(null, () => api.revealInFinder(branch.name))}
          >
            Finder
          </Button>
          <Button
            className="h-6 text-[12px]"
            icon={<Sparkles className="size-3.5" />}
            title="打开 Claude Code 为这个 worktree 生成的文件"
            onClick={async () => setHasAgentFiles(await api.revealAgentFiles(branch.name))}
          >
            Agent Files
          </Button>
        </div>
        {!hasAgentFiles && <div className="mt-1 text-[11px] text-fg-3">这个分支还没有 agent 生成的文件</div>}
      </Section>
    </>
  )
}

/** Edit the worktree's own env file; saving a running branch restarts it to pick the change up. */
function EnvEditor({ branch }: { branch: Branch }) {
  const state = useApp()
  const [entries, setEntries] = useState<EnvEntry[] | null>(null)
  const [original, setOriginal] = useState<EnvEntry[]>([])
  const [newKey, setNewKey] = useState('')
  const [filter, setFilter] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void api.envEntries(branch.name).then((loaded) => {
      setEntries(loaded)
      setOriginal(loaded)
    })
  }, [branch.name])

  if (!entries) return <div className="p-4 text-[12px] text-fg-3">读取 .env.development.local…</div>

  const dirty = JSON.stringify(entries) !== JSON.stringify(original)
  const shown = entries.filter((entry) => entry.key.toLowerCase().includes(filter.toLowerCase()))
  const update = (key: string, value: string) =>
    setEntries(entries.map((entry) => (entry.key === key ? { ...entry, value } : entry)))

  const save = async () => {
    setSaving(true)
    try {
      await api.writeEnvEntries(branch.name, entries)
      setOriginal(entries)
      if (isLive(statusOf(branch))) await state.restart(branch.name)
    } catch (error) {
      useApp.setState({ error: messageOf(error) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-3">
      <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="筛选变量" className={cx(inputClass, 'mb-2')} />
      <div className="space-y-1.5">
        {shown.map((entry) => (
          <div key={entry.key}>
            <div className="mb-0.5 flex items-center gap-1 font-mono text-[11px] text-fg-2">
              {entry.managed && (
                <span title="TeaBranch 生成的变量，决定这个 worktree 的隔离">
                  <Lock className="size-3 text-brand" />
                </span>
              )}
              <span className="flex-1 truncate">{entry.key}</span>
              <button
                type="button"
                title={`删除 ${entry.key}`}
                onClick={() => setEntries(entries.filter((candidate) => candidate.key !== entry.key))}
                className="text-fg-3 hover:text-err"
              >
                <Trash2 className="size-3" />
              </button>
            </div>
            <input
              value={entry.value}
              onChange={(event) => update(entry.key, event.target.value)}
              className={cx(inputClass, 'h-6 font-mono text-[11px]')}
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-1.5">
        <input
          value={newKey}
          onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
          placeholder="NEW_KEY"
          className={cx(inputClass, 'h-6 font-mono text-[11px]')}
        />
        <Button
          className="h-6 text-[12px]"
          icon={<Plus className="size-3" />}
          disabled={!newKey || entries.some((entry) => entry.key === newKey)}
          onClick={() => {
            setEntries([...entries, { key: newKey, value: '', managed: false }])
            setNewKey('')
          }}
        >
          添加
        </Button>
      </div>
      {dirty && (
        <div className="sticky bottom-0 mt-3 flex gap-1.5 bg-bg py-2">
          <Button tone="accent" disabled={saving} icon={saving ? <Spinner /> : undefined} onClick={() => void save()}>
            {isLive(statusOf(branch)) ? '保存并重启' : '保存'}
          </Button>
          <Button onClick={() => setEntries(original)}>还原</Button>
        </div>
      )}
    </div>
  )
}
