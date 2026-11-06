import { ArrowUp, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { DRAFT_UPLOADS } from '@shared/attachments'
import { t } from '@shared/i18n'
import { IconButton, Spinner } from '@/components/kit'
import { api, messageOf } from '@/lib/api'
import { cx } from '@/lib/format'
import { useAutopilot } from '@/store/autopilot'
import { type AttachmentAttrs, EditorContent, insertAttachments, readAsBase64, serialize, useMessageEditor } from '../issues/MessageEditor'

/**
 * The one box on the home page: what you say here goes to the router, which decides what it is — a
 * question it answers, something to look into, a word for a task — and answers in the same place.
 * Return sends; ⌘Return skips the router and starts a probe straight away; Shift-Return breaks the
 * line. Screenshots paste or drop in where they belong, and wait in the draft uploads until the
 * message owns them.
 */
export function HomeComposer() {
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const focusKey = useAutopilot((s) => s.focusKey)

  const addFiles = async (files: File[], at?: number) => {
    const saved: AttachmentAttrs[] = []
    for (const file of files) {
      try {
        const base64 = await readAsBase64(file)
        const name = file.name || 'pasted.png'
        const path = await api.saveUpload(DRAFT_UPLOADS, name, base64)
        saved.push({ path, name, preview: file.type.startsWith('image/') ? `data:${file.type};base64,${base64}` : undefined })
      } catch (error) {
        useAutopilot.setState({ error: messageOf(error) })
      }
    }
    if (editor) insertAttachments(editor, saved, at)
  }

  const submit = async (direct: boolean) => {
    if (!editor || busy) return
    const { text, attachments } = serialize(editor)
    if (!text && !attachments.length) return
    setBusy(true)
    try {
      const message = text || t('看一下附件。')
      if (direct) await api.probe(message, attachments)
      else await api.askRouter(message, attachments)
      editor.commands.clearContent(true)
    } catch (error) {
      useAutopilot.setState({ error: messageOf(error) })
    } finally {
      setBusy(false)
    }
  }

  const { editor, filled } = useMessageEditor({
    placeholder: t('有什么要查的、要问的…'),
    onSubmit: (direct) => void submit(direct),
    onFiles: (files, at) => void addFiles(files, at),
  })

  // The sidebar's "new probe": the cursor comes here.
  useEffect(() => {
    if (focusKey) editor?.commands.focus('end')
  }, [editor, focusKey])

  const pick = async () => {
    const paths = await api.pickUploads(DRAFT_UPLOADS)
    if (editor && paths.length)
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
  }

  return (
    <div
      className={cx(
        'rounded-[22px] border border-border bg-card shadow-[0_1px_2px_rgb(0_0_0/0.03),0_8px_24px_rgb(0_0_0/0.05)] transition-[border-color,box-shadow] focus-within:border-border-strong focus-within:shadow-[0_1px_2px_rgb(0_0_0/0.04),0_12px_32px_rgb(0_0_0/0.08)] dark:shadow-none',
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
      <EditorContent editor={editor} />
      <div className="flex items-center gap-1 px-2.5 pb-2.5">
        <IconButton label={t('附加文件')} className="size-7 rounded-full" onClick={() => void pick()}>
          <Plus className="size-4" />
        </IconButton>
        <div className="flex-1" />
        {filled && !busy && <span className="mr-1.5 text-[11px] text-fg-3">{t('↩ 发送 · ⌘↩ 直接探查')}</span>}
        <button
          type="button"
          title={t('发送')}
          disabled={!filled || busy}
          onClick={() => void submit(false)}
          className={cx(
            'flex size-8 items-center justify-center rounded-xl transition-colors',
            filled && !busy ? 'bg-primary text-primary-foreground hover:bg-primary/85' : 'bg-muted text-fg-3',
          )}
        >
          {busy ? <Spinner /> : <ArrowUp className="size-4" strokeWidth={2.5} />}
        </button>
      </div>
    </div>
  )
}
