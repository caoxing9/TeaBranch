import { ArrowUp, CornerDownRight, Plus, Square, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { type ReactNode, useState } from 'react'
import type { ContextUsage, QueuedMessage } from '@shared/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { IconButton } from '@/components/kit'
import { api } from '@/lib/api'
import { cx } from '@/lib/format'
import { useIssues } from '@/store/issues'
import { type AttachmentAttrs, EditorContent, insertAttachments, serialize, useMessageEditor } from './MessageEditor'

// MARK: - Composer

/**
 * One rounded box, two lines tall when empty, that grows with its text; send inside it at the bottom
 * right, quiet details (branch, PR) on a line underneath. Return sends, Shift-Return breaks the line, and a Return that commits an input
 * method's candidate is left to the IME — sending half-typed pinyin is the classic bug here.
 *
 * While the agent works, Return queues the message for after its turn and ⌘Return steers it into
 * the turn. Queued messages sit above the text, each one steerable or removable.
 */
const readAsBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

export function Composer({
  uploadKey,
  context,
  placeholder,
  busy,
  waiting,
  queued = [],
  canSteer,
  pickers,
  contextUsage,
  onSend,
  onSteer,
  onUnqueue,
  onCancel,
}: {
  /** Where pasted and attached files are kept, per conversation. */
  uploadKey: string
  /** The quiet line above the text: branch, PR, workspace. */
  context: ReactNode
  placeholder: string
  busy: boolean
  /** Busy only in the sense of queued for a fix: nothing runs yet. */
  waiting?: boolean
  queued?: QueuedMessage[]
  /** The running agent takes messages mid-turn (a reviewer or a worktree build doesn't). */
  canSteer: boolean
  pickers: ReactNode
  /** Session context use, for the ring by the send button. */
  contextUsage?: ContextUsage
  /** Sent now when idle; while busy queued, or with `steer` put into the running turn. */
  onSend: (message: string, attachments: string[], steer: boolean) => void
  /** A queued message, now: steered in while busy, sent when idle. */
  onSteer: (queuedId: string) => void
  onUnqueue: (queuedId: string) => void
  onCancel: () => void
}) {
  const [dragging, setDragging] = useState(false)

  const addFiles = async (files: File[], at?: number) => {
    const saved: AttachmentAttrs[] = []
    for (const file of files) {
      try {
        const base64 = await readAsBase64(file)
        const path = await api.saveUpload(uploadKey, file.name || 'pasted.png', base64)
        const preview = file.type.startsWith('image/') ? `data:${file.type};base64,${base64}` : undefined
        saved.push({ path, name: file.name || 'pasted.png', preview })
      } catch (error) {
        useIssues.setState({ error: String((error as Error).message) })
      }
    }
    if (editor) insertAttachments(editor, saved, at)
  }

  const send = (steer = false) => {
    if (!editor) return
    const { text, attachments } = serialize(editor)
    if (!text && !attachments.length) return
    editor.commands.clearContent(true)
    onSend(text || t('看一下附件。'), attachments, steer && busy && canSteer)
  }

  const { editor, filled: canSend } = useMessageEditor({
    placeholder: waiting
      ? t('还在修复队列里；现在写的消息会在修复跑完后发出')
      : busy
        ? t('Agent 正在工作：⏎ 排队到这一轮之后，⌘⏎ 插话')
        : placeholder,
    onSubmit: send,
    onFiles: (files, at) => void addFiles(files, at),
  })

  return (
    <div className="mx-auto w-full max-w-[760px] shrink-0 px-6 pb-2.5">
      <div
        className={cx(
          'rounded-2xl border border-border/50 bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04),0_6px_20px_rgb(0_0_0/0.06)] transition-[border-color,box-shadow] focus-within:border-border focus-within:shadow-[0_1px_2px_rgb(0_0_0/0.05),0_8px_28px_rgb(0_0_0/0.09)] dark:shadow-none',
          dragging && 'border-brand bg-brand-soft',
        )}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          setDragging(false)
          // Drops on the text land where they fall — the editor took those; the rest go at the cursor.
          const taken = event.defaultPrevented
          event.preventDefault()
          if (!taken) void addFiles([...event.dataTransfer.files])
        }}
      >
        {queued.length > 0 && (
          <div className="flex flex-col gap-0.5 border-b px-2 py-1.5">
            <div className="px-1 text-[11px] text-muted-foreground">
              {busy ? t('排队中，这一轮结束后依次发送') : t('排队中，agent 已停止')}
            </div>
            {queued.map((message) => (
              <div key={message.id} className="group flex h-7 items-center gap-2 rounded-md px-1 text-[12.5px] hover:bg-accent/60">
                <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">
                  {message.text}
                  {message.attachments.length > 0 && <span className="text-muted-foreground"> · 📎 {message.attachments.length}</span>}
                </span>
                <button
                  type="button"
                  disabled={busy && !canSteer}
                  title={
                    busy
                      ? canSteer
                        ? t('现在就发给 agent，它会在下一步看到')
                        : t('现在没有 agent 在对话，结束后会自动发出')
                      : t('现在发送')
                  }
                  onClick={() => onSteer(message.id)}
                  className="rounded px-1.5 py-0.5 text-[11.5px] text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  {busy ? t('插话') : t('发送')}
                </button>
                <button
                  type="button"
                  title={t('移除')}
                  aria-label={t('移除')}
                  onClick={() => onUnqueue(message.id)}
                  className="flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-background hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <EditorContent editor={editor} />
        <div className="flex items-center gap-1 px-2 pb-2">
          <IconButton
            label={t('附加文件')}
            className="size-6"
            onClick={async () => {
              const paths = await api.pickUploads(uploadKey)
              if (editor)
                insertAttachments(
                  editor,
                  paths.map((path) => ({
                    path,
                    name:
                      path
                        .split('/')
                        .pop()
                        ?.replace(/^\d{14}-/, '') ?? path,
                  })),
                )
            }}
          >
            <Plus className="size-4" />
          </IconButton>
          {pickers}
          <div className="flex-1" />
          {contextUsage && contextUsage.used > 0 && <ContextRing usage={contextUsage} />}
          {busy && canSend && (
            <span className="mr-1 text-[11px] text-muted-foreground">{canSteer ? t('⏎ 排队 · ⌘⏎ 插话') : t('⏎ 排队')}</span>
          )}
          {busy && (
            <button
              type="button"
              title={t('停止 agent')}
              onClick={onCancel}
              className="flex size-7 items-center justify-center rounded-lg bg-foreground text-background hover:bg-destructive"
            >
              <Square className="size-2.5" fill="currentColor" />
            </button>
          )}
          {(!busy || canSend) && (
            <button
              type="button"
              title={busy ? t('排队') : t('发送')}
              disabled={!canSend}
              onClick={() => send()}
              className={cx(
                'flex size-7 items-center justify-center rounded-lg transition-colors',
                canSend ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground',
              )}
            >
              <ArrowUp className="size-4" strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
      <div className="flex h-6 items-center gap-1.5 px-3 font-mono text-[11px] text-muted-foreground">{context}</div>
    </div>
  )
}

const compact = (tokens: number): string =>
  tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${+(tokens / 1000).toFixed(1)}k` : String(tokens)

/** How full the session's context is: a ring that fills, amber past 70%, red past 90%. */
function ContextRing({ usage }: { usage: ContextUsage }) {
  const ratio = usage.window ? Math.min(1, usage.used / usage.window) : undefined
  const radius = 7
  const circumference = 2 * Math.PI * radius
  const tone = ratio === undefined ? 'text-muted-foreground' : ratio > 0.9 ? 'text-err' : ratio > 0.7 ? 'text-warn' : 'text-foreground/70'
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="mr-1 flex h-6 items-center gap-1 rounded-md px-1 text-[11px] text-muted-foreground tabular-nums hover:bg-accent">
            <svg viewBox="0 0 18 18" className={cx('size-4 -rotate-90', tone)} aria-hidden>
              <circle cx="9" cy="9" r={radius} fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth="2" />
              {ratio !== undefined && (
                <circle
                  cx="9"
                  cy="9"
                  r={radius}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={circumference * (1 - ratio)}
                  className="transition-[stroke-dashoffset] duration-500"
                />
              )}
            </svg>
            {ratio !== undefined ? `${Math.round(ratio * 100)}%` : compact(usage.used)}
          </span>
        }
      />
      <TooltipContent>
        {usage.window
          ? t('上下文 {used} / {window}', { used: compact(usage.used), window: compact(usage.window) })
          : t('上下文 {used}（窗口大小在这一轮结束后可知）', { used: compact(usage.used) })}
      </TooltipContent>
    </Tooltip>
  )
}
