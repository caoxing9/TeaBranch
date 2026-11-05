import { Image, Text, View } from 'nsh'
import type { Attachment, IssueComment } from '../../../shared/types'
import { getLocale, t } from '../../../shared/i18n'
import { Icon } from '../../components/Icon'
import { lightbox } from '../../components/Lightbox'
import { Markdown } from '../../components/Markdown'
import { PersonAvatar } from '../../components/person'
import { api } from '../../lib/api'
import { formatBytes } from '../../lib/format'

const isImage = (attachment: Attachment): boolean => attachment.mimetype.startsWith('image/')

/** Attachments as a strip of thumbnails; files that aren't images as chips. */
export function Attachments(props: { attachments: Attachment[] }) {
  const images = () => props.attachments.filter((attachment) => isImage(attachment) && attachment.url)
  // Images preview in place; other files (PDFs, logs, videos) still go to the default app.
  const open = (attachment: Attachment) => {
    const at = images().indexOf(attachment)
    if (at >= 0) lightbox.open(images().map((image) => ({ url: image.url as string, name: image.name })), at)
    else if (attachment.url) void api.openExternal(attachment.url)
  }
  return (
    <If when={props.attachments.length > 0}>
      <View class="flex-row flex-wrap gap-2">
        <Each of={props.attachments} key={(attachment, index) => `${attachment.name}-${index}`}>
          {(attachment) => (
            <If
              when={isImage(attachment()) && (attachment().thumbnail || attachment().url)}
              else={
                <View class="h-10 max-w-60 flex-row items-center gap-2 rounded-lg border border-border bg-card px-3 shadow-xs hover:bg-accent" role="button" onPress={() => open(attachment())}>
                  <Icon name="file-text" size={16} tint="fg-2" />
                  <Text class="text-[12px] text-fg" style={{ numberOfLines: 1 }}>
                    {attachment().name}
                  </Text>
                  <Text class="shrink-0 text-[12px] text-fg-2">{formatBytes(attachment().size)}</Text>
                </View>
              }
            >
              <View class="h-24 w-36 overflow-hidden rounded-lg border border-border bg-muted shadow-xs" role="button" tooltip={`${attachment().name} · ${formatBytes(attachment().size)}`} onPress={() => open(attachment())}>
                <Image src={(attachment().thumbnail ?? attachment().url) as string} class="h-full w-full object-cover" />
              </View>
            </If>
          )}
        </Each>
      </View>
    </If>
  )
}

export function AttachmentsLabel(props: { count: number }) {
  return (
    <View class="flex-row items-center gap-1">
      <Icon name="paperclip" size={12} tint="fg-2" />
      <Text class="text-[11px] text-fg-2">{t('{n} 个附件', { n: props.count })}</Text>
    </View>
  )
}

const when = (time: number): string =>
  new Date(time).toLocaleString(getLocale() === 'en' ? 'en-US' : 'zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** The record's comment thread — often where the reproduction steps really are. */
export function Comments(props: { comments: IssueComment[] }) {
  return (
    <If when={props.comments.length > 0}>
      <View class="rounded-xl border border-border bg-card shadow-xs">
        <View class="flex-row items-center gap-2 border-b border-border px-4 py-2.5">
          <Icon name="message-square" size={14} tint="fg-2" />
          <Text class="text-[12px] font-semibold text-fg-2">{t('评论 {n}', { n: props.comments.length })}</Text>
        </View>
        <View class="gap-px bg-border/60">
          <Each of={props.comments} key={(comment) => comment.id}>
            {(comment) => (
              <View class="flex-row gap-3 bg-card px-4 py-3">
                <PersonAvatar person={comment().author} size={24} tooltip={false} />
                <View class="min-w-0 flex-1">
                  <View class="flex-row items-baseline gap-2">
                    <Text class="text-[12px] font-medium text-fg">{comment().author.name}</Text>
                    <Text class="text-[12px] text-fg-2">{when(comment().createdTime)}</Text>
                  </View>
                  <If when={comment().text}>
                    <Markdown text={comment().text} class="text-[13px] text-fg" />
                  </If>
                  <If when={comment().images.length > 0}>
                    <View class="mt-2 flex-row flex-wrap gap-2">
                      <Each of={comment().images} key={(url) => url}>
                        {(url, index) => (
                          <View
                            class="h-20 w-32 overflow-hidden rounded-md border border-border bg-muted"
                            role="button"
                            accessibilityLabel={t('查看图片 {n}', { n: index() + 1 })}
                            onPress={() => lightbox.open(comment().images.map((image) => ({ url: image })), index())}
                          >
                            <Image src={url()} class="h-full w-full object-cover" />
                          </View>
                        )}
                      </Each>
                    </View>
                  </If>
                </View>
              </View>
            )}
          </Each>
        </View>
      </View>
    </If>
  )
}
