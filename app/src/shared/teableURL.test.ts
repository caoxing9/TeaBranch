import { describe, expect, it } from 'vitest'
import { parseTableURL, sameHost } from './teableURL'

describe('parseTableURL', () => {
  it('reads base, table and view', () => {
    expect(parseTableURL('https://app.teable.ai/base/bse1/table/tbl2/viw3')).toEqual({
      baseURL: 'https://app.teable.ai',
      baseId: 'bse1',
      tableId: 'tbl2',
      viewId: 'viw3',
    })
  })

  it('takes a table without a view, with a query string, or without the scheme', () => {
    expect(parseTableURL(' app.teable.ai/base/bse1/table/tbl2?recordId=rec9 ')).toEqual({
      baseURL: 'https://app.teable.ai',
      baseId: 'bse1',
      tableId: 'tbl2',
      viewId: undefined,
    })
  })

  it('takes a link to just a base', () => {
    expect(parseTableURL('http://localhost:3000/base/bse1')).toEqual({
      baseURL: 'http://localhost:3000',
      baseId: 'bse1',
      tableId: undefined,
      viewId: undefined,
    })
  })

  it('ignores what is not a Teable link', () => {
    expect(parseTableURL('hello')).toBeUndefined()
    expect(parseTableURL('https://app.teable.ai/space/spc1')).toBeUndefined()
  })

  it('compares hosts loosely', () => {
    expect(sameHost('https://app.teable.ai/', 'https://APP.teable.ai')).toBe(true)
    expect(sameHost('https://app.teable.ai', 'https://app.teable.cn')).toBe(false)
  })
})
