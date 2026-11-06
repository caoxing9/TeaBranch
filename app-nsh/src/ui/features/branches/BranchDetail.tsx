import { Text, View, signal } from 'nsh'
import { t } from '../../../shared/i18n'
import { isLive } from '../../../shared/types'
import { Icon } from '../../components/Icon'
import { Button, EmptyState, IconButton, MenuButton, Spinner, StatusDot, TitleStrip } from '../../components/kit'
import { api } from '../../lib/api'
import { formatBytes, formatDuration } from '../../lib/format'
import { cn } from '../../lib/utils'
import { app, statusOf } from '../../store/app'
import { branchMenu, statusColor } from './BranchSidebar'
import { Inspector } from './Inspector'
import { LogPane } from './LogPane'

const statusText = (status: 'running' | 'building' | 'error' | 'stopped'): string =>
  ({ running: t('运行中'), building: t('构建中'), error: t('出错'), stopped: t('已停止') })[status]

export function BranchDetail() {
  const branch = () => app.branches().find((b) => b.name === app.selectedBranch())
  const creating = () => (app.selectedBranch() ? app.creating()[app.selectedBranch() as string] : undefined)
  const inspector = signal(true)
  return (
    <If
      when={branch()}
      else={
        <If
          when={creating() && app.selectedBranch()}
          else={
            <View class="flex-1">
              <TitleStrip />
              <EmptyState icon={<Icon name="panel-right" size={28} tint="fg-2" />} title={t('选择一个分支')} detail={t('从左侧选择，或按 ⌘N 新建 worktree。')} />
            </View>
          }
        >
          {(name) => <CreatingView branch={name()} step={creating()?.step ?? ''} message={creating()?.message ?? ''} />}
        </If>
      }
    >
      {(current) => {
        const status = () => statusOf(current())
        const live = () => isLive(status())
        const busy = () => app.busy().has(current().name)
        const usage = () => app.usage()[current().name]
        const port = () => current().environment?.port
        const act = (work: () => Promise<unknown>) => void app.run(null, work)
        return (
          <View class="flex-1">
            <View class="h-[52px] shrink-0 flex-row items-center gap-3 border-b border-border px-4" desktop={{ windowDrag: true }}>
              <View class="min-w-0 flex-1">
                <View class="flex-row items-center gap-2">
                  <Text class="text-[14px] font-semibold text-fg" style={{ numberOfLines: 1 }}>
                    {current().name}
                  </Text>
                  <If when={current().isCurrent}>
                    <View class="rounded bg-fill px-1.5">
                      <Text class="text-[10px] font-semibold text-fg-2">HEAD</Text>
                    </View>
                  </If>
                </View>
                <View class="mt-px flex-row items-center gap-1.5">
                  <StatusDot color={statusColor[status()]} pulse={status() === 'building'} />
                  <Text class="text-[11.5px] text-fg-2">{statusText(status())}</Text>
                  <If when={port() && live()}>
                    <Text class="text-[11.5px] text-fg-2">· localhost:{port()}</Text>
                  </If>
                  <If when={usage()}>
                    {(u) => (
                      <Text class="text-[11.5px] text-fg-2 tabular-nums">
                        · {u().cpuPercent.toFixed(0)}% CPU · {formatBytes(u().residentBytes)} · {t('已运行 {duration}', { duration: formatDuration(u().uptimeSeconds) })}
                      </Text>
                    )}
                  </If>
                </View>
              </View>
              <View class="flex-row items-center gap-0.5">
                <Button
                  tone={live() ? 'danger' : 'accent'}
                  class="mr-1.5"
                  disabled={busy()}
                  icon={busy() ? <Spinner /> : <Icon name={live() ? 'square' : 'play'} size={14} tint="#ffffff" />}
                  onPress={() => void app.toggle(current())}
                >
                  {live() ? t('停止') : t('启动')}
                </Button>
                <Button
                  tone="ghost"
                  icon={<Icon name="globe" size={14} tint="fg-2" />}
                  disabled={!live() || !port()}
                  onPress={() => act(() => api.openPreview(current().name))}
                  title={port() ? t('打开 {url}', { url: `http://<branch>.localhost:${port()}` }) : t('启动后可预览')}
                >
                  {t('预览')}
                </Button>
                <Button
                  tone="ghost"
                  icon={<Icon name="bot" size={14} tint="fg-2" />}
                  onPress={() => act(() => api.openAgent(current().name))}
                  title={t('在终端新标签里运行 {command}', { command: app.settings()?.agentCommand ?? '' })}
                >
                  Agent
                </Button>
                <Button
                  tone="ghost"
                  icon={<Icon name="terminal" size={14} tint={app.withTerminal().has(current().name) ? 'agent' : 'fg-2'} />}
                  onPress={() => act(() => api.openTerminal(current().name))}
                >
                  {t('终端')}
                </Button>
                <Button tone="ghost" icon={<Icon name="code-2" size={14} tint="fg-2" />} onPress={() => act(() => api.openEditor(current().name))}>
                  {t('代码')}
                </Button>
                <IconButton label={t('端口、数据库和环境变量')} onPress={() => inspector.set(!inspector())} class={inspector() ? 'bg-fill-hover' : undefined}>
                  <Icon name="panel-right" size={16} tint={inspector() ? 'fg' : 'fg-2'} />
                </IconButton>
                <MenuButton label={t('更多操作')} entries={() => branchMenu(current())}>
                  <Icon name="more-horizontal" size={16} tint="fg-2" />
                </MenuButton>
              </View>
            </View>
            <If when={creating()}>{(progress) => <CreationSteps step={progress().step} message={progress().message} />}</If>
            <View class="min-h-0 flex-1 flex-row">
              <View class="min-w-0 flex-1">
                <LogPane branch={current().name} />
              </View>
              <If when={inspector()}>
                <View class="w-[300px] shrink-0 border-l border-border bg-sidebar">
                  <Inspector branch={current()} />
                </View>
              </If>
            </View>
          </View>
        )
      }}
    </If>
  )
}

