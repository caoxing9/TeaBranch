import { MessageSquare, Plus, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { useEffect, useState } from 'react'
import { type Chat, isActivePhase } from '@shared/types'
import { ContextMenuArea, Spinner } from '@/components/kit'
import { api, on } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { useChats } from '@/store/chats'
import { useIssues } from '@/store/issues'
import { chatIdOf, currentGroup, useTabs } from '@/store/tabs'
import { ClaudeMark } from './AgentPickers'
import { useHere } from './place'
import { TerminalToggle } from '../terminal/TerminalDock'

interface TabView {
  id: string
  title: string
  tooltip: string
  live: boolean
  chat: boolean
}

/**
 * The selected issue's tabs — its own conversation first, then the chats opened under it — or,
 * with no issue selected, the free-standing chats. Chat tabs drag to reorder.
 */
export function IssueTabs() {
  const ids = useTabs((s) => s.ids)
  const activeChat = useTabs((s) => s.activeChat)
  const { close, closeOthers, move, activate } = useTabs()
  const issues = useIssues((s) => s.issues)
  const runs = useIssues((s) => s.runs)
  const selection = useIssues((s) => s.selection)
  const chats = useChats((s) => s.chats)
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null)

  const group = currentGroup(selection)
  const issue = group ? issues.find((candidate) => candidate.id === group) : undefined
  const run = issue && runs[issue.id]
  const chatTabs = ids.flatMap((id): TabView[] => {
    const chat = chats.find((candidate) => candidate.id === chatIdOf(id))
    if (!chat || (chat.issueId ?? null) !== group) return []
    return [{ id, title: chat.title, tooltip: `${chat.title}\n${chat.branch ?? chat.cwd}`, live: chat.running, chat: true }]
  })
  const tabs: TabView[] = [
    ...(issue
      ? [{ id: issue.id, title: issue.title, tooltip: `${issue.key} ${issue.title}`, live: !!run && isActivePhase(run.phase), chat: false }]
      : []),
    ...chatTabs,
  ]
  const isActive = (tab: TabView) => (tab.chat ? activeChat === chatIdOf(tab.id) : !activeChat)
  const neighbour = (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id)
    const next = tabs[index + 1] ?? tabs[index - 1]
    return next && next.id !== id ? next.id : undefined
  }

  return (
    <div className="drag flex h-[38px] shrink-0 items-end gap-0.5 border-b px-2">
      {tabs.map((tab) => {
        const active = isActive(tab)
        return (
          <ContextMenuArea
            key={tab.id}
            entries={() =>
              tab.chat
                ? [
                    { label: t('关闭'), onSelect: () => close(tab.id, neighbour(tab.id)) },
                    {
                      label: t('关闭其他对话'),
                      onSelect: () =>
                        closeOthers(
                          tab.id,
                          chatTabs.map((other) => other.id),
                        ),
                    },
                  ]
                : [{ label: t('关闭所有对话'), disabled: !chatTabs.length, onSelect: () => chatTabs.forEach((other) => close(other.id)) }]
            }
          >
            <div
              draggable={tab.chat}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', tab.id)
                setDragging(tab.id)
              }}
              onDragOver={(event) => {
                if (!dragging || dragging === tab.id || !tab.chat) return
                event.preventDefault()
                const box = event.currentTarget.getBoundingClientRect()
                setOver({ id: tab.id, after: event.clientX > box.left + box.width / 2 })
              }}
              onDragLeave={() => setOver((current) => (current?.id === tab.id ? null : current))}
              onDrop={(event) => {
                event.preventDefault()
                if (dragging && dragging !== tab.id && over) {
                  const index = tabs.findIndex((candidate) => candidate.id === tab.id)
                  move(dragging, over.after ? (tabs[index + 1]?.id ?? null) : tab.id)
                }
                setDragging(null)
                setOver(null)
              }}
              onDragEnd={() => {
                setDragging(null)
                setOver(null)
              }}
              onClick={() => activate(tab.id)}
              onAuxClick={(event) => event.button === 1 && tab.chat && close(tab.id, neighbour(tab.id))}
              title={tab.tooltip}
              className={cn(
                'no-drag group relative mb-1 flex h-7 max-w-56 min-w-0 cursor-default items-center gap-1.5 rounded-lg pr-1 pl-2 text-[12px] transition-colors',
                active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                dragging === tab.id && 'opacity-40',
                over?.id === tab.id &&
                  (over.after ? 'shadow-[inset_-2px_0_0_var(--color-brand)]' : 'shadow-[inset_2px_0_0_var(--color-brand)]'),
              )}
            >
              {tab.live ? (
                <Spinner className="size-3" />
              ) : tab.chat ? (
                <MessageSquare className="size-3.5 shrink-0" />
              ) : (
                <ClaudeMark className="size-3.5" />
              )}
              <span className="min-w-0 flex-1 truncate">{tab.title}</span>
              {tab.chat && (
                <button
                  type="button"
                  aria-label={t('关闭')}
                  onClick={(event) => {
                    event.stopPropagation()
                    close(tab.id, neighbour(tab.id))
                  }}
                  className={cn(
                    'grid size-5 shrink-0 place-items-center rounded-md hover:bg-foreground/10',
                    active ? 'opacity-70' : 'opacity-0 group-hover:opacity-70',
                  )}
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          </ContextMenuArea>
        )
      })}
      <NewChatButton />
      <div className="flex-1" />
      <TerminalToggle />
    </div>
  )
}

