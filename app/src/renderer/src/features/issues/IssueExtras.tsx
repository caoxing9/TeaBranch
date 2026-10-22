import { FileText, MessageSquare, Paperclip } from 'lucide-react'
import type { Attachment, IssueComment } from '@shared/types'
import { getLocale, t } from '@shared/i18n'
import { PersonAvatar } from '@/components/person'
import { useLightbox } from '@/components/Lightbox'
import { api } from '@/lib/api'
import { formatBytes } from '@/lib/format'
import { Markdown } from './Markdown'

const isImage = (attachment: Attachment): boolean => attachment.mimetype.startsWith('image/')

/** Attachments as a strip of thumbnails; files that aren't images as chips. */
export function Attachments({ attachments }: { attachments: Attachment[] }) {
  if (!attachments.length) return null
  const images = attachments.filter((attachment) => isImage(attachment) && attachment.url)
  // Images preview in place; other files (PDFs, logs, videos) still go to the default app.
  const open = (attachment: Attachment) => {
    const at = images.indexOf(attachment)
    if (at >= 0)
      useLightbox.getState().open(
        images.map((image) => ({ url: image.url as string, name: image.name })),
        at,
      )
    else if (attachment.url) void api.openExternal(attachment.url)
  }
  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((attachment, index) =>
        isImage(attachment) && (attachment.thumbnail || attachment.url) ? (
          <button
            key={`${attachment.name}-${index}`}
            type="button"
            title={`${attachment.name} · ${formatBytes(attachment.size)}`}
            onClick={() => open(attachment)}
            className="group relative h-24 w-36 cursor-zoom-in overflow-hidden rounded-lg border bg-muted shadow-xs"
          >
            <img
              src={attachment.thumbnail ?? attachment.url}
              alt={attachment.name}
              className="size-full object-cover transition group-hover:scale-[1.03]"
            />
          </button>
        ) : (
          <button
            key={`${attachment.name}-${index}`}
            type="button"
            onClick={() => open(attachment)}
            className="flex h-10 max-w-60 items-center gap-2 rounded-lg border bg-card px-3 text-[12px] shadow-xs hover:bg-accent"
          >
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{attachment.name}</span>
            <span className="shrink-0 text-muted-foreground">{formatBytes(attachment.size)}</span>
          </button>
        ),
      )}
    </div>
  )
}

export function AttachmentsLabel({ count }: { count: number }) {
  return (
    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
      <Paperclip className="size-3" />
      {t('{n} 个附件', { n: count })}
    </span>
  )
}

const when = (time: number): string =>
  new Date(time).toLocaleString(getLocale() === 'en' ? 'en-US' : 'zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

/** The record's comment thread — often where the reproduction steps really are. */
export function Comments({ comments }: { comments: IssueComment[] }) {
  if (!comments.length) return null
  return (
    <div className="rounded-xl border bg-card shadow-xs">
      <div className="flex items-center gap-2 border-b px-4 py-2.5 text-[12px] font-semibold text-muted-foreground">
        <MessageSquare className="size-3.5" />
        {t('评论 {n}', { n: comments.length })}
      </div>
      <div className="divide-y">
        {comments.map((comment) => (
          <div key={comment.id} className="flex gap-3 px-4 py-3">
            <PersonAvatar person={comment.author} className="size-6" tooltip={false} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 text-[12px]">
                <span className="font-medium">{comment.author.name}</span>
                <span className="text-muted-foreground">{when(comment.createdTime)}</span>
              </div>
              {comment.text && (
                <div className="text-[13px]">
                  <Markdown text={comment.text} />
                </div>
              )}
              {comment.images.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {comment.images.map((url, index) => (
                    <button
                      key={url}
                      type="button"
                      aria-label={t('查看图片 {n}', { n: index + 1 })}
                      onClick={() =>
                        useLightbox.getState().open(
                          comment.images.map((image) => ({ url: image })),
                          index,
                        )
                      }
                      className="h-20 w-32 overflow-hidden rounded-md border bg-muted"
                    >
                      <img src={url} alt="" className="size-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
