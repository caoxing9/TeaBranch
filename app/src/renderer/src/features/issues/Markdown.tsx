import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Agent and reviewer prose: GitHub-flavoured Markdown, links out to the browser. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
