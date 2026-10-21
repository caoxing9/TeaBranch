import type { Issue, Person, TeableConfig, TeableField } from '@shared/types'
import { assigneeGuess } from './issues'

/** Who an issue is about, assignee first: the faces worth showing on its card. */
export function issuePeople(issue: Issue, config: TeableConfig | null, fields: TeableField[]): Person[] {
  const people = issue.record.people ?? {}
  const assignee = config ? assigneeGuess(config, fields) : undefined
  const ordered = [...(assignee && people[assignee] ? [assignee] : []), ...Object.keys(people).filter((name) => name !== assignee)]
  return ordered.flatMap((name) => people[name] ?? [])
}

/** People by field name, for "提交人 X · 负责人 Y" lines. */
export const peopleByField = (issue: Issue): [string, Person[]][] => Object.entries(issue.record.people ?? {})
