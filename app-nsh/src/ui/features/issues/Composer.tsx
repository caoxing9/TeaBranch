import { Canvas, type InputRef, type JSX, Text, View, effect, keymap, signal } from 'nsh'
import { Input } from 'nsh/base'
import { attachmentMarker } from '../../../shared/attachments'
import { t } from '../../../shared/i18n'
import type { ContextUsage, QueuedMessage } from '../../../shared/types'
import { type Draft, DraftChip, importFiles, importUris, pickDrafts } from '../../components/Drafts'
import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/kit'
import { messageOf } from '../../lib/api'
import { cn } from '../../lib/utils'
import { issues } from '../../store/issues'
import { color } from '../../theme'

/**
 * One rounded box, two lines tall when empty, that grows with its text; send inside it at the
 * bottom right, quiet details (branch, PR) on a line underneath. Return sends, Shift-Return breaks
 * the line, and a Return that commits an input method's candidate is left to the IME.
 *
 * While the agent works, Return queues the message for after its turn and ⌘Return steers it into
 * the turn. Queued messages sit above the text, each one steerable or removable.
 */
export function Composer(props: {
  /** Where pasted and attached files are kept, per conversation. */
  uploadKey: string
  /** The quiet line under the box: branch, PR, workspace. */
  context: JSX.Element
  placeholder: string
  busy: boolean
  /** Busy only in the sense of queued for a fix: nothing runs yet. */
  waiting?: boolean
  queued?: QueuedMessage[]
  /** The running agent takes messages mid-turn (a reviewer or a worktree build doesn't). */
  canSteer: boolean
  pickers: JSX.Element
  /** Session context use, for the ring by the send button. */
  contextUsage?: ContextUsage
  /** Sent now when idle; while busy queued, or with `steer` put into the running turn. */
  onSend: (message: string, attachments: string[], steer: boolean) => void
  /** A queued message, now: steered in while busy, sent when idle. */
  onSteer: (queuedId: string) => void
  onUnqueue: (queuedId: string) => void
  onCancel: () => void
}) {
  const text = signal('')
  const drafts = signal<Draft[]>([])
  const dragging = signal(false)
  const focused = signal(false)
  let input: InputRef | undefined
  const canSend = () => text().trim().length > 0 || drafts().length > 0
  const queued = () => props.queued ?? []

  const take = (work: Promise<Draft[]>) =>
    work.then((added) => drafts.set([...drafts(), ...added])).catch((error) => issues.set({ error: messageOf(error) }))

  const send = (steer = false) => {
    if (!canSend()) return
    const attachments = drafts().map((draft) => draft.path)
    const markers = attachments.map((_, index) => attachmentMarker(index + 1)).join(' ')
    const message = [text().trim(), markers].filter(Boolean).join('\n') || t('看一下附件。')
    text.set('')
    drafts.set([])
    props.onSend(message, attachments, steer && props.busy && props.canSteer)
  }

  // ⌘Return while typing here: into the running turn.
  effect(() => {
    if (!focused()) return
    return keymap.bind('mod+enter', () => send(true))
  })

  const placeholder = () =>
    props.waiting ? t('还在修复队列里；现在写的消息会在修复跑完后发出') : props.busy ? t('Agent 正在工作：⏎ 排队到这一轮之后，⌘⏎ 插话') : props.placeholder

  return (
    <View class="w-full max-w-[760px] shrink-0 self-center px-6 pb-2.5">
      <View
        class={cn('rounded-2xl border bg-card shadow-md', dragging() ? 'border-brand bg-brand-soft' : focused() ? 'border-border-strong' : 'border-border')}
        onFileDragEnter={() => dragging.set(true)}
        onFileDragLeave={() => dragging.set(false)}
        onFileDrop={(e) => {
          dragging.set(false)
          void take(importUris(props.uploadKey, e.uris))
        }}
      >
        <If when={queued().length > 0}>
          <View class="gap-0.5 border-b border-border px-2 py-1.5">
            <Text class="px-1 text-[11px] text-fg-2">{props.busy ? t('排队中，这一轮结束后依次发送') : t('排队中，agent 已停止')}</Text>
            <Each of={queued()} key={(message) => message.id}>
              {(message) => (
                <View class="h-7 flex-row items-center gap-2 rounded-md px-1 hover:bg-accent/60">
                  <Icon name="corner-down-right" size={14} tint="fg-2" />
                  <Text class="min-w-0 flex-1 text-[12.5px] text-fg" style={{ numberOfLines: 1 }}>
                    {message().text}
                    {message().attachments.length > 0 ? ` · 📎 ${message().attachments.length}` : ''}
                  </Text>
                  <View
                    class={cn('rounded px-1.5 py-0.5 hover:bg-bg', props.busy && !props.canSteer && 'opacity-40')}
                    role="button"
                    disabled={props.busy && !props.canSteer}
                    tooltip={props.busy ? (props.canSteer ? t('现在就发给 agent，它会在下一步看到') : t('现在没有 agent 在对话，结束后会自动发出')) : t('现在发送')}
                    onPress={() => props.onSteer(message().id)}
                  >
                    <Text class="text-[11.5px] text-fg-2">{props.busy ? t('插话') : t('发送')}</Text>
                  </View>
                  <View class="size-5 items-center justify-center rounded hover:bg-bg" role="button" tooltip={t('移除')} accessibilityLabel={t('移除')} onPress={() => props.onUnqueue(message().id)}>
                    <Icon name="x" size={12} tint="fg-2" />
                  </View>
                </View>
              )}
            </Each>
          </View>
        </If>
        <If when={drafts().length > 0}>
          <View class="flex-row flex-wrap gap-1.5 px-3 pt-3">
            <Each of={drafts()} key={(draft) => draft.path}>
              {(draft) => <DraftChip draft={draft()} onRemove={() => drafts.set(drafts().filter((d) => d.path !== draft().path))} />}
            </Each>
          </View>
        </If>
        <Input
          ref={(node) => (input = node)}
          multiline
          submitBehavior="submit"
          value={text()}
          placeholder={placeholder()}
          onChange={(e) => text.set(e.value)}
          onSubmit={() => send(false)}
          onFocus={() => focused.set(true)}
          onBlur={() => focused.set(false)}
          onPaste={(e) => {
            if (e.files.length) void take(importFiles(props.uploadKey, e.files))
            else if (e.uris.length) void take(importUris(props.uploadKey, e.uris))
          }}
          class="max-h-60 min-h-[56px] w-full px-4 pt-3 pb-1 text-[13.5px] leading-[20px] text-fg"
        />
        <View class="flex-row items-center gap-1 px-2 pb-2">
          <IconButton label={t('附加文件')} class="size-6" onPress={() => void take(pickDrafts(props.uploadKey))}>
            <Icon name="plus" size={16} tint="fg-2" />
          </IconButton>
          {props.pickers}
          <View class="flex-1" />
          <If when={props.contextUsage && props.contextUsage.used > 0 ? props.contextUsage : undefined}>{(usage) => <ContextRing usage={usage()} />}</If>
          <If when={props.busy && canSend()}>
            <Text class="mr-1 text-[11px] text-fg-2">{props.canSteer ? t('⏎ 排队 · ⌘⏎ 插话') : t('⏎ 排队')}</Text>
          </If>
          <If when={props.busy}>
            <View class="size-7 items-center justify-center rounded-lg bg-primary hover:bg-err" role="button" tooltip={t('停止 agent')} onPress={props.onCancel}>
              <Icon name="square" size={10} tint="#ffffff" />
            </View>
          </If>
          <If when={!props.busy || canSend()}>
            <View
              class={cn('size-7 items-center justify-center rounded-lg', canSend() ? 'bg-primary hover:bg-primary/85' : 'bg-muted')}
              role="button"
              tooltip={props.busy ? t('排队') : t('发送')}
              disabled={!canSend()}
              onPress={() => {
                send(false)
                input?.focus()
              }}
            >
              <Icon name="arrow-up" size={16} tint={canSend() ? '#ffffff' : 'fg-3'} />
            </View>
          </If>
        </View>
      </View>
      <View class="h-6 flex-row items-center gap-1.5 px-3">{props.context}</View>
    </View>
  )
}

