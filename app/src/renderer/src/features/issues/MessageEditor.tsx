import { type Editor, Extension, mergeAttributes, Node } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import HardBreak from '@tiptap/extension-hard-break'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { Placeholder, UndoRedo } from '@tiptap/extensions'
import { EditorContent, useEditor, useEditorState, type UseEditorOptions } from '@tiptap/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { attachmentMarker } from '@shared/attachments'
import { useLightbox } from '@/components/Lightbox'

/**
 * The composer's text, with attachments inline where they were pasted or dropped — a thumbnail you
 * can see and click, not a list off to the side. Plain text otherwise: paste keeps only the words.
 */
export interface AttachmentAttrs {
  path: string
  name: string
  /** A data URL for images, so the chip shows the picture. */
  preview?: string
}

const Attachment = Node.create({
  name: 'attachment',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return { path: { default: '' }, name: { default: '' }, preview: { default: null } }
  },

  parseHTML() {
    return [{ tag: 'span[data-attachment]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const { name, preview } = node.attrs as AttachmentAttrs
    const attrs = mergeAttributes(HTMLAttributes, { 'data-attachment': '', class: 'composer-attachment', title: name })
    return preview
      ? ['span', attrs, ['img', { src: preview, alt: name, draggable: 'false' }]]
      : ['span', attrs, ['span', { class: 'composer-attachment-file' }, `📄 ${name}`]]
  },

  renderText({ node }) {
    return `[${(node.attrs as AttachmentAttrs).name}]`
  },
})

const composerStorage = (editor: Editor): { placeholder: string } =>
  (editor.storage as unknown as Record<string, { placeholder: string }>).composerKeys

/** The text with a `[📎 N]` where each attachment sits, and the paths in that order. */
export function serialize(editor: Editor): { text: string; attachments: string[] } {
  const attachments: string[] = []
  const lines: string[] = []
  editor.state.doc.forEach((paragraph) => {
    let line = ''
    paragraph.forEach((node) => {
      if (node.isText) line += node.text
      else if (node.type.name === 'hardBreak') line += '\n'
      else if (node.type.name === 'attachment') {
        attachments.push((node.attrs as AttachmentAttrs).path)
        line += attachmentMarker(attachments.length)
      }
    })
    lines.push(line)
  })
  return { text: lines.join('\n').trim(), attachments }
}

export function insertAttachments(editor: Editor, files: AttachmentAttrs[], at?: number): void {
  if (!files.length) return
  const chain = editor.chain().focus()
  const content = files.flatMap((attrs) => [
    { type: 'attachment', attrs },
    { type: 'text', text: ' ' },
  ])
  ;(at === undefined ? chain.insertContent(content) : chain.insertContentAt(at, content)).run()
}

export function useMessageEditor({
  placeholder,
  onSubmit,
  onFiles,
}: {
  placeholder: string
  /** Return sends; ⌘Return steers into the running turn. */
  onSubmit: (steer: boolean) => void
  /** Files pasted or dropped, and the document position they go at. */
  onFiles: (files: File[], at?: number) => void
}) {
  // The editor is built once; these read the latest props.
  const latest = useRef({ onSubmit, onFiles })
  useLayoutEffect(() => {
    latest.current = { onSubmit, onFiles }
  })

  // Built once and handed over as the same object every render: useEditor compares options by identity
  // and, on any difference, resets the view's props — which cancels an input method's composition
  // mid-word (Backspace through pinyin while the store ticks, and the letters land as text).
  const [options] = useState<UseEditorOptions>(() => ({
    extensions: [
      Document,
      Paragraph,
      Text,
      HardBreak,
      UndoRedo,
      Attachment,
      Placeholder.configure({ placeholder: ({ editor: current }) => composerStorage(current).placeholder }),
      Extension.create({
        name: 'composerKeys',
        // Above HardBreak, which claims ⌘Return too.
        priority: 1000,
        addStorage: () => ({ placeholder }),
        addKeyboardShortcuts() {
          // An input method's candidate commit never reaches here: ProseMirror leaves composition alone.
          const submit = (steer: boolean) => () => {
            latest.current.onSubmit(steer)
            return true
          }
          return { Enter: submit(false), 'Mod-Enter': submit(true), 'Shift-Enter': () => this.editor.commands.setHardBreak() }
        },
      }),
    ],
    editorProps: {
      attributes: {
        class:
          'selectable block max-h-60 min-h-[60px] w-full overflow-y-auto px-4 pt-3 pb-1 text-[13.5px] leading-[20px] whitespace-pre-wrap outline-none',
      },
      handlePaste(_view, event) {
        const files = [...(event.clipboardData?.files ?? [])]
        if (!files.length) return false
        latest.current.onFiles(files)
        return true
      },
      handleDrop(view, event, _slice, moved) {
        const files = [...(event.dataTransfer?.files ?? [])]
        if (moved || !files.length) return false
        event.preventDefault()
        latest.current.onFiles(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos)
        return true
      },
      handleClickOn(_view, _pos, node) {
        const { preview, name } = node.attrs as Partial<AttachmentAttrs>
        if (node.type.name !== 'attachment' || !preview) return false
        useLightbox.getState().open([{ url: preview, name: name ?? '' }])
        return true
      },
    },
  }))
  const editor = useEditor(options)

  // The placeholder is a decoration: redraw it when it changes (busy ⇄ idle).
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    composerStorage(editor).placeholder = placeholder
    editor.view.dispatch(editor.state.tr)
  }, [editor, placeholder])

  const filled = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      if (!current) return false
      const { text, attachments } = serialize(current)
      return text.length > 0 || attachments.length > 0
    },
  })

  return { editor, filled: !!filled }
}

export { EditorContent }
