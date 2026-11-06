import { Text, View, resource, signal } from 'nsh'
import { t } from '../../../shared/i18n'
import type { WorktreeDbInfo } from '../../../shared/types'
import { Button, Dialog, Field, Segmented, TextInput } from '../../components/kit'
import { Choice } from '../autopilot/parts'
import { api } from '../../lib/api'
import { app } from '../../store/app'

type Mode = 'reuse' | 'clone' | 'new'

/**
 * Cut a worktree from origin/develop with its own ports. The dialog only collects the choice —
 * creation itself runs in the background and reports in the sidebar and the branch's log, because
 * `pnpm install` plus migrations take minutes and a modal would hold the whole window hostage.
 */
export function CreateWorktreeDialog() {
  const close = () => app.set({ showCreate: false })
  const name = signal('')
  // Sharing the main checkout's database is the fast path, and what most fixes want.
  const mode = signal<Mode>('reuse')
  const source = signal('')
  const sources = resource(async () => {
    const info = await api.worktreeDbInfo()
    const withDb = info.filter((entry: WorktreeDbInfo) => entry.databaseName)
    const main = withDb.find((entry) => entry.branchName === 'develop') ?? withDb[0]
    source.set(main?.branchName ?? '')
    if (!main) mode.set('new')
    return withDb
  })
  const branch = () => name().trim()
  const taken = () => app.branches().some((candidate) => candidate.name === branch())
  const ready = () => !!branch() && !taken() && (mode() === 'new' || !!source())
  const create = () => {
    if (!ready()) return
    app.createWorktree(branch(), mode() === 'new' ? { kind: 'new' } : { kind: mode(), sourceBranch: source() })
    close()
  }
  return (
    <Dialog title={t('新建 Worktree')} onClose={close}>
      <Field label={t('分支名（从 origin/develop 切出）')} hint={taken() ? t('已经有这个分支的 worktree 了') : undefined}>
        <TextInput autoFocus value={name()} onChange={(e) => name.set(e.value.replace(/\s/g, '-'))} onSubmit={create} placeholder="fix/my-bug" />
      </Field>
      <Field label={t('数据库')}>
        <Segmented<Mode>
          value={mode()}
          onChange={(value) => mode.set(value)}
          options={[
            { value: 'reuse', label: t('共用') },
            { value: 'clone', label: t('复制') },
            { value: 'new', label: t('新建') },
          ]}
        />
      </Field>
      <If when={mode() !== 'new'}>
        <Field
          label={mode() === 'clone' ? t('从这个 worktree 的数据库复制一份') : t('直接共用这个 worktree 的数据库和 Redis')}
          hint={(sources() ?? []).length ? (mode() === 'reuse' ? t('最快。迁移和数据改动会直接作用在共用的库上。') : undefined) : t('没有找到已配置数据库的 worktree')}
        >
          <Choice
            value={source()}
            onChange={(value) => source.set(value)}
            options={(sources() ?? []).map((info) => ({ value: info.branchName, label: t('{branch}（{database}）', { branch: info.branchName, database: info.databaseName ?? '' }) }))}
          />
        </Field>
      </If>
      <Text class="mb-4 text-[12px] text-muted-foreground">{t('创建在后台进行（安装依赖、迁移大约几分钟），进度和日志会显示在这个分支里，你可以继续做别的事。')}</Text>
      <View class="flex-row justify-end gap-2">
        <Button onPress={close}>{t('取消')}</Button>
        <Button tone="accent" disabled={!ready()} onPress={create}>
          {t('创建')}
        </Button>
      </View>
    </Dialog>
  )
}
