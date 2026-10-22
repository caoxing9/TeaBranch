import { useEffect, useState } from 'react'
import type { WorktreeDbInfo } from '@shared/types'
import { Button, Dialog, Field, inputClass, Segmented } from '@/components/kit'
import { api } from '@/lib/api'
import { useApp } from '@/store/app'

type Mode = 'reuse' | 'clone' | 'new'

/**
 * Cut a worktree from origin/develop with its own ports. The dialog only collects the choice —
 * creation itself runs in the background and reports in the sidebar and the branch's log, because
 * `pnpm install` plus migrations take minutes and a modal would hold the whole window hostage.
 */
export function CreateWorktreeDialog() {
  const close = () => useApp.setState({ showCreate: false })
  const createWorktree = useApp((s) => s.createWorktree)
  const existing = useApp((s) => s.branches)
  const [name, setName] = useState('')
  // Sharing the main checkout's database is the fast path, and what most fixes want.
  const [mode, setMode] = useState<Mode>('reuse')
  const [sources, setSources] = useState<WorktreeDbInfo[]>([])
  const [source, setSource] = useState('')

  useEffect(() => {
    void api.worktreeDbInfo().then((info) => {
      const withDb = info.filter((entry) => entry.databaseName)
      setSources(withDb)
      const main = withDb.find((entry) => entry.branchName === 'develop') ?? withDb[0]
      setSource(main?.branchName ?? '')
      if (!main) setMode('new')
    })
  }, [])

  const branch = name.trim()
  const taken = existing.some((candidate) => candidate.name === branch)
  const create = () => {
    if (!branch || taken || (mode !== 'new' && !source)) return
    createWorktree(branch, mode === 'new' ? { kind: 'new' } : { kind: mode, sourceBranch: source })
    close()
  }

  return (
    <Dialog title="新建 Worktree" onClose={close}>
      <Field label="分支名（从 origin/develop 切出）" hint={taken ? '已经有这个分支的 worktree 了' : undefined}>
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value.replace(/\s/g, '-'))}
          onKeyDown={(event) => event.key === 'Enter' && create()}
          placeholder="fix/my-bug"
          className={inputClass}
        />
      </Field>
      <Field label="数据库">
        <Segmented<Mode>
          value={mode}
          onChange={setMode}
          options={[
            { value: 'reuse', label: '共用' },
            { value: 'clone', label: '复制' },
            { value: 'new', label: '新建' },
          ]}
        />
      </Field>
      {mode !== 'new' && (
        <Field
          label={mode === 'clone' ? '从这个 worktree 的数据库复制一份' : '直接共用这个 worktree 的数据库和 Redis'}
          hint={
            sources.length
              ? mode === 'reuse'
                ? '最快。迁移和数据改动会直接作用在共用的库上。'
                : undefined
              : '没有找到已配置数据库的 worktree'
          }
        >
          <select value={source} onChange={(event) => setSource(event.target.value)} className={inputClass}>
            {sources.map((info) => (
              <option key={info.branchName} value={info.branchName}>
                {info.branchName}（{info.databaseName}）
              </option>
            ))}
          </select>
        </Field>
      )}
      <p className="mb-4 text-[12px] text-muted-foreground">
        创建在后台进行（安装依赖、迁移大约几分钟），进度和日志会显示在这个分支里，你可以继续做别的事。
      </p>
      <div className="flex justify-end gap-2">
        <Button onClick={close}>取消</Button>
        <Button tone="accent" disabled={!branch || taken || (mode !== 'new' && !source)} onClick={create}>
          创建
        </Button>
      </div>
    </Dialog>
  )
}
