import { t } from './i18n'

/** What stands between a finished issue and deleting its worktree. */
export interface CleanupState {
  /** The branch's PR, when there is one: OPEN, MERGED or CLOSED. */
  prState?: string
  /** Commits on the branch that exist nowhere but this machine. */
  unpushed: number
  /** Files changed and not committed, new ones included; what git ignores doesn't count. */
  changed: number
  /** Checks that couldn't be made. Not knowing is reason enough to keep it. */
  unknown?: string[]
}

/**
 * Why the worktree can't go yet, one reason a line; empty when it can. Never deletes work that exists
 * only here: an open PR is still being reviewed, unpushed commits and edited files would be lost.
 */
export function cleanupBlockers(state: CleanupState): string[] {
  const blockers: string[] = []
  if (state.prState === 'OPEN') blockers.push(t('PR 还开着'))
  if (state.unpushed > 0) blockers.push(t('{n} 个提交还没推送', { n: state.unpushed }))
  if (state.changed > 0) blockers.push(t('{n} 个文件改了还没提交', { n: state.changed }))
  for (const check of state.unknown ?? []) blockers.push(t('没能检查 {check}', { check }))
  return blockers
}
