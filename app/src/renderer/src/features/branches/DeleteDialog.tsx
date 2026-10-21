import { Button, Dialog } from '@/components/kit'
import { useApp } from '@/store/app'

/**
 * Deleting throws away uncommitted work and a database, and nothing undoes it — the one action
 * that earns a modal. Everything else commits on the click.
 */
export function DeleteDialog({ branch }: { branch: string }) {
  const close = () => useApp.setState({ pendingDelete: null })
  const remove = useApp((s) => s.remove)
  return (
    <Dialog title={`删除 “${branch}” 的 worktree？`} onClose={close} width={420}>
      <p className="mb-4 text-[13px] text-fg-2">worktree 目录会被删除，正在运行的服务会先停止。这个操作无法撤销。</p>
      <div className="flex justify-end gap-2">
        <Button onClick={close}>取消</Button>
        <Button
          tone="danger"
          onClick={() => {
            close()
            void remove(branch)
          }}
        >
          删除
        </Button>
      </div>
    </Dialog>
  )
}
