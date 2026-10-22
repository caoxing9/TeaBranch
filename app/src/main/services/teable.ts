import { t } from '@shared/i18n'
import type {
  Attachment,
  IssueComment,
  Person,
  TeableConfig,
  TeableField,
  TeableLevel,
  TeableNode,
  TeableRecord,
  TeableUser,
} from '@shared/types'
import { httpFetch } from '../core/http'
import { TeaBranchError } from '../core/log'

/** The Teable REST API with a personal access token. */

export const apiBase = (config: TeableConfig): string => config.baseURL.replace(/[/\s]+$/, '')

export const tokenPageURL = (baseURL: string): string => `${baseURL.replace(/[/\s]+$/, '')}/setting/personal-access-token`

/** The record opened in the Teable web app. */
export function recordURL(config: TeableConfig, recordId: string): string {
  const view = config.viewId ? `/${config.viewId}` : ''
  return `${apiBase(config)}/base/${config.baseId}/table/${config.tableId}${view}?recordId=${recordId}`
}

/** base/table/view ids out of a URL copied from the browser. */
export function parseTableURL(raw: string): Partial<TeableConfig> | undefined {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return undefined
  }
  const parts = url.pathname.split('/').filter(Boolean)
  const after = (key: string): string | undefined => {
    const index = parts.indexOf(key)
    return index >= 0 ? parts[index + 1] : undefined
  }
  const baseId = after('base')
  const tableId = after('table')
  if (!baseId || !tableId) return undefined
  const tableIndex = parts.indexOf('table')
  return { baseURL: url.origin, baseId, tableId, viewId: parts[tableIndex + 2] }
}

async function request(
  config: TeableConfig,
  token: string,
  method: string,
  path: string,
  query: Record<string, string | string[]> = {},
  body?: unknown,
): Promise<unknown> {
  const url = new URL(apiBase(config) + path)
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item)
    else url.searchParams.set(key, value)
  }
  const response = await httpFetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  if (!response.ok) {
    let detail = text.slice(0, 300)
    try {
      detail = (JSON.parse(text) as { message?: string }).message ?? detail
    } catch {
      // Not JSON.
    }
    if (response.status === 401 || response.status === 403) {
      throw new TeaBranchError(t('Teable 拒绝了这个令牌（{status}）：{detail}', { status: response.status, detail }))
    }
    throw new TeaBranchError(t('Teable {method} {path} 失败（{status}）：{detail}', { method, path, status: response.status, detail }))
  }
  return text ? JSON.parse(text) : {}
}

export async function me(config: TeableConfig, token: string): Promise<TeableUser> {
  const user = (await request(config, token, 'GET', '/api/auth/user/me')) as Partial<TeableUser>
  if (!user.id) throw new TeaBranchError(t('Teable 返回的用户信息格式不对'))
  return { id: user.id, name: user.name ?? user.id, email: user.email, avatar: user.avatar ?? undefined }
}

const browsePaths: Record<Exclude<TeableLevel, 'base'>, (parentId: string) => string> = {
  space: () => '/api/space',
  table: (baseId) => `/api/base/${baseId}/table`,
  view: (tableId) => `/api/table/${tableId}/view`,
}

/**
 * One level of the hierarchy the issue table is picked from, as the token's user sees it. Bases
 * come from every space at once, grouped by space where the token may read space names.
 */
export async function browse(config: TeableConfig, token: string, level: TeableLevel, parentId = ''): Promise<TeableNode[]> {
  if (level === 'base') return bases(config, token)
  if (level !== 'space' && !parentId) return []
  const list = (await request(config, token, 'GET', browsePaths[level](parentId))) as {
    id: string
    name: string
    defaultViewId?: string
  }[]
  return list.map((node) => ({ id: node.id, name: node.name, defaultViewId: node.defaultViewId }))
}

async function bases(config: TeableConfig, token: string): Promise<TeableNode[]> {
  const list = (await request(config, token, 'GET', '/api/base/access/all')) as { id: string; name: string; spaceId: string }[]
  // Listing spaces needs a scope many tokens lack; without it the bases just aren't grouped.
  const spaces = new Map<string, string>()
  try {
    for (const space of (await request(config, token, 'GET', '/api/space')) as { id: string; name: string }[])
      spaces.set(space.id, space.name)
  } catch {
    // Ungrouped.
  }
  return list
    .map((base) => ({ id: base.id, name: base.name, group: spaces.get(base.spaceId) }))
    .sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.name.localeCompare(b.name))
}

