import { openUrl } from 'nsh'
import { TextView } from 'nsh/base'
import { lightbox } from './Lightbox'

/** Agent and reviewer prose: GitHub-flavoured Markdown, links out to the browser, images previewed in place. */
export function Markdown(props: { text: string; class?: string }) {
  return (
    <TextView
      markdown={props.text}
      style={{ userSelect: 'text' }}
      links="report"
      class={props.class ?? 'text-[13.5px] leading-[1.65] text-fg'}
      classes={{
        paragraph: 'my-1',
        heading: 'mt-3 mb-1 text-[14px] font-semibold',
        heading1: 'text-[15px]',
        heading2: 'text-[14.5px]',
        code: 'rounded bg-muted px-1 font-mono text-[12.5px]',
        codeBlock: 'my-1.5 rounded-lg border border-border bg-log',
        codeBlockCode: 'px-3 py-2.5 font-mono text-[12px] text-log-fg',
        link: 'text-link',
        blockquote: 'my-1 border-l-2 border-border pl-2.5 text-fg-2',
        list: 'my-1',
        listItem: 'my-0.5',
        listMarker: 'text-fg-2',
        image: 'my-1 rounded-lg border border-border',
        table: 'my-1.5',
        tableCell: 'border border-border px-2 py-0.5',
        tableHeaderCell: 'border border-border px-2 py-0.5 font-semibold',
        rule: 'my-2 border-border',
      }}
      onLinkPress={({ url }) => void openUrl(url)}
      onImagePress={({ image }) => lightbox.open([{ url: image.src, name: image.alt || undefined }])}
    />
  )
}
