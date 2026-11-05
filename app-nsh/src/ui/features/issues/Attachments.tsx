import { Image, Text, View, resource } from 'nsh'
import { markerSegments } from '../../../shared/attachments'
import { lightbox } from '../../components/Lightbox'
import { Icon } from '../../components/Icon'
import { api } from '../../lib/api'

/** A message's text with its attachments shown where their markers sit, the unmarked ones after it. */
export function WithAttachments(props: { text: string; attachments: string[]; class?: string }) {
  const segments = () => {
    const marked = markerSegments(props.text, props.attachments.length)
    const unmarked = props.attachments.map((_, index) => index + 1).filter((n) => !marked.includes(n))
    return [...marked, ...(unmarked.length ? ['\n', ...unmarked] : [])]
  }
  return (
    <View class="flex-row flex-wrap items-end gap-1">
      <Each of={segments()} key="index">
        {(segment) => (
          <If when={typeof segment() === 'string'} else={<Attachment path={props.attachments[(segment() as number) - 1]} paths={props.attachments} />}>
            <Text class={props.class ?? 'text-[13.5px] leading-relaxed text-fg'} style={{ userSelect: 'text' }}>
              {segment() as string}
            </Text>
          </If>
        )}
      </Each>
    </View>
  )
}

const nameOf = (path: string): string => path.split('/').pop()?.replace(/^\d{14}-/, '') ?? path

/** One attachment: an image as a thumbnail that opens the preview, anything else as a chip. */
export function Attachment(props: { path: string; paths: string[] }) {
  const preview = resource(() => props.path, (path) => api.readUpload(path))
  const open = () => {
    const images = props.paths.map((path) => ({ url: path, name: nameOf(path) }))
    void Promise.all(props.paths.map((path) => api.readUpload(path))).then((urls) => {
      const shown = images.map((image, index) => ({ ...image, url: urls[index] ?? '' })).filter((image) => image.url)
      const at = Math.max(0, props.paths.indexOf(props.path) - props.paths.slice(0, props.paths.indexOf(props.path)).filter((p, i) => !urls[i]).length)
      if (shown.length) lightbox.open(shown, at)
    })
  }
  return (
    <If
      when={preview()}
      else={
        <View class="h-5 flex-row items-center gap-1 rounded-md border border-border bg-muted px-1.5">
          <Icon name="file-text" size={12} tint="fg-2" />
          <Text class="text-[12px] text-fg">{nameOf(props.path)}</Text>
        </View>
      }
    >
      {(url) => (
        <View class="overflow-hidden rounded-md border border-border" role="button" tooltip={nameOf(props.path)} onPress={open}>
          <Image src={url()} class="object-cover" style={{ height: 80, width: 120 }} />
        </View>
      )}
    </If>
  )
}
