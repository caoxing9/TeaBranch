import { describe, expect, it } from 'vitest'
import { agentMessage, markerSegments } from './attachments'

describe('attachments', () => {
  it('leaves a message without attachments alone', () => {
    expect(agentMessage('hi', [])).toBe('hi')
  })

  it('lists the paths under the markers they stand for', () => {
    const sent = agentMessage('按钮错位 [📎 1]，正常的是 [📎 2]', ['/u/a.png', '/u/b.png'])
    expect(sent).toContain('[📎 1] /u/a.png\n[📎 2] /u/b.png')
  })

  it('splits a shown message at its markers', () => {
    expect(markerSegments('[📎 1]', 1)).toEqual([1])
    expect(markerSegments('按钮 [📎 1] 和 [📎 2] 对比', 2)).toEqual(['按钮 ', 1, ' 和 ', 2, ' 对比'])
    // A marker typed by hand, past what was attached, is just text.
    expect(markerSegments('看 [📎 3]', 1)).toEqual(['看 [📎 3]'])
  })
})
