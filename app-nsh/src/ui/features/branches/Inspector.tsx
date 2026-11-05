import { type JSX, Scroll, Text, View, openUrl, resource, signal } from 'nsh'
import { t } from '../../../shared/i18n'
import type { Branch, EnvEntry } from '../../../shared/types'
import { isLive } from '../../../shared/types'
import { Icon } from '../../components/Icon'
import { Button, Segmented, Spinner, TextInput } from '../../components/kit'
import { api, messageOf } from '../../lib/api'
import { formatBytes, formatDuration } from '../../lib/format'
import { app, statusOf } from '../../store/app'

export function Inspector(props: { branch: Branch }) {
  const tab = signal<'info' | 'env'>('info')
  return (
    <View class="flex-1">
      <View class="shrink-0 border-b border-border px-2 py-1.5">
        <Segmented
          value={tab()}
          onChange={(value) => tab.set(value)}
          options={[
            { value: 'info', label: t('信息') },
            { value: 'env', label: t('环境变量') },
          ]}
        />
      </View>
      <Scroll class="min-h-0 flex-1">
        <If when={tab() === 'info'} else={<EnvEditor branch={props.branch} />}>
          <Info branch={props.branch} />
        </If>
      </Scroll>
    </View>
  )
}

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <View class="border-b border-border px-3.5 py-3">
      <Text class="mb-2 text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase">{props.title}</Text>
      {props.children}
    </View>
  )
}

function Row(props: { label: string; children: string }) {
  return (
    <View class="flex-row items-baseline justify-between gap-3 py-0.5">
      <Text class="text-[12px] text-fg-2">{props.label}</Text>
      <Text class="min-w-0 text-right text-[12px] text-fg tabular-nums" style={{ numberOfLines: 1, userSelect: 'text' }}>
        {props.children}
      </Text>
    </View>
  )
}

function Info(props: { branch: Branch }) {
  const environment = () => props.branch.environment
  const usage = () => app.usage()[props.branch.name]
  const live = () => isLive(statusOf(props.branch))
  const tunnelHere = () => (app.ngrok()?.branchName === props.branch.name ? app.ngrok() : null)
  const ngrokBusy = signal(false)
  const hasAgentFiles = signal(true)
  const toggleNgrok = async () => {
    ngrokBusy.set(true)
    try {
      await api.toggleNgrok(props.branch.name)
    } catch (error) {
      app.set({ error: messageOf(error) })
    } finally {
      ngrokBusy.set(false)
    }
  }
  return (
    <>
      <Section title={t('资源')}>
        <If when={usage()} else={<Text class="text-[12px] text-fg-3">{live() ? t('采样中…') : t('未运行')}</Text>}>
          {(u) => (
            <>
              <Row label="CPU">{`${u().cpuPercent.toFixed(1)}%`}</Row>
              <Row label={t('内存')}>{formatBytes(u().residentBytes)}</Row>
              <Row label={t('运行时长')}>{formatDuration(u().uptimeSeconds)}</Row>
              <View class="mt-2 gap-0.5">
                <Each of={u().processes.slice(0, 12)} key={(process) => String(process.pid)}>
                  {(process) => (
                    <View class="flex-row items-center gap-2" tooltip={`pid ${process().pid} · ${t('已运行 {duration}', { duration: formatDuration(process().elapsedSeconds) })}`}>
                      <Text class="w-14 shrink-0 text-[11px] text-fg-3" style={{ numberOfLines: 1 }}>
                        {process().group}
                      </Text>
                      <Text class="min-w-0 flex-1 font-mono text-[11px] text-fg-2" style={{ numberOfLines: 1 }}>
                        {process().name}
                      </Text>
                      <Text class="text-[11px] text-fg-2 tabular-nums">{formatBytes(process().residentBytes)}</Text>
                    </View>
                  )}
                </Each>
                <If when={u().processes.length > 12}>
                  <Text class="text-[11px] text-fg-3">{t('另有 {n} 个进程', { n: u().processes.length - 12 })}</Text>
                </If>
              </View>
            </>
          )}
        </If>
      </Section>
      <Section title={t('端口')}>
        <If when={live() ? environment() : undefined} else={<Text class="text-[12px] text-fg-3">{t('未运行')}</Text>}>
          {(env) => (
            <>
              <If when={env().port}>
                <Row label={t('前端')}>{`:${env().port}`}</Row>
              </If>
              <If when={env().backendPort}>
                <Row label={t('后端')}>{`:${env().backendPort}`}</Row>
              </If>
              <If when={env().socketPort && env().socketPort !== env().backendPort}>
                <Row label="Socket">{`:${env().socketPort}`}</Row>
              </If>
            </>
          )}
        </If>
        <View class="mt-2 flex-row items-center gap-2">
          <Button class="h-6" disabled={ngrokBusy()} icon={ngrokBusy() ? <Spinner /> : undefined} onPress={() => void toggleNgrok()}>
            {tunnelHere() ? t('关闭 ngrok 隧道') : t('ngrok 隧道')}
          </Button>
        </View>
        <If when={tunnelHere()}>
          {(tunnel) => (
            <View class="mt-1.5 flex-row flex-wrap items-center">
              <Text class="text-[11px] text-brand" style={{ userSelect: 'text' }} onPress={() => void openUrl(tunnel().publicURL)}>
                {tunnel().publicURL}
              </Text>
              <Text class="text-[11px] text-fg-3"> → :{tunnel().port}</Text>
            </View>
          )}
        </If>
      </Section>
      <Section title="Worktree">
        <Text class="mb-2 font-mono text-[11px] text-fg-2" style={{ userSelect: 'text' }}>
          {environment()?.worktreePath ?? props.branch.worktreePath}
        </Text>
        <If when={environment()?.databaseName}>
          <Row label={t('数据库')}>{environment()?.databaseName ?? ''}</Row>
        </If>
        <View class="mt-2 flex-row flex-wrap gap-1.5">
          <Button class="h-6" icon={<Icon name="folder-open" size={14} tint="fg-2" />} onPress={() => void app.run(null, () => api.revealInFinder(props.branch.name))}>
            Finder
          </Button>
          <Button
            class="h-6"
            icon={<Icon name="sparkles" size={14} tint="fg-2" />}
            title={t('打开 Claude Code 为这个 worktree 生成的文件')}
            onPress={() => void api.revealAgentFiles(props.branch.name).then((has) => hasAgentFiles.set(has))}
          >
            {t('Agent 文件')}
          </Button>
        </View>
        <If when={!hasAgentFiles()}>
          <Text class="mt-1 text-[11px] text-fg-3">{t('这个分支还没有 agent 生成的文件')}</Text>
        </If>
      </Section>
    </>
  )
}

