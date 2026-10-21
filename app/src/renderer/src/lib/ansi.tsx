import Anser from 'anser'
import type { ReactNode } from 'react'

/** ANSI SGR escapes → styled spans. Dev servers colour their output and losing it hurts. */
export function renderAnsi(text: string, highlight?: string): ReactNode[] {
  const parts = Anser.ansiToJson(text, { use_classes: false, remove_empty: true })
  return parts.map((part, index) => {
    const style: React.CSSProperties = {}
    if (part.fg) style.color = `rgb(${part.fg})`
    if (part.bg) style.backgroundColor = `rgb(${part.bg})`
    if (part.decorations.includes('bold')) style.fontWeight = 600
    if (part.decorations.includes('dim')) style.opacity = 0.65
    if (part.decorations.includes('italic')) style.fontStyle = 'italic'
    if (part.decorations.includes('underline')) style.textDecoration = 'underline'
    return (
      <span key={index} style={style}>
        {highlight ? mark(part.content, highlight) : part.content}
      </span>
    )
  })
}

function mark(text: string, needle: string): ReactNode {
  const lower = text.toLowerCase()
  const nodes: ReactNode[] = []
  let from = 0
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
    nodes.push(text.slice(from, at))
    nodes.push(
      <mark key={at} className="rounded-sm bg-yellow-300/70 text-black">
        {text.slice(at, at + needle.length)}
      </mark>,
    )
    from = at + needle.length
  }
  nodes.push(text.slice(from))
  return nodes
}

export const stripAnsi = (text: string): string => Anser.ansiToText(text)
