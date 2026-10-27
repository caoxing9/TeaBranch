import { describe, expect, it } from 'vitest'
import { ciFailures, ciPending, parseChecks, toCheck } from './ci'

describe('ci', () => {
  it('folds check runs and commit statuses into buckets', () => {
    expect(toCheck({ name: 'V2 Tests', status: 'COMPLETED', conclusion: 'FAILURE' }).bucket).toBe('fail')
    expect(toCheck({ name: 'Unit', status: 'IN_PROGRESS' }).bucket).toBe('pending')
    expect(toCheck({ name: 'Lint', status: 'COMPLETED', conclusion: 'SKIPPED' }).bucket).toBe('skip')
    expect(toCheck({ name: 'Mobile', status: 'COMPLETED', conclusion: 'SUCCESS' }).bucket).toBe('pass')
    expect(toCheck({ context: 'E2E Lab', state: 'PENDING' })).toMatchObject({ name: 'E2E Lab', bucket: 'pending' })
    expect(toCheck({ context: 'ext', state: 'ERROR', targetUrl: 'https://ci' })).toMatchObject({ bucket: 'fail', link: 'https://ci' })
  })

  it('reads gh pr view output', () => {
    const ci = parseChecks(
      JSON.stringify({
        state: 'OPEN',
        headRefOid: 'abc',
        statusCheckRollup: [
          { name: 'V2 Tests', status: 'COMPLETED', conclusion: 'FAILURE' },
          { name: 'Unit', status: 'QUEUED' },
        ],
      }),
    )
    expect(ci?.sha).toBe('abc')
    expect(ciFailures({ ...ci!, at: 0 }).map((check) => check.name)).toEqual(['V2 Tests'])
    expect(ciPending({ ...ci!, at: 0 })).toBe(true)
    expect(parseChecks('nope')).toBeUndefined()
  })
})
