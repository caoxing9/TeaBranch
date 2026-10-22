import { ArrowUp, FileText, Plus, Square } from 'lucide-react'
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import type { ContextUsage } from '@shared/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { IconButton } from '@/components/kit'
import { useLightbox } from '@/components/Lightbox'
import { api } from '@/lib/api'
import { cx } from '@/lib/format'
import { useIssues } from '@/store/issues'

// MARK: - Composer

/**
 * One rounded box that grows with its text, send inside it at the bottom right, quiet details on a
 * line underneath. Return sends, Shift-Return breaks the line, and a Return that commits an input
 * method's candidate is left to the IME — sending half-typed pinyin is the classic bug here.
 */
interface Pending {
  path: string
  name: string
  /** A data URL for images pasted or dropped, so the chip can show what it is. */
  preview?: string
}

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
  pickers,
  contextUsage,
  onSend,
  onCancel,
}: {
  /** Where pasted and attached files are kept, per conversation. */
  uploadKey: string
  /** The quiet line above the text: branch, PR, workspace. */
  context: ReactNode
  placeholder: string
  busy: boolean
  pickers: ReactNode
  /** Session context use, for the ring by the send button. */
  contextUsage?: ContextUsage
  onSend: (message: string, attachments: string[]) => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const [pending, setPending] = useState<Pending[]>([])
  const [dragging, setDragging] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const canSend = !busy && (text.trim().length > 0 || pending.length > 0)

  useLayoutEffect(() => {
    const element = field.current
    if (!element) return
    element.style.height = '0px'
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`
  }, [text])

  const addFiles = async (files: File[]) => {
    for (const file of files) {
      try {
        const base64 = await readAsBase64(file)
        const path = await api.saveUpload(uploadKey, file.name || 'pasted.png', base64)
        const preview = file.type.startsWith('image/') ? `data:${file.type};base64,${base64}` : undefined
        setPending((current) => [...current, { path, name: file.name || 'pasted.png', preview }])
      } catch (error) {
        useIssues.setState({ error: String((error as Error).message) })
      }
    }
  }

  const send = () => {
    if (!canSend) return
    const message = text.trim() || '看一下附件。'
    const attachments = pending.map((file) => file.path)
    setText('')
    setPending([])
    onSend(message, attachments)
  }

  return (
    <div className="shrink-0 px-6 pb-4">
      <div
        className={cx(
          'mx-auto max-w-[760px] rounded-xl border bg-card shadow-xs transition-colors focus-within:border-ring',
          dragging && 'border-brand bg-brand-soft',
        )}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          void addFiles([...event.dataTransfer.files])
        }}
      >
        <div className="flex items-center gap-1.5 px-3 pt-2.5 font-mono text-[11px] text-muted-foreground">{context}</div>
        {pending.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-2">
            {pending.map((file) => (
              <span
                key={file.path}
                className="group relative flex h-12 items-center gap-2 rounded-lg border bg-muted/50 pr-2 text-[11.5px]"
              >
                {file.preview ? (
                  <img
                    src={file.preview}
                    alt=""
                    onClick={() => useLightbox.getState().open([{ url: file.preview as string, name: file.name }])}
                    className="h-full w-14 cursor-zoom-in rounded-l-lg object-cover"
                  />
                ) : (
                  <FileText className="ml-2 size-4 text-muted-foreground" />
                )}
                <span className="max-w-36 truncate">{file.name}</span>
                <button
                  type="button"
                  title="移除"
                  onClick={() => setPending((current) => current.filter((candidate) => candidate.path !== file.path))}
                  className="absolute -top-1.5 -right-1.5 hidden size-4 items-center justify-center rounded-full bg-foreground text-[10px] text-background group-hover:flex"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={field}
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onPaste={(event) => {
            const files = [...event.clipboardData.files]
            if (!files.length) return
            event.preventDefault()
            void addFiles(files)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return
            event.preventDefault()
            send()
          }}
          placeholder={busy ? 'Agent 正在工作，可以先写下一条…' : placeholder}
          className="selectable block max-h-40 min-h-[22px] w-full resize-none bg-transparent px-3 py-2 text-[13.5px] leading-[20px] outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <IconButton
            label="附加文件"
            className="size-6"
            onClick={async () => {
              const paths = await api.pickUploads(uploadKey)
              setPending((current) => [
                ...current,
                ...paths.map((path) => ({
                  path,
                  name:
                    path
                      .split('/')
                      .pop()
                      ?.replace(/^\d{14}-/, '') ?? path,
                })),
              ])
            }}
          >
            <Plus className="size-4" />
          </IconButton>
          {pickers}
          <div className="flex-1" />
          {contextUsage && contextUsage.used > 0 && <ContextRing usage={contextUsage} />}
          <span className="mr-1 text-[11px] text-muted-foreground">{busy ? '运行中' : '⏎ 发送'}</span>
          {busy ? (
            <button
              type="button"
              title="停止 agent"
              onClick={onCancel}
              className="flex size-7 items-center justify-center rounded-lg bg-foreground text-background hover:bg-destructive"
            >
              <Square className="size-2.5" fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              title="发送"
              disabled={!canSend}
              onClick={send}
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
        上下文 {compact(usage.used)}
        {usage.window ? ` / ${compact(usage.window)}` : '（窗口大小在这一轮结束后可知）'}
      </TooltipContent>
    </Tooltip>
  )
}
