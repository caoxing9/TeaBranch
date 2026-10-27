import { describe, expect, it } from 'vitest'
import { agentMessage, shownMessage } from './attachments'

describe('attachments', () => {
  it('leaves a message without attachments alone', () => {
    expect(agentMessage('hi', [])).toBe('hi')
    expect(shownMessage('hi', [])).toBe('hi')
  })

  it('lists the paths under the markers they stand for', () => {
    const sent = agentMessage('按钮错位 [📎 1]，正常的是 [📎 2]', ['/u/a.png', '/u/b.png'])
    expect(sent).toContain('[📎 1] /u/a.png\n[📎 2] /u/b.png')
    expect(shownMessage('看 [📎 1]', ['/u/a.png'])).toBe('看 [📎 1]\n\n[📎 1] a.png')
  })
})