export async function fields(config: TeableConfig, token: string): Promise<TeableField[]> {
  const query: Record<string, string> = config.viewId ? { viewId: config.viewId } : {}
  const list = (await request(config, token, 'GET', `/api/table/${config.tableId}/field`, query)) as {
    id: string
    name: string
    type?: string
    isPrimary?: boolean
    options?: { choices?: { name: string }[]; isMultiple?: boolean }
  }[]
  return list.map((field) => ({
    id: field.id,
    name: field.name,
    type: field.type ?? '',
    isPrimary: !!field.isPrimary,
    choices: field.options?.choices?.map((choice) => choice.name) ?? [],
    isMultiple: !!field.options?.isMultiple,
  }))
}

/** Fields that hold a person — what a "mine" filter matches against `Me`. */
export const isUserField = (field: TeableField): boolean =>
  field.type === 'user' || field.type === 'createdBy' || field.type === 'lastModifiedBy'

/** Records whose `field` contains the token's own user; `Me` is resolved by the server. */
export const mineFilter = (field: TeableField): unknown => ({
  conjunction: 'and',
  filterSet: [
    field.isMultiple ? { fieldId: field.id, operator: 'hasAnyOf', value: ['Me'] } : { fieldId: field.id, operator: 'is', value: 'Me' },
  ],
})

/**
 * Every record in the view, cells rendered as text. Personal access tokens are capped at 100
 * records per request, so this pages with `skip`.
 */
export async function records(
  config: TeableConfig,
  token: string,
  filter?: unknown,
  peopleFields: string[] = [],
  attachmentFields: string[] = [],
): Promise<TeableRecord[]> {
  const pageSize = 100
  const all: TeableRecord[] = []
  for (;;) {
    const query: Record<string, string> = {
      fieldKeyType: 'name',
      cellFormat: 'text',
      take: String(pageSize),
      skip: String(all.length),
    }
    if (config.viewId) query.viewId = config.viewId
    if (filter) query.filter = JSON.stringify(filter)
    const page = (await request(config, token, 'GET', `/api/table/${config.tableId}/record`, query)) as {
      records?: { id: string; autoNumber?: number; fields?: Record<string, unknown> }[]
    }
    const batch = page.records ?? []
    for (const record of batch) {
      const cells: Record<string, string> = {}
      for (const [name, value] of Object.entries(record.fields ?? {})) cells[name] = render(value)
      all.push({ id: record.id, autoNumber: record.autoNumber, fields: cells })
    }
    if (batch.length < pageSize || all.length >= 10_000) break
  }
  if (peopleFields.length || attachmentFields.length) {
    await attachRichCells(config, token, filter, peopleFields, attachmentFields, all)
  }
  return all
}

/**
 * Avatars for user cells and files for attachment cells. The text format renders a person as a
 * bare name and a file as "name (token)", so those columns — and only those, via `projection` —
 * are read a second time in JSON.
 */
async function attachRichCells(
  config: TeableConfig,
  token: string,
  filter: unknown,
  peopleFields: string[],
  attachmentFields: string[],
  into: TeableRecord[],
): Promise<void> {
  const byId = new Map(into.map((record) => [record.id, record]))
  const pageSize = 100
  for (let skip = 0; skip < into.length; skip += pageSize) {
    const query: Record<string, string | string[]> = {
      fieldKeyType: 'name',
      cellFormat: 'json',
      take: String(pageSize),
      skip: String(skip),
      projection: [...peopleFields, ...attachmentFields],
    }
    if (config.viewId) query.viewId = config.viewId
    if (filter) query.filter = JSON.stringify(filter)
    let page: { records?: { id: string; fields?: Record<string, unknown> }[] }
    try {
      page = (await request(config, token, 'GET', `/api/table/${config.tableId}/record`, query)) as typeof page
    } catch {
      return // Decoration; the list works without it.
    }
    for (const record of page.records ?? []) {
      const target = byId.get(record.id)
      if (!target) continue
      target.people = pick(record.fields, peopleFields, toPerson)
      target.attachments = pick(record.fields, attachmentFields, toAttachment)
    }
  }
}

function pick<T>(
  cells: Record<string, unknown> | undefined,
  names: string[],
  map: (item: Record<string, unknown>) => T,
): Record<string, T[]> {
  const result: Record<string, T[]> = {}
  for (const name of names) {
    const cell = cells?.[name]
    const list = (Array.isArray(cell) ? cell : cell ? [cell] : []) as Record<string, unknown>[]
    const items = list.filter((item) => item && typeof item === 'object').map(map)
    if (items.length) result[name] = items
  }
  return result
}

