import ReactMarkdown, { type Components } from 'react-markdown'
import { useLightbox } from '@/components/Lightbox'
import remarkGfm from 'remark-gfm'

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  // Images in descriptions and comments preview in place rather than opening a download.
  img: ({ src, alt }) =>
    typeof src === 'string' ? (
      <img
        src={src}
        alt={alt ?? ''}
        onClick={() => useLightbox.getState().open([{ url: src, name: alt || undefined }])}
        className="cursor-zoom-in"
      />
    ) : null,
}

/** Agent and reviewer prose: GitHub-flavoured Markdown, links out to the browser. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-chat">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
