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

/** …and as the transcript shows it: the markers stay, the list after them goes by file name. */
export const shownMessage = (message: string, attachments: string[]): string =>
  attachments.length
    ? `${message}\n\n${attachments.map((path, index) => `${attachmentMarker(index + 1)} ${path.split('/').pop()}`).join('  ')}`
    : message
