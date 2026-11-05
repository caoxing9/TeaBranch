import { Scroll, Text, View, effect, signal } from 'nsh'
import { t } from '../../../shared/i18n'
import type { BranchChanges, Issue, IssueRun } from '../../../shared/types'
import { isLive } from '../../../shared/types'
import { Icon } from '../../components/Icon'
import { Button, IconButton, type MenuEntry, MenuButton, Segmented, Spinner, StatusDot } from '../../components/kit'
import { Markdown } from '../../components/Markdown'
import { PersonAvatar } from '../../components/person'
import { api, messageOf } from '../../lib/api'
import { formatBytes, formatDuration } from '../../lib/format'
import { cn } from '../../lib/utils'
import { app, statusOf } from '../../store/app'
import { issues } from '../../store/issues'
import { statusColor } from '../branches/BranchSidebar'
import { LogPane } from '../branches/LogPane'
import { BrowserTab } from './BrowserTab'
import { Attachments } from './IssueExtras'
import { PRTab } from './PRTab'

type Tab = 'run' | 'browser' | 'changes' | 'pr' | 'details'

/** A tab asked for from outside the panel — the header's preview asks for the browser. */
const requested = signal<{ tab?: Tab; at: number }>({ at: 0 })

export const showBrowserTab = (): void => requested.set({ tab: 'browser', at: Date.now() })

/**
 * Everything reviewing an issue needs beside its conversation: run the fix, see what it changed,
 * read the record — without leaving for the branch page.
 */
export function IssuePanel(props: { issue: Issue; run?: IssueRun; onWide?: (wide: boolean) => void }) {
  const tab = signal<Tab>(props.run ? 'run' : 'details')
  // Asked for just now — also when the request is what opened the panel; an old one is spent.
  effect(() => {
    const request = requested()
    if (request.tab && Date.now() - request.at < 1000) tab.set(request.tab)
  })
  // A page needs room: the panel widens while the browser shows.
  effect(() => props.onWide?.(tab() === 'browser' && !!props.run))
  const options = (): { value: Tab; label: string }[] => [
    { value: 'run', label: t('运行') },
    ...(props.run ? [{ value: 'browser' as Tab, label: t('浏览器') }] : []),
    { value: 'changes', label: t('改动') },
    ...(props.run?.prURL ? [{ value: 'pr' as Tab, label: 'PR' }] : []),
    { value: 'details', label: t('详情') },
  ]
  return (
    <View class="flex-1">
      <View class="shrink-0 border-b border-border px-3 py-2">
        <Segmented<Tab> value={tab()} onChange={(value) => tab.set(value)} options={options()} />
      </View>
      <View class="min-h-0 flex-1">
        <If when={tab() === 'details'} else={<If when={props.run} else={<Note text={t('开始修复后，这里可以运行它的分支、查看改动。')} />}>{(run) => <RunTabs tab={tab()} issue={props.issue} run={run()} />}</If>}>
          <Details issue={props.issue} />
        </If>
      </View>
    </View>
  )
}

function RunTabs(props: { tab: Tab; issue: Issue; run: IssueRun }) {
  return (
    <>
      <If when={props.tab === 'run'}>
        <RunTab branch={props.run.branch} />
      </If>
      <If when={props.tab === 'browser'}>
        <Each of={[props.run.branch]} key={(branch) => branch}>
          {(branch) => <BrowserTab branch={branch()} />}
        </Each>
      </If>
      <If when={props.tab === 'pr' && props.run.prURL}>
        <PRTab issue={props.issue} run={props.run} />
      </If>
      <If when={props.tab === 'changes' || (props.tab === 'pr' && !props.run.prURL)}>
        <ChangesTab branch={props.run.branch} prURL={props.run.prURL} />
      </If>
    </>
  )
}

function Note(props: { text: string }) {
  return (
    <View class="p-6">
      <Text class="text-center text-[12.5px] text-fg-2">{props.text}</Text>
    </View>
  )
}

