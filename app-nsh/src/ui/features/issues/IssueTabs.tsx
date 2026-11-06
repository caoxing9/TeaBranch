import { Text, View, cleanup, effect, signal } from 'nsh'
import { t } from '../../../shared/i18n'
import { type Chat, isActivePhase } from '../../../shared/types'
import { Icon } from '../../components/Icon'
import { ContextMenuArea, Spinner, TitleStrip } from '../../components/kit'
import { api, on } from '../../lib/api'
import { cn } from '../../lib/utils'
import { app } from '../../store/app'
import { chats } from '../../store/chats'
import { issues } from '../../store/issues'
import { chatIdOf, currentGroup, tabs } from '../../store/tabs'
import { TerminalToggle } from '../terminal/TerminalDock'
import { ClaudeMark } from './AgentPickers'
import { here } from './place'

interface TabView {
  id: string
  title: string
  tooltip: string
  live: boolean
  chat: boolean
}

/**
 * The selected issue's tabs — its own conversation first, then the chats opened under it — or,
 * with no issue selected, the free-standing chats.
 */
export function IssueTabs() {
  const group = () => currentGroup(issues.selection())
  const issue = () => (group() ? issues.issues().find((candidate) => candidate.id === group()) : undefined)
  const run = () => (issue() ? issues.runs()[issue()!.id] : undefined)
  const chatTabs = (): TabView[] =>
    tabs.ids().flatMap((id) => {
      const chat = chats.chats().find((candidate) => candidate.id === chatIdOf(id))
      if (!chat || (chat.issueId ?? null) !== group()) return []
      return [{ id, title: chat.title, tooltip: `${chat.title}\n${chat.branch ?? chat.cwd}`, live: chat.running, chat: true }]
    })
  const all = (): TabView[] => [
    ...(issue() ? [{ id: issue()!.id, title: issue()!.title, tooltip: `${issue()!.key} ${issue()!.title}`, live: !!run() && isActivePhase(run()!.phase), chat: false }] : []),
    ...chatTabs(),
  ]
  const isActive = (tab: TabView) => (tab.chat ? tabs.activeChat() === chatIdOf(tab.id) : !tabs.activeChat())
  const neighbour = (id: string) => {
    const list = all()
    const index = list.findIndex((tab) => tab.id === id)
    const next = list[index + 1] ?? list[index - 1]
    return next && next.id !== id ? next.id : undefined
  }
  return (
    <TitleStrip class="items-end gap-0.5 border-b border-border px-2">
      <Each of={all()} key={(tab) => tab.id}>
        {(tab) => (
          <ContextMenuArea
            entries={() =>
              tab().chat
                ? [
                    { label: t('关闭'), onSelect: () => tabs.close(tab().id, neighbour(tab().id)) },
                    { label: t('关闭其他对话'), onSelect: () => tabs.closeOthers(tab().id, chatTabs().map((other) => other.id)) },
                  ]
                : [{ label: t('关闭所有对话'), disabled: !chatTabs().length, onSelect: () => chatTabs().forEach((other) => tabs.close(other.id)) }]
            }
          >
            <View
              class={cn('mb-1 h-7 max-w-56 min-w-0 flex-row items-center gap-1.5 rounded-lg pr-1 pl-2', isActive(tab()) ? 'bg-accent' : 'hover:bg-accent/60')}
              role="button"
              tooltip={tab().tooltip}
              onPress={() => tabs.activate(tab().id)}
            >
              <If when={tab().live} else={<If when={tab().chat} else={<ClaudeMark size={14} />}><Icon name="message-square" size={14} tint="fg-2" /></If>}>
                <Spinner size={12} />
              </If>
              <Text class={cn('min-w-0 flex-1 text-[12px]', isActive(tab()) ? 'text-fg' : 'text-fg-2')} style={{ numberOfLines: 1 }}>
                {tab().title}
              </Text>
              <If when={tab().chat}>
                <View
                  class={cn('size-5 shrink-0 items-center justify-center rounded-md hover:bg-fill-hover', isActive(tab()) ? 'opacity-70' : 'opacity-40')}
                  role="button"
                  accessibilityLabel={t('关闭')}
                  onPress={() => tabs.close(tab().id, neighbour(tab().id))}
                >
                  <Icon name="x" size={12} tint="fg-2" />
                </View>
              </If>
            </View>
          </ContextMenuArea>
        )}
      </Each>
      <NewChatButton />
      <View class="flex-1" />
      <TerminalToggle />
    </TitleStrip>
  )
}