const creationSteps = () =>
  [
    ['fetch', t('拉取 develop')],
    ['branch', t('创建分支')],
    ['env', t('生成环境')],
    ['install', t('安装依赖')],
    ['database', t('数据库')],
    ['migrate', t('迁移')],
  ] as const

/** Where a background creation has got to, as a row of steps. */
function CreationSteps(props: { step: string; message: string }) {
  const steps = creationSteps()
  const current = () => steps.findIndex(([name]) => name === props.step)
  return (
    <View class="shrink-0 flex-row items-center gap-3 border-b border-border bg-brand-soft px-4 py-2">
      <Each of={steps} key={([name]) => name}>
        {(step, index) => (
          <View class="flex-row items-center gap-1.5">
            <If
              when={index() < current()}
              else={
                <If when={index() === current()} else={<View class="size-1.5 rounded-full bg-fg-3 opacity-50" />}>
                  <Spinner size={12} />
                </If>
              }
            >
              <Icon name="check" size={14} tint="ok" />
            </If>
            <Text class={cn('text-[12px]', index() < current() ? 'text-fg' : index() === current() ? 'font-medium text-brand' : 'text-muted-foreground')}>{step()[1]}</Text>
          </View>
        )}
      </Each>
      <View class="flex-1" />
      <Text class="text-[12px] text-muted-foreground" style={{ numberOfLines: 1 }}>
        {props.message}
      </Text>
    </View>
  )
}

/** A worktree still being created: progress, and the creation log as it streams. */
function CreatingView(props: { branch: string; step: string; message: string }) {
  return (
    <View class="flex-1">
      <View class="h-[52px] shrink-0 flex-row items-center gap-2 border-b border-border px-4" desktop={{ windowDrag: true }}>
        <Spinner />
        <Text class="text-[14px] font-semibold text-fg" style={{ numberOfLines: 1 }}>
          {props.branch}
        </Text>
        <Text class="text-[12px] text-muted-foreground">{t('创建中')}</Text>
      </View>
      <CreationSteps step={props.step} message={props.message} />
      <View class="min-h-0 flex-1">
        <LogPane branch={props.branch} />
      </View>
    </View>
  )
}