/**
 * The issue branch's dev server, from the header: one press starts it and opens the preview once
 * it is up; while it runs the same button is the preview. The rest is in the menu beside it.
 */
export function RunControl(props: { branch: string; onPreview?: () => void }) {
  const branch = () => app.branches().find((candidate) => candidate.name === props.branch)
  const status = () => {
    const current = branch()
    return current ? statusOf(current) : 'stopped'
  }
  const previewWhenUp = signal(false)
  effect(() => {
    if (!previewWhenUp() || status() !== 'running') return
    previewWhenUp.set(false)
    if (props.onPreview) props.onPreview()
    else void app.run(null, () => api.openPreview(props.branch))
  })
  const live = () => isLive(status())
  const busy = () => app.busy().has(props.branch) || status() === 'building'
  const port = () => branch()?.environment?.port
  const act = (work: () => Promise<unknown>) => void app.run(null, work)
  const start = async () => {
    const current = branch()
    if (!current) return
    previewWhenUp.set(true)
    await app.toggle(current)
    // It didn't come up (the error is shown): don't pop a preview later out of nowhere.
    const after = app.branches().find((candidate) => candidate.name === props.branch)
    if (!after || !isLive(statusOf(after))) previewWhenUp.set(false)
  }
  const menu = (): MenuEntry[] => [
    { label: t('在分支页打开'), onSelect: () => app.go({ section: 'branches', selectedBranch: props.branch }) },
    'separator',
    { label: props.onPreview ? t('在系统浏览器打开') : t('打开预览'), disabled: status() !== 'running' || !port(), onSelect: () => act(() => api.openPreview(props.branch)) },
    { label: t('重启'), disabled: !live() || app.busy().has(props.branch), onSelect: () => void app.restart(props.branch) },
    { label: live() ? t('停止') : t('启动'), disabled: app.busy().has(props.branch), onSelect: () => branch() && void app.toggle(branch() as NonNullable<ReturnType<typeof branch>>) },
    'separator',
    { label: t('在终端打开'), onSelect: () => act(() => api.openTerminal(props.branch)) },
    { label: t('在 VS Code 打开'), onSelect: () => act(() => api.openEditor(props.branch)) },
  ]
  // No worktree yet: nothing to run.
  return (
    <If when={branch()}>
      <View class="flex-row items-center">
        <If
          when={status() === 'running'}
          else={
            <Button
              tone="accent"
              disabled={busy()}
              icon={busy() ? <Spinner /> : <Icon name="play" size={14} tint="#ffffff" />}
              title={t('启动这个分支的 dev server，起来后打开预览')}
              onPress={() => void start()}
            >
              {status() === 'building' ? t('启动中') : t('启动')}
            </Button>
          }
        >
          <Button icon={<Icon name="globe" size={14} tint="fg-2" />} title={t('打开预览')} onPress={() => (props.onPreview ? props.onPreview() : act(() => api.openPreview(props.branch)))}>
            {`${t('预览')}${port() ? ` :${port()}` : ''}`}
          </Button>
        </If>
        <MenuButton label={t('分支操作')} entries={menu}>
          <Icon name="chevron-down" size={14} tint="fg-2" />
        </MenuButton>
      </View>
    </If>
  )
}

