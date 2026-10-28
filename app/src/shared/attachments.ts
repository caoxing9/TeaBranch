/**
 * Attachments sit in a message where they were pasted: `[📎 N]` marks the spot, N counting from 1
 * in the order of the paths sent with the message. The agent then knows which picture a sentence
 * is about, instead of getting them all in a pile at the end.
 */
export const attachmentMarker = (n: number): string => `[📎 ${n}]`

/** The message as the agent reads it: markers in the text, the paths they stand for after it. */
export function agentMessage(message: string, attachments: string[]): string {
  if (!attachments.length) return message
  const list = attachments.map((path, index) => `${attachmentMarker(index + 1)} ${path}`).join('\n')
  return `${message}\n\n<attachments>\n${list}\n</attachments>\nEach [📎 N] in the message stands where attachment N belongs. Open them with the Read tool.`
}

/**
 * …and as the transcript shows it: text, and where a marker stands the attachment's number (from
 * 1), for the picture to go in its place. Markers past the attachments stay text.
 */
export function markerSegments(message: string, count: number): (string | number)[] {
  const segments: (string | number)[] = []
  let last = 0
  for (const match of message.matchAll(/\[📎 (\d+)\]/g)) {
    const n = Number(match[1])
    if (n < 1 || n > count) continue
    if (match.index > last) segments.push(message.slice(last, match.index))
    segments.push(n)
    last = match.index + match[0].length
  }
  if (last < message.length) segments.push(message.slice(last))
  return segments
}