/** Edit the worktree's own env file; saving a running branch restarts it to pick the change up. */
function EnvEditor(props: { branch: Branch }) {
  const loaded = resource(
    () => props.branch.name,
    (name) => api.envEntries(name),
  )
  const entries = signal<EnvEntry[] | null>(null)
  const original = signal<EnvEntry[]>([])
  const newKey = signal('')
  const filter = signal('')
  const saving = signal(false)
  // The first load, and a switch of branch, replace what is being edited.
  const seen = signal<string | null>(null)
  const current = (): EnvEntry[] | null => {
    const list = loaded()
    if (list && seen() !== props.branch.name) {
      seen.set(props.branch.name)
      entries.set(list)
      original.set(list)
    }
    return entries()
  }
  const dirty = () => JSON.stringify(entries()) !== JSON.stringify(original())
  const shown = () => (entries() ?? []).filter((entry) => entry.key.toLowerCase().includes(filter().toLowerCase()))
  const update = (key: string, value: string) => entries.set((entries() ?? []).map((entry) => (entry.key === key ? { ...entry, value } : entry)))
  const save = async () => {
    saving.set(true)
    try {
      await api.writeEnvEntries(props.branch.name, entries() ?? [])
      original.set(entries() ?? [])
      if (isLive(statusOf(props.branch))) await app.restart(props.branch.name)
    } catch (error) {
      app.set({ error: messageOf(error) })
    } finally {
      saving.set(false)
    }
  }
  return (
    <If when={current()} else={<Text class="p-4 text-[12px] text-fg-3">{t('读取 .env.development.local…')}</Text>}>
      <View class="p-3">
        <TextInput value={filter()} onChange={(e) => filter.set(e.value)} placeholder={t('筛选变量')} class="mb-2" />
        <View class="gap-1.5">
          <Each of={shown()} key={(entry) => entry.key}>
            {(entry) => (
              <View>
                <View class="mb-0.5 flex-row items-center gap-1">
                  <If when={entry().managed}>
                    <View tooltip={t('TeaBranch 生成的变量，决定这个 worktree 的隔离')}>
                      <Icon name="lock" size={12} tint="brand" />
                    </View>
                  </If>
                  <Text class="flex-1 font-mono text-[11px] text-fg-2" style={{ numberOfLines: 1 }}>
                    {entry().key}
                  </Text>
                  <View role="button" tooltip={t('删除 {name}', { name: entry().key })} onPress={() => entries.set((entries() ?? []).filter((candidate) => candidate.key !== entry().key))}>
                    <Icon name="trash-2" size={12} tint="fg-3" />
                  </View>
                </View>
                <TextInput value={entry().value} onChange={(e) => update(entry().key, e.value)} class="h-6 font-mono text-[11px]" />
              </View>
            )}
          </Each>
        </View>
        <View class="mt-3 flex-row gap-1.5">
          <TextInput
            value={newKey()}
            onChange={(e) => newKey.set(e.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
            placeholder="NEW_KEY"
            class="h-6 flex-1 font-mono text-[11px]"
          />
          <Button
            class="h-6"
            icon={<Icon name="plus" size={12} tint="fg-2" />}
            disabled={!newKey() || (entries() ?? []).some((entry) => entry.key === newKey())}
            onPress={() => {
              entries.set([...(entries() ?? []), { key: newKey(), value: '', managed: false }])
              newKey.set('')
            }}
          >
            {t('添加')}
          </Button>
        </View>
        <If when={dirty()}>
          <View class="mt-3 flex-row gap-1.5 bg-bg py-2">
            <Button tone="accent" disabled={saving()} icon={saving() ? <Spinner /> : undefined} onPress={() => void save()}>
              {isLive(statusOf(props.branch)) ? t('保存并重启') : t('保存')}
            </Button>
            <Button onPress={() => entries.set(original())}>{t('还原')}</Button>
          </View>
        </If>
      </View>
    </If>
  )
}