/**
 * "+": a new conversation right where you are — the open issue's worktree (built first when it has
 * none yet), the open chat's checkout, or the main repository. Right-click to pick another place.
 */
function NewChatButton() {
  const settings = useApp((s) => s.settings)
  const branches = useApp((s) => s.branches)
  const selection = useIssues((s) => s.selection)
  const perform = useIssues((s) => s.perform)
  const runs = useIssues((s) => s.runs)
  const { place, issue, needsWorktree } = useHere()
  const [building, setBuilding] = useState<{ key: string; message: string } | null>(null)
  const worktrees = branches.filter((branch) => branch.worktreePath && branch.worktreePath !== settings?.projectPath && !branch.isCurrent)
  const current = branches.find((branch) => branch.isCurrent)
  const main = settings?.projectPath ? { cwd: settings.projectPath, branch: current?.name } : null

  useEffect(() => {
    if (!building) return
    return on('worktreeProgress', ({ progress }) => setBuilding((state) => state && { ...state, message: progress.message }))
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- resubscribe per worktree being built, not per progress message
  }, [building?.key])

  const open = (create: () => Promise<Chat>) =>
    void perform(async () => {
      const chat = await create()
      await useChats.getState().init()
      useTabs.getState().openChat(chat.id)
    })
  // A chat belongs to the issue whose tabs are showing, wherever it runs.
  const start = (cwd: string, branch?: string) => open(() => api.createChat({ cwd, branch, issueId: currentGroup(selection) ?? undefined }))

  const here =
    issue && needsWorktree
      ? {
          label: t('{key}（先为它建 worktree）', { key: issue.key }),
          go: () => {
            setBuilding({ key: issue.key, message: '' })
            open(() => api.createIssueChat(issue).finally(() => setBuilding(null)))
          },
        }
      : place && { label: place.label, go: () => start(place.cwd, place.branch) }

  // More chats only once the issue's own conversation has started; before that, "自动修复" is the
  // way in. (Stay visible while a worktree is building for one already asked for.)
  if (issue && !runs[issue.id] && !building) return null

  return (
    <div className="flex min-w-0 items-center">
      <ContextMenuArea
        entries={() => [
          ...(main
            ? [
                {
                  label: main.branch ? t('主仓库 · {branch}', { branch: main.branch }) : t('主仓库'),
                  onSelect: () => start(main.cwd, main.branch),
                },
              ]
            : []),
          ...worktrees.map((branch) => ({ label: branch.name, onSelect: () => start(branch.worktreePath as string, branch.name) })),
        ]}
      >
        <button
          type="button"
          disabled={!here || !!building}
          onClick={() => here?.go()}
          title={here ? `${t('新对话 · {place}', { place: here.label })}\n${t('右键选择其他位置')}` : t('新对话')}
          className="no-drag mb-1 grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          {building ? <Spinner className="size-3.5" /> : <Plus className="size-4" />}
        </button>
      </ContextMenuArea>
      {building && (
        <span className="mb-1 truncate pl-1 text-[11.5px] text-muted-foreground">
          {t('正在为 {key} 建 worktree', { key: building.key })}
          {building.message ? ` · ${building.message}` : '…'}
        </span>
      )}
    </div>
  )
}
