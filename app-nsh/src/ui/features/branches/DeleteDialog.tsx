import { Text, View } from 'nsh'
import { t } from '../../../shared/i18n'
import { Button, Dialog } from '../../components/kit'
import { app } from '../../store/app'

/**
 * Deleting throws away uncommitted work and a database, and nothing undoes it — the one action
 * that earns a modal. Everything else commits on the click.
 */
export function DeleteDialog(props: { branch: string }) {
  const close = () => app.set({ pendingDelete: null })
  return (
    <Dialog title={t('删除 “{branch}” 的 worktree？', { branch: props.branch })} onClose={close} width={420}>
      <Text class="mb-4 text-[13px] text-fg-2">{t('worktree 目录会被删除，正在运行的服务会先停止。这个操作无法撤销。')}</Text>
      <View class="flex-row justify-end gap-2">
        <Button onPress={close}>{t('取消')}</Button>
        <Button
          tone="danger"
          onPress={() => {
            close()
            void app.remove(props.branch)
          }}
        >
          {t('删除')}
        </Button>
      </View>
    </Dialog>
  )
}
