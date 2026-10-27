import type { PRCheck, PRChecks } from './types'

/**
 * A PR's checks as `gh pr view --json statusCheckRollup` reports them: Actions check runs and
 * commit statuses from other CI, folded into pass / fail / pending / skip.
 */
interface RollupItem {
  __typename?: string
  name?: string
  context?: string
  workflowName?: string
  status?: string
  conclusion?: string
  state?: string
  detailsUrl?: string
  targetUrl?: string
  description?: string
}

const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])

export function toCheck(item: RollupItem): PRCheck {
  const name = item.name || item.context || item.workflowName || '?'
  const link = item.detailsUrl || item.targetUrl || undefined
  const description = item.description || undefined
  // A commit status: one state, no separate conclusion.
  if (item.state && !item.status) {
    const bucket = item.state === 'SUCCESS' ? 'pass' : FAILED.has(item.state) ? 'fail' : 'pending'
    return { name, bucket, link, description }
  }
  if (item.status !== 'COMPLETED') return { name, bucket: 'pending', link, description }
  const conclusion = item.conclusion ?? ''
  const bucket = FAILED.has(conclusion) ? 'fail' : conclusion === 'SKIPPED' ? 'skip' : 'pass'
  return { name, bucket, link, description }
}

export function parseChecks(json: string): Omit<PRChecks, 'at'> | undefined {
  try {
    const data = JSON.parse(json) as { state?: string; headRefOid?: string; statusCheckRollup?: RollupItem[] }
    if (!data.headRefOid) return undefined
    return { sha: data.headRefOid, state: data.state ?? 'OPEN', checks: (data.statusCheckRollup ?? []).map(toCheck) }
  } catch {
    return undefined
  }
}

export const ciFailures = (ci: PRChecks): PRCheck[] => ci.checks.filter((check) => check.bucket === 'fail')
export const ciPending = (ci: PRChecks): boolean => ci.checks.some((check) => check.bucket === 'pending')