const toPerson = (item: Record<string, unknown>): Person => ({
  name: String(item.title ?? item.name ?? ''),
  email: typeof item.email === 'string' ? item.email : undefined,
  avatar: typeof item.avatarUrl === 'string' ? item.avatarUrl : undefined,
})

const toAttachment = (item: Record<string, unknown>): Attachment => ({
  name: String(item.name ?? 'file'),
  mimetype: String(item.mimetype ?? ''),
  size: Number(item.size ?? 0),
  url: typeof item.presignedUrl === 'string' ? item.presignedUrl : undefined,
  thumbnail:
    typeof item.lgThumbnailUrl === 'string'
      ? item.lgThumbnailUrl
      : typeof item.smThumbnailUrl === 'string'
        ? item.smThumbnailUrl
        : undefined,
  width: typeof item.width === 'number' ? item.width : undefined,
  height: typeof item.height === 'number' ? item.height : undefined,
})

export const isAttachmentField = (field: TeableField): boolean => field.type === 'attachment'

/** One record's attachment cells, fresh — the URLs in a list loaded an hour ago may have expired. */
export async function recordAttachments(
  config: TeableConfig,
  token: string,
  recordId: string,
  fieldNames: string[],
): Promise<Attachment[]> {
  if (!fieldNames.length) return []
  const record = (await request(config, token, 'GET', `/api/table/${config.tableId}/record/${recordId}`, {
    fieldKeyType: 'name',
    cellFormat: 'json',
    projection: fieldNames,
  })) as { fields?: Record<string, unknown> }
  return Object.values(pick(record.fields, fieldNames, toAttachment)).flat()
}

/** The record's comments, oldest first, with rich content flattened to text and image URLs. */
export async function comments(config: TeableConfig, token: string, recordId: string): Promise<IssueComment[]> {
  const page = (await request(config, token, 'GET', `/api/comment/${config.tableId}/${recordId}/list`, {
    take: '200',
    direction: 'forward',
  })) as { comments?: Record<string, unknown>[] }

  const result: IssueComment[] = []
  for (const comment of page.comments ?? []) {
    if (comment.deletedTime) continue
    const author = (comment.createdBy ?? {}) as { name?: string; avatar?: string }
    const lines: string[] = []
    const images: string[] = []
    for (const block of (comment.content ?? []) as Record<string, unknown>[]) {
      if (block.type === 'img') {
        const url = typeof block.url === 'string' ? block.url : await commentImageURL(config, token, recordId, String(block.path ?? ''))
        if (url) images.push(url)
        continue
      }
      const children = (block.children ?? []) as Record<string, unknown>[]
      lines.push(
        children
          .map((node) =>
            node.type === 'mention'
              ? `@${String(node.name ?? node.value ?? '')}`
              : node.type === 'a'
                ? `[${String(node.title ?? node.url)}](${String(node.url)})`
                : String(node.value ?? ''),
          )
          .join(''),
      )
    }
    result.push({
      id: String(comment.id),
      author: { name: author.name ?? '?', avatar: author.avatar ?? undefined },
      createdTime: Date.parse(String(comment.createdTime)) || 0,
      text: lines.join('\n').trim(),
      images,
    })
  }
  return result.sort((a, b) => a.createdTime - b.createdTime)
}

async function commentImageURL(config: TeableConfig, token: string, recordId: string, path: string): Promise<string | undefined> {
  if (!path) return undefined
  try {
    const url = await request(config, token, 'GET', `/api/comment/${config.tableId}/${recordId}/attachment/${encodeURIComponent(path)}`)
    return typeof url === 'string' ? url : undefined
  } catch {
    return undefined
  }
}

/** `cellFormat=text` already gives strings; this covers servers that ignore it. */
function render(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(render).join(', ')
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    return render(object.title ?? object.name ?? object.id ?? '')
  }
  return String(value)
}

/** Write cells by field name; `typecast` lets a plain string land in a select or URL field. */
export async function update(config: TeableConfig, token: string, recordId: string, cells: Record<string, unknown>): Promise<void> {
  await request(
    config,
    token,
    'PATCH',
    `/api/table/${config.tableId}/record/${recordId}`,
    {},
    {
      fieldKeyType: 'name',
      typecast: true,
      record: { fields: cells },
    },
  )
}
