import { describe, expect, it } from 'vitest'
import { triageVerdict } from './types'

describe('triageVerdict', () => {
  it('reads the verdict line', () => {
    expect(triageVerdict('复现了。\nTRIAGE: BUG')).toBe('bug')
    expect(triageVerdict('见 #4012\nTRIAGE: ALREADY_FIXED')).toBe('fixed')
    expect(triageVerdict('TRIAGE: NOT_A_BUG — 设计如此')).toBe('notBug')
    expect(triageVerdict('**TRIAGE: NEEDS_INFO**')).toBe('needsInfo')
  })

  it('takes the last line when the report quotes the options first', () => {
    expect(triageVerdict('可选 TRIAGE: BUG 或 TRIAGE: NOT_A_BUG\n…\nTRIAGE: ALREADY_FIXED')).toBe('fixed')
  })

  it('is undefined without a verdict', () => {
    expect(triageVerdict('还在看')).toBeUndefined()
    expect(triageVerdict('TRIAGE: MAYBE')).toBeUndefined()
  })
})
