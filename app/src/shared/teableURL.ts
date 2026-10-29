/**
 * Where a link copied from the Teable web app points: its host, and the base, table and view in its
 * path — `/base/bse…/table/tbl…/viw…`. A link to just a base is still useful: it picks the base.
 */
export interface TableLink {
  baseURL: string
  baseId: string
  tableId?: string
  viewId?: string
}

export function parseTableURL(raw: string): TableLink | undefined {
  const text = raw.trim()
  if (!text) return undefined
  let url: URL
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return undefined
  }
  const parts = url.pathname.split('/').filter(Boolean)
  const after = (key: string): string | undefined => {
    const index = parts.indexOf(key)
    return index >= 0 ? parts[index + 1] : undefined
  }
  const baseId = after('base')
  if (!baseId) return undefined
  const tableId = after('table')
  const view = tableId ? parts[parts.indexOf('table') + 2] : undefined
  return {
    baseURL: url.origin,
    baseId,
    tableId,
    viewId: view?.startsWith('viw') ? view : undefined,
  }
}

/** Same Teable server, whatever the trailing slash or letter case. */
export const sameHost = (a: string, b: string): boolean => {
  try {
    return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase()
  } catch {
    return false
  }
}
