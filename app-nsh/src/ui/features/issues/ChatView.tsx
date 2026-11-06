import { Clipboard, Text, View, computed, signal } from 'nsh'
import { t } from '../../../shared/i18n'
import type { Chat } from '../../../shared/types'
import { Icon } from '../../components/Icon'
import { EmptyState, MenuButton, TitleStrip } from '../../components/kit'
import { Markdown } from '../../components/Markdown'
import { api } from '../../lib/api'
import { chats } from '../../store/chats'
import { issues } from '../../store/issues'
import { chatTab, tabs, transcriptLayout } from '../../store/tabs'
import { AccessPicker, ModelPicker } from './AgentPickers'
import { Composer } from './Composer'
import { ActivityGroup, BackgroundActivity, type Item, TranscriptScroll, TurnView, buildTurns } from './Transcript'

const home = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')

/** A free-standing conversation: same transcript and composer as an issue's, no issue around it. */
export function ChatView(props: { chat: Chat }) {
  // Another chat is another view: its own scroll position, drafts and loads.
  return (
    <Each of={[props.chat]} key={(chat) => chat.id}>
      {(chat) => <ChatBody chat={chat()} />}
    </Each>
  )
}

function ChatBody(props: { chat: Chat }) {
  const entries = () => chats.transcripts()[props.chat.id] ?? []
  const turns = computed(() => buildTurns(entries(), props.chat.running))
  const sent = signal(0)
  void chats.loadTranscript(props.chat.id)
  const perform = (work: () => Promise<unknown>) => void issues.perform(work)
  const place = () => props.chat.branch ?? home(props.chat.cwd)
  return (
    <View class="flex-1">
      <TitleStrip class="h-[52px] gap-3 border-b border-border px-4">
        <View class="min-w-0 flex-1">
          <Text class="text-[14px] font-semibold text-fg" style={{ numberOfLines: 1 }}>
            {props.chat.title}
          </Text>
          <View class="flex-row items-center gap-1.5">
            <Icon name={props.chat.branch ? 'git-branch' : 'folder'} size={12} tint="fg-2" />
            <Text class="font-mono text-[11.5px] text-fg-2" style={{ numberOfLines: 1 }}>
              {place()}
            </Text>
            <If when={props.chat.costUSD > 0}>
              <Text class="text-[11.5px] text-fg-2 tabular-nums">· ${props.chat.costUSD.toFixed(2)}</Text>
            </If>
          </View>
        </View>
        <MenuButton
          label={t('更多')}
          entries={() => [
            { label: t('复制会话恢复命令'), onSelect: () => void Clipboard.writeText(`cd ${props.chat.cwd} && claude --resume ${props.chat.sessionId}`) },
            'separator',
            {
              label: t('删除对话'),
              danger: true,
              onSelect: () => {
                tabs.close(chatTab(props.chat.id))
                perform(() => api.deleteChat(props.chat.id))
              },
            },
          ]}
        >
          <Icon name="more-horizontal" size={16} tint="fg-2" />
        </MenuButton>
      </TitleStrip>
      <TranscriptScroll change={`${entries().length}:${props.chat.background?.length ?? 0}`} sent={String(sent())}>
        <If when={entries().length === 0}>
          <View class="pt-16">
            <EmptyState
              icon={<Icon name="message-square-plus" size={28} tint="fg-2" />}
              title={t('新对话')}
              detail={t('Claude Code 会在 {place} 里工作。问问题、改代码、查日志都行。', { place: place() })}
            />
          </View>
        </If>
        <Each of={turns()} key={(turn) => turn.id}>
          {(turn) => <TurnView turn={turn()} layout={transcriptLayout.layout()} renderItem={(item) => <ChatItem item={item} />} />}
        </Each>
        <If when={props.chat.background}>{(background) => <BackgroundActivity tasks={background()} onStop={(taskId) => perform(() => api.stopChatBackground(props.chat.id, taskId))} />}</If>
      </TranscriptScroll>
      <Composer
        uploadKey={`chat-${props.chat.id}`}
        busy={props.chat.running}
        queued={props.chat.queued}
        canSteer={props.chat.running}
        contextUsage={props.chat.context}
        placeholder={t('问点什么，或让它改代码；可粘贴或拖入截图')}
        context={
          <>
            <Icon name={props.chat.branch ? 'git-branch' : 'folder'} size={12} tint="fg-2" />
            <Text class="font-mono text-[11px] text-fg-2" style={{ numberOfLines: 1 }}>
              {place()}
            </Text>
          </>
        }
        pickers={
          <>
            <ModelPicker model={props.chat.model} onChange={(model) => perform(() => api.updateChat(props.chat.id, { model }))} />
            <AccessPicker access={props.chat.access} onChange={(access) => perform(() => api.updateChat(props.chat.id, { access }))} />
          </>
        }
        onSend={(message, attachments, steer) => {
          sent.set(sent() + 1)
          perform(() => api.sendChat(props.chat.id, message, attachments, steer))
        }}
        onSteer={(queuedId) => perform(() => api.steerChatMessage(props.chat.id, queuedId))}
        onUnqueue={(queuedId) => perform(() => api.unqueueChatMessage(props.chat.id, queuedId))}
        onCancel={() => perform(() => api.cancelChat(props.chat.id))}
      />
    </View>
  )
}

function ChatItem(props: { item: Item }) {
  const item = () => props.item
  return (
    <If when={item().kind === 'work' ? item() : undefined} else={<ChatEntry item={item()} />}>
      {(work) => {
        const w = work() as Extract<Item, { kind: 'work' }>
        return <ActivityGroup steps={w.steps} subagents={w.subagents} live={w.live} review={false} />
      }}
    </If>
  )
}

function ChatEntry(props: { item: Item }) {
  const entry = () => (props.item.kind === 'work' ? undefined : props.item.entry)
  return (
    <If when={entry()}>
      {(entry) => (
        <If
          when={entry().kind === 'error'}
          else={
            <If when={entry().kind === 'result'} else={<Markdown text={entry().text} class="text-[14px] leading-[1.65] text-fg" />}>
              <Text class="text-[11px] text-fg-2 tabular-nums">{entry().text}</Text>
            </If>
          }
        >
          <View class="flex-row items-start gap-2 rounded-lg bg-err-soft px-3 py-2">
            <Icon name="circle-alert" size={14} tint="err" class="mt-px" />
            <Text class="flex-1 text-[12px] text-err" style={{ userSelect: 'text' }}>
              {entry().text}
            </Text>
          </View>
        </If>
      )}
    </If>
  )
}