const compact = (tokens: number): string =>
  tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${+(tokens / 1000).toFixed(1)}k` : String(tokens)

/** How full the session's context is: a ring that fills, amber past 70%, red past 90%. */
function ContextRing(props: { usage: ContextUsage }) {
  const ratio = () => (props.usage.window ? Math.min(1, props.usage.used / props.usage.window) : undefined)
  const tone = () => {
    const r = ratio()
    return r === undefined ? color('fg-2') : r > 0.9 ? color('err') : r > 0.7 ? color('warn') : color('fg-2')
  }
  const tooltip = () =>
    props.usage.window
      ? t('上下文 {used} / {window}', { used: compact(props.usage.used), window: compact(props.usage.window) })
      : t('上下文 {used}（窗口大小在这一轮结束后可知）', { used: compact(props.usage.used) })
  return (
    <View class="mr-1 h-6 flex-row items-center gap-1 rounded-md px-1 hover:bg-accent" tooltip={tooltip()}>
      <Canvas
        style={{ width: 16, height: 16 }}
        draw={(cx) => {
          const r = 6
          cx.lineWidth = 2
          cx.beginPath()
          cx.strokeStyle = tone()
          cx.globalAlpha = 0.18
          cx.arc(8, 8, r, 0, Math.PI * 2)
          cx.stroke()
          const share = ratio()
          if (share !== undefined) {
            cx.globalAlpha = 1
            cx.lineCap = 'round'
            cx.beginPath()
            cx.arc(8, 8, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * share)
            cx.stroke()
          }
        }}
      />
      <Text class="text-[11px] text-fg-2 tabular-nums">{ratio() !== undefined ? `${Math.round((ratio() as number) * 100)}%` : compact(props.usage.used)}</Text>
    </View>
  )
}
