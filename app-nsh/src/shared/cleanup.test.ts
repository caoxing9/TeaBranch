import {describe, expect, test } from 'nsh/test'
import { cleanupBlockers } from './cleanup'

describe('cleanupBlockers', () => {
  test('clears a merged PR with nothing left behind', () => {
    expect(cleanupBlockers({ prState: 'MERGED', unpushed: 0, changed: 0 })).toEqual([])
    expect(cleanupBlockers({ prState: 'CLOSED', unpushed: 0, changed: 0 })).toEqual([])
  })

  test('clears a probe that never got a PR', () => {
    expect(cleanupBlockers({ unpushed: 0, changed: 0 })).toEqual([])
  })

  test('holds what it could not check', () => {
    expect(cleanupBlockers({ unpushed: 0, changed: 0, unknown: ['git status'] })).toHaveLength(1)
  })

  test('holds an open PR, unpushed commits and edited files, each its own reason', () => {
    expect(cleanupBlockers({ prState: 'OPEN', unpushed: 2, changed: 3 })).toHaveLength(3)
    expect(cleanupBlockers({ prState: 'MERGED', unpushed: 1, changed: 0 })).toHaveLength(1)
    expect(cleanupBlockers({ unpushed: 0, changed: 1 })).toHaveLength(1)
  })
})