function RunTab(props: { branch: string }) {
  const branch = () => app.branches().find((candidate) => candidate.name === props.branch)
  const status = () => {
    const current = branch()
    return current ? statusOf(current) : 'stopped'
  }
  const live = () => isLive(status())
  const busy = () => app.busy().has(props.branch)
  const usage = () => app.usage()[props.branch]
  const port = () => branch()?.environment?.port
  const act = (work: () => Promise<unknown>) => void app.run(null, work)
  return (
    <If when={branch()} else={<Note text={t('worktree 还在创建中…')} />}>
      {(current) => (
        <View class="flex-1">
          <View class="shrink-0 gap-3 border-b border-border p-3">
            <View class="flex-row items-center gap-2">
              <StatusDot color={statusColor[status()]} pulse={status() === 'building'} />
              <Text class="text-[13px] font-medium text-fg">{live() ? (status() === 'building' ? t('启动中') : t('运行中')) : t('未运行')}</Text>
              <If when={usage()}>
                {(u) => (
                  <Text class="text-[11.5px] text-fg-2 tabular-nums">
                    {u().cpuPercent.toFixed(0)}% · {formatBytes(u().residentBytes)} · {formatDuration(u().uptimeSeconds)}
                  </Text>
                )}
              </If>
              <View class="flex-1" />
              <Button
                tone={live() ? 'danger' : 'accent'}
                disabled={busy()}
                icon={busy() ? <Spinner /> : <Icon name={live() ? 'square' : 'play'} size={12} tint="#ffffff" />}
                onPress={() => void app.toggle(current())}
              >
                {live() ? t('停止') : t('启动')}
              </Button>
            </View>
            <View class="flex-row items-center gap-1">
              <Button icon={<Icon name="globe" size={14} tint="fg-2" />} disabled={!live() || !port()} onPress={() => act(() => api.openPreview(props.branch))}>
                {`${t('预览')}${port() && live() ? ` :${port()}` : ''}`}
              </Button>
              <IconButton label={t('在终端打开')} onPress={() => act(() => api.openTerminal(props.branch))}>
                <Icon name="terminal" size={16} tint="fg-2" />
              </IconButton>
              <IconButton label={t('在 VS Code 打开')} onPress={() => act(() => api.openEditor(props.branch))}>
                <Icon name="code-2" size={16} tint="fg-2" />
              </IconButton>
            </View>
          </View>
          <View class="min-h-0 flex-1">
            <Each of={[props.branch]} key={(name) => name}>
              {(name) => <LogPane branch={name()} />}
            </Each>
          </View>
        </View>
      )}
    </If>
  )
}

