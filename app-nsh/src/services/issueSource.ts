import type { Issue, TeableField, TeableRecord, TeableUser } from '../shared/types'
import { t } from '../shared/i18n'
import { assigneeGuess, mapping, toIssue } from '../shared/issues'
import { TeaBranchError } from '../core/log'
import { loadTeableConfig } from '../core/settingsStore'
import * as teable from './teable'
import { accessToken } from './teableAuth'

/**
 * The issue table as the main process reads it — for the list in the window and for autopilot, which
 * has to keep going with no window open.
 */

async function token(): Promise<string> {
  const value = await accessToken()
  if (!value) throw new TeaBranchError(t('未登录 Teable'))
  return value
}

export async function loadTable(): Promise<{ fields: TeableField[]; records: TeableRecord[] }> {
  const config = loadTeableConfig()
  if (!config.tableId) return { fields: [], records: [] }
  const auth = await token()
  const fields = await teable.fields(config, auth)
  // Filtered server-side: someone else's issues never reach this machine, so auto mode can't
  // pick one up either.
  let filter: unknown
  if (config.onlyMine) {
    const assignee = fields.find((field) => field.name === assigneeGuess(config, fields))
    if (!assignee) throw new TeaBranchError(t('“只看我的”需要一个人员字段 — 在 Issue 设置里选“负责人”字段'))
    filter = teable.mineFilter(assignee)
  }
  const peopleFields = fields.filter(teable.isUserField).map((field) => field.name)
  const attachmentFields = fields.filter(teable.isAttachmentField).map((field) => field.name)
  return { fields, records: await teable.records(config, auth, filter, peopleFields, attachmentFields) }
}

export async function loadIssues(): Promise<Issue[]> {
  const { fields, records } = await loadTable()
  const map = mapping(loadTeableConfig(), fields)
  return records.map((record) => toIssue(record, map))
}

let me: TeableUser | undefined

/** Put an issue in the first status auto mode fixes — where a bug found by a probe belongs. */
export async function setFixStatus(recordId: string): Promise<void> {
  const config = loadTeableConfig()
  const auth = await token()
  const map = mapping(config, await teable.fields(config, auth))
  if (map.status && config.fixStatuses[0]) await teable.update(config, auth, recordId, { [map.status]: config.fixStatuses[0] })
}

/**
 * A new issue in the table, for work that arrived somewhere else — a chat, a probe that found a bug.
 * Assigned to you, so "only mine" still lists it; a bug in the first status auto mode fixes.
 */
export async function createIssue(
  title: string,
  body: string,
  options: { fixStatus?: boolean } = {},
): Promise<{ issue: Issue; bodyField?: string }> {
  const config = loadTeableConfig()
  if (!config.tableId) throw new TeaBranchError(t('还没有选 Issue 表'))
  const auth = await token()
  const fields = await teable.fields(config, auth)
  const map = mapping(config, fields)
  if (!map.title) throw new TeaBranchError(t('Issue 表里找不到标题字段'))
  const cells: Record<string, unknown> = { [map.title]: title }
  if (map.body) cells[map.body] = body
  // A bug goes in where auto mode picks it up; a request is left for you to put somewhere.
  if (options.fixStatus !== false && map.status && config.fixStatuses[0]) cells[map.status] = config.fixStatuses[0]
  const assignee = fields.find((field) => field.name === assigneeGuess(config, fields) && field.type === 'user')
  if (assignee) {
    me ??= await teable.me(config, auth).catch(() => undefined)
    if (me) cells[assignee.name] = assignee.isMultiple ? [{ id: me.id, title: me.name }] : { id: me.id, title: me.name }
  }
  return { issue: toIssue(await teable.create(config, auth, cells), map), bodyField: map.body }
}
