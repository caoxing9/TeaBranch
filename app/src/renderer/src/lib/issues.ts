import type { Issue, TeableConfig, TeableField, TeableRecord } from '@shared/types'

/** Which columns hold the title, body, status and id — configured, else guessed from the schema. */
export interface Mapping {
  title?: string
  body?: string
  status?: string
  id?: string
}

function guess(fields: TeableField[], names: string[], types?: string[]): string | undefined {
  const candidates = types ? fields.filter((field) => types.includes(field.type)) : fields
  for (const name of names) {
    const hit = candidates.find((field) => field.name.toLowerCase() === name)
    if (hit) return hit.name
  }
  for (const name of names) {
    const hit = candidates.find((field) => field.name.toLowerCase().includes(name))
    if (hit) return hit.name
  }
  return undefined
}

export function mapping(config: TeableConfig, fields: TeableField[]): Mapping {
  const title = config.titleField ?? fields.find((field) => field.isPrimary)?.name ?? fields[0]?.name
  return {
    title,
    body:
      config.bodyField ??
      guess(fields, ['描述', '问题描述', '详情', '内容', 'description', 'detail', 'body']) ??
      fields.find((field) => field.type === 'longText' && field.name !== title)?.name,
    status: config.statusField ?? guess(fields, ['状态', 'status', 'state'], ['singleSelect']),
    // A column named like an issue id wins whatever its type — usually a formula such as
    // "T" & autoNumber, and that is the id people use in branch names and PR titles.
    id:
      config.idField ??
      fields.find((field) => ['issue id', 'issueid', 'issue_id', '编号', 'id'].includes(field.name.toLowerCase()))
        ?.name ??
      fields.find((field) => field.type === 'autoNumber')?.name,
  }
}

export function toIssue(record: TeableRecord, map: Mapping): Issue {
  const cell = (name?: string): string => (name ? (record.fields[name] ?? '') : '')
  return {
    id: record.id,
    record,
    title: cell(map.title) || '(无标题)',
    body: cell(map.body),
    status: cell(map.status) || undefined,
    key: cell(map.id) || (record.autoNumber ? `#${record.autoNumber}` : record.id),
  }
}

export const isUserField = (field: TeableField): boolean =>
  field.type === 'user' || field.type === 'createdBy' || field.type === 'lastModifiedBy'

export const assigneeGuess = (config: TeableConfig, fields: TeableField[]): string | undefined => {
  const people = fields.filter(isUserField)
  if (config.assigneeField) return people.find((field) => field.name === config.assigneeField)?.name
  return guess(people, ['负责人', '处理人', '指派', '经办人', '开发', 'assignee', 'owner', 'developer', 'dev']) ??
    people.find((field) => field.type === 'user')?.name
}

export const isApproved = (review: string): boolean => /VERDICT:\s*APPROVE/i.test(review)
