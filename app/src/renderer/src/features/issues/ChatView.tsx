import { CircleAlert, Folder, GitBranch, MessageSquarePlus, MoreHorizontal } from 'lucide-react'
import { t } from '@shared/i18n'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { Chat, ConversationEntry } from '@shared/types'
import { EmptyState, MenuButton } from '@/components/kit'
import { api } from '@/lib/api'
import { useChats } from '@/store/chats'
import { useIssues } from '@/store/issues'
import { useTabs, useTranscriptLayout } from '@/store/tabs'
import { AccessPicker, ModelPicker } from './AgentPickers'
import { Composer } from './Composer'
import { ActivityGroup, buildTurns, type Item, TurnView } from './Transcript'
import { Markdown } from './Markdown'

const home = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')

/** A free-standing conversation: same transcript and composer as an issue's, no issue around it. */
const NO_ENTRIES: ConversationEntry[] = []

export function ChatView({ chat }: { chat: Chat }) {
  const entries = useChats((s) => s.transcripts[chat.id]) ?? NO_ENTRIES
  const loadTranscript = useChats((s) => s.loadTranscript)
  const perform = useIssues((s) => s.perform)
  const layout = useTranscriptLayout((s) => s.layout)
  const turns = useMemo(() => buildTurns(entries, chat.running), [entries, chat.running])
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => void loadTranscript(chat.id), [chat.id, loadTranscript])
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  }, [entries.length])

  return (
    <div className="flex h-full flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center gap-3 border-b px-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">{chat.title}</div>
          <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            {chat.branch ? <GitBranch className="size-3" /> : <Folder className="size-3" />}
            <span className="truncate font-mono">{chat.branch ?? home(chat.cwd)}</span>
            {chat.costUSD > 0 && <span className="tabular-nums">· ${chat.costUSD.toFixed(2)}</span>}
          </div>
        </div>
        <div className="no-drag">
          <MenuButton
            label={t('更多')}
            entries={() => [
              {
                label: t('复制会话恢复命令'),
                onSelect: () => void navigator.clipboard.writeText(`cd ${chat.cwd} && claude --resume ${chat.sessionId}`),
              },
              'separator',
              {
                label: t('删除对话'),
                danger: true,
                onSelect: () => {
                  useTabs.getState().close(`chat:${chat.id}`)
                  void perform(() => api.deleteChat(chat.id))
                },
              },
            ]}
          >
            <MoreHorizontal className="size-4" />
          </MenuButton>
        </div>
      </header>
      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex max-w-[760px] flex-col gap-5 px-6 py-6">
          {entries.length === 0 && (
            <div className="pt-16">
              <EmptyState
                icon={<MessageSquarePlus className="size-8" strokeWidth={1.4} />}
                title={t('新对话')}
                detail={t('Claude Code 会在 {place} 里工作。问问题、改代码、查日志都行。', { place: chat.branch ?? home(chat.cwd) })}
              />
            </div>
          )}
          {turns.map((turn) => (
            <TurnView key={turn.id} turn={turn} layout={layout} renderItem={(item) => <ChatItem item={item} />} />
          ))}
        </div>
      </div>
      <Composer
        uploadKey={`chat-${chat.id}`}
        busy={chat.running}
        queued={chat.queued}
        background={chat.background}
        canSteer={chat.running}
        contextUsage={chat.context}
        placeholder={t('问点什么，或让它改代码；可粘贴或拖入截图')}
        context={
          <>
            {chat.branch ? <GitBranch className="size-3" /> : <Folder className="size-3" />}
            <span className="truncate">{chat.branch ?? home(chat.cwd)}</span>
          </>
        }
        pickers={
          <>
            <ModelPicker model={chat.model} onChange={(model) => void perform(() => api.updateChat(chat.id, { model }))} />
            <AccessPicker access={chat.access} onChange={(access) => void perform(() => api.updateChat(chat.id, { access }))} />
          </>
        }
        onSend={(message, attachments, steer) => void perform(() => api.sendChat(chat.id, message, attachments, steer))}
        onSteer={(queuedId) => void perform(() => api.steerChatMessage(chat.id, queuedId))}
        onUnqueue={(queuedId) => void perform(() => api.unqueueChatMessage(chat.id, queuedId))}
        onCancel={() => void perform(() => api.cancelChat(chat.id))}
      />
    </div>
  )
}

function ChatItem({ item }: { item: Item }) {
  switch (item.kind) {
    case 'work':
      return <ActivityGroup steps={item.steps} subagents={item.subagents} live={item.live} review={false} />
    case 'error':
      return (
        <div className="selectable flex items-start gap-2 rounded-lg bg-err-soft px-3 py-2 text-[12px] text-err">
          <CircleAlert className="mt-px size-3.5 shrink-0" />
          <span className="whitespace-pre-wrap">{item.entry.text}</span>
        </div>
      )
    case 'result':
      return <div className="text-[11px] text-muted-foreground tabular-nums">{item.entry.text}</div>
    default:
      return (
        <div className="min-w-0 text-[14px]">
          <Markdown text={item.entry.text} />
        </div>
      )
  }
}
