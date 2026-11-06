import { emitSoon } from '../core/events'
import { state } from '../core/appState'
import { logs } from '../core/logStore'
import { git, run } from '../core/shell'
import type { CleanupState } from '../shared/cleanup'
import { t } from '../shared/i18n'
import * as browser from './browser'
import * as processManager from './processManager'
import * as worktrees from './worktree'

/** Taking a branch's worktree down: what's left in it, and removing it with everything it ran. */

/**
 * Where the branch stands against its PR and remote — what `cleanupBlockers` judges. A check that
 * fails is reported as unknown rather than read as "nothing there".
 */
export async function inspect(branch: string, cwd: string, prURL?: string): Promise<CleanupState> {
  const unknown: string[] = []
  // New files count: an agent's work isn't always `git add`ed yet. What git ignores never shows here.
  const status = await git(['status', '--porcelain', '--untracked-files=normal'], cwd)
  if (!status.ok) unknown.push('git status')
  const changed = status.ok ? status.out.split('\n').filter(Boolean).length : 0
  let prState: string | undefined
  let prHead: string | undefined
  if (prURL) {
    const view = await run('gh', ['pr', 'view', prURL, '--json', 'state,headRefOid'], { timeoutMs: 30_000 })
    try {
      if (!view.ok) throw new Error(view.stderr)
      const data = JSON.parse(view.out) as { state?: string; headRefOid?: string }
      prState = data.state
      prHead = data.headRefOid
    } catch {
      unknown.push('PR')
    }
  }
  const head = await git(['rev-parse', 'HEAD'], cwd)
  // The PR has exactly this commit: nothing is only here, even if its remote branch was deleted
  // after the merge.
  if (head.ok && prHead && head.out === prHead) return { prState, unpushed: 0, changed, unknown }
  const upstream = await git(['rev-list', '--count', '@{u}..HEAD'], cwd)
  const local = upstream.ok ? upstream : await git(['rev-list', '--count', `origin/${worktrees.baseBranch}..HEAD`], cwd)
  if (!local.ok) unknown.push(t('未推送的提交'))
  return { prState, unpushed: local.ok ? Number(local.out) || 0 : 0, changed, unknown }
}

/**
 * Stop the branch's servers, close its browser, remove its worktree — and with `deleteBranch`, the
 * local branch too. The caller has made sure nothing is lost by it.
 */
export async function removeWorktree(branch: string, repo: string, options: { deleteBranch?: boolean } = {}): Promise<void> {
  // Held across the whole delete, so `git worktree remove --force` never races a Start that is
  // still writing into the directory.
  await processManager.withBranchLock(branch, async () => {
    await processManager.stop(branch)
    await worktrees.remove(branch, repo)
    state.removeEnvironment(branch)
    logs.remove(branch)
    if (options.deleteBranch) await git(['branch', '-D', branch], repo)
  })
  browser.close(branch)
  emitSoon('branchesChanged')
}