function ChangesTab(props: { branch: string; prURL?: string }) {
  const changes = signal<BranchChanges | null>(null)
  const loading = signal(false)
  const error = signal<string | null>(null)
  const load = async () => {
    loading.set(true)
    try {
      changes.set(await api.branchChanges(props.branch))
      error.set(null)
    } catch (err) {
      error.set(messageOf(err))
    } finally {
      loading.set(false)
    }
  }
  effect(() => {
    props.branch
    void load()
  })
  const added = () => changes()?.files.reduce((sum, file) => sum + file.added, 0) ?? 0
  const removed = () => changes()?.files.reduce((sum, file) => sum + file.removed, 0) ?? 0
  const dir = (path: string) => path.split('/').slice(0, -1).join('/')
  const base = (path: string) => path.split('/').pop() ?? path
  return (
    <Scroll class="flex-1">
      <View class="flex-row items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="file-diff" size={14} tint="fg-2" />
        <Text class="text-[12px] font-medium text-fg">{t('{n} 个文件', { n: changes()?.files.length ?? 0 })}</Text>
        <Text class="font-mono text-[12px] text-ok">+{added()}</Text>
        <Text class="font-mono text-[12px] text-err">−{removed()}</Text>
        <Text class="text-[12px] text-fg-2">vs {changes()?.base ?? 'develop'}</Text>
        <View class="flex-1" />
        <If when={props.prURL}>
          {(url) => (
            <Button class="h-6 px-2" onPress={() => void api.openExternal(url())}>
              {`PR #${url().split('/').pop()}`}
            </Button>
          )}
        </If>
        <IconButton label={t('刷新')} onPress={() => void load()}>
          <Icon name="refresh-cw" size={14} tint="fg-2" class={loading() ? 'animate-spin' : undefined} />
        </IconButton>
      </View>
      <If when={error()}>
        <View class="m-3 rounded-md bg-err-soft px-3 py-2">
          <Text class="text-[12px] text-err">{error()}</Text>
        </View>
      </If>
      <If when={changes()}>
        {(current) => (
          <>
            <If when={current().dirty.length > 0}>
              <View class="mx-3 mt-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2">
                <Text class="text-[12px] text-fg">{t('还有 {n} 个未提交的改动 —— agent 可能还没 commit。', { n: current().dirty.length })}</Text>
              </View>
            </If>
            <Text class="px-3 pt-3 pb-1 text-[10.5px] font-semibold tracking-wide text-fg-2 uppercase">{t('文件')}</Text>
            <If when={current().files.length === 0}>
              <Text class="px-3 py-2 text-[12px] text-fg-2">{t('还没有提交的改动')}</Text>
            </If>
            <Each of={current().files} key={(file) => file.path}>
              {(file) => (
                <View class="flex-row items-center gap-2 px-3 py-1 hover:bg-accent" role="button" tooltip={t('在 VS Code 打开')} onPress={() => void api.openFileInEditor(props.branch, file().path)}>
                  <Text class="min-w-0 flex-1 font-mono text-[12px] text-fg" style={{ numberOfLines: 1 }}>
                    <Text class="text-fg-2">{dir(file().path) ? `${dir(file().path)}/` : ''}</Text>
                    {base(file().path)}
                  </Text>
                  <Text class="font-mono text-[11px] text-ok">+{file().added}</Text>
                  <Text class="font-mono text-[11px] text-err">−{file().removed}</Text>
                </View>
              )}
            </Each>
            <If when={current().commits.length > 0}>
              <Text class="px-3 pt-4 pb-1 text-[10.5px] font-semibold tracking-wide text-fg-2 uppercase">{t('提交')}</Text>
              <Each of={current().commits} key={(commit) => commit.hash}>
                {(commit) => (
                  <View class="flex-row items-start gap-2 px-3 py-1">
                    <Icon name="git-commit-horizontal" size={14} tint="fg-2" class="mt-0.5" />
                    <Text class="font-mono text-[12px] text-fg-2">{commit().hash}</Text>
                    <Text class="min-w-0 flex-1 text-[12px] text-fg">{commit().subject}</Text>
                  </View>
                )}
              </Each>
            </If>
          </>
        )}
      </If>
    </Scroll>
  )
}

function Details(props: { issue: Issue }) {
  const shown = () => issues.fields().filter((field) => props.issue.record.fields[field.name])
  return (
    <Scroll class="flex-1" contentClass="gap-3 p-3">
      <Each of={shown()} key={(field) => field.id}>
        {(field) => (
          <View>
            <Text class="mb-1 text-[11px] font-medium text-fg-2">{field().name}</Text>
            <If
              when={props.issue.record.attachments?.[field().name]}
              else={
                <If
                  when={props.issue.record.people?.[field().name]}
                  else={
                    <If
                      when={field().type === 'longText'}
                      else={
                        <Text class="text-[12.5px] text-fg" style={{ userSelect: 'text' }}>
                          {props.issue.record.fields[field().name]}
                        </Text>
                      }
                    >
                      {/* Long text is where people write Markdown: steps, code, links. */}
                      <Markdown text={props.issue.record.fields[field().name]} class="text-[12.5px] leading-[1.6] text-fg" />
                    </If>
                  }
                >
                  {(people) => (
                    <View class="flex-row flex-wrap gap-2">
                      <Each of={people()} key={(person) => person.name}>
                        {(person) => (
                          <View class="flex-row items-center gap-1.5">
                            <PersonAvatar person={person()} tooltip={false} />
                            <Text class="text-[12.5px] text-fg">{person().name}</Text>
                          </View>
                        )}
                      </Each>
                    </View>
                  )}
                </If>
              }
            >
              {(attachments) => <Attachments attachments={attachments()} />}
            </If>
          </View>
        )}
      </Each>
    </Scroll>
  )
}