/**
 * "+": a new conversation right where you are — the open issue's worktree (built first when it has
 * none yet), the open chat's checkout, or the main repository. Right-click to pick another place.
 */
function NewChatButton() {
  const building = signal<{ key: string; message: string } | null>(null)
  const settings = () => app.settings()
  const worktrees = () => app.branches().filter((branch) => branch.worktreePath && branch.worktreePath !== settings()?.projectPath && !branch.isCurrent)
  const main = () => {
    const current = app.branches().find((branch) => branch.isCurrent)
    return settings()?.projectPath ? { cwd: settings()!.projectPath as string, branch: current?.name } : null
  }
  effect(() => {
    if (!building()) return
    cleanup(on('worktreeProgress', ({ progress }) => building() && building.set({ ...building()!, message: progress.message })))
  })
  const open = (create: () => Promise<Chat>) =>
    void issues.perform(async () => {
      const chat = await create()
      await chats.init()
      tabs.openChat(chat.id)
    })
  // A chat belongs to the issue whose tabs are showing, wherever it runs.
  const start = (cwd: string, branch?: string) => open(() => api.createChat({ cwd, branch, issueId: currentGroup(issues.selection()) ?? undefined }))
  const target = () => {
    const { place, issue, needsWorktree } = here()
    if (issue && needsWorktree)
      return {
        label: t('{key}（先为它建 worktree）', { key: issue.key }),
        go: () => {
          building.set({ key: issue.key, message: '' })
          open(() => api.createIssueChat(issue).finally(() => building.set(null)))
        },
      }
    return place && { label: place.label, go: () => start(place.cwd, place.branch) }
  }
  // More chats only once the issue's own conversation has started; before that, "自动修复" is the
  // way in. (Stay visible while a worktree is building for one already asked for.)
  const shown = () => {
    const { issue } = here()
    return !(issue && !issues.runs()[issue.id] && !building())
  }
  return (
    <If when={shown()}>
      <View class="min-w-0 flex-row items-center">
        <ContextMenuArea
          entries={() => [
            ...(main() ? [{ label: main()!.branch ? t('主仓库 · {branch}', { branch: main()!.branch as string }) : t('主仓库'), onSelect: () => start(main()!.cwd, main()!.branch) }] : []),
            ...worktrees().map((branch) => ({ label: branch.name, onSelect: () => start(branch.worktreePath as string, branch.name) })),
          ]}
        >
          <View
            class={cn('mb-1 size-7 shrink-0 items-center justify-center rounded-lg hover:bg-accent', (!target() || !!building()) && 'opacity-40')}
            role="button"
            disabled={!target() || !!building()}
            tooltip={target() ? `${t('新对话 · {place}', { place: target()!.label })}\n${t('右键选择其他位置')}` : t('新对话')}
            onPress={() => target()?.go()}
          >
            <If when={building()} else={<Icon name="plus" size={16} tint="fg-2" />}>
              <Spinner />
            </If>
          </View>
        </ContextMenuArea>
        <If when={building()}>
          {(state) => (
            <Text class="mb-1 pl-1 text-[11.5px] text-fg-2" style={{ numberOfLines: 1 }}>
              {t('正在为 {key} 建 worktree', { key: state().key })}
              {state().message ? ` · ${state().message}` : '…'}
            </Text>
          )}
        </If>
      </View>
    </If>
  )
}
