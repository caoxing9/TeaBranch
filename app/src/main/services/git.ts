import { t } from '@shared/i18n'
import { readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { Branch, BranchEnvironment, WorktreeDbInfo } from '@shared/types'
import * as envFile from '../core/envFile'
import { TeaBranchError } from '../core/log'
import { git } from '../core/shell'

export interface WorktreeEntry {
  branch: string
  path: string
}

/** `git worktree list --porcelain`, branch-backed worktrees only. */
export function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let path: string | undefined
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    else if (line.startsWith('branch ') && path) {
      const ref = line.slice('branch '.length)
      entries.push({ branch: ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref, path })
    } else if (line === '') path = undefined
  }
  return entries
}

export async function worktrees(repo: string): Promise<WorktreeEntry[]> {
  const result = await git(['worktree', 'list', '--porcelain'], repo)
  return result.ok ? parseWorktreeList(result.stdout) : []
}

export async function currentBranch(repo: string): Promise<string | undefined> {
  const result = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repo)
  return result.ok && result.out ? result.out : undefined
}

/** One per worktree, current first, then natural order. */
export async function branches(repo: string, environments: Record<string, BranchEnvironment>): Promise<Branch[]> {
  const result = await git(['worktree', 'list', '--porcelain'], repo)
  if (!result.ok) throw new TeaBranchError(t('git worktree list 失败：{error}', { error: result.stderr.trim() }))
  const head = await currentBranch(repo)
  return parseWorktreeList(result.stdout)
    .map((entry) => ({
      name: entry.branch,
      isCurrent: entry.branch === head,
      environment: environments[entry.branch],
      managed: isManaged(entry.path, repo),
      worktreePath: entry.path,
    }))
    .sort((a, b) => (a.isCurrent !== b.isCurrent ? (a.isCurrent ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true })))
}

/** Where a branch's worktree lives; the repo itself when the branch is the main checkout's HEAD. */
export async function worktreePath(branch: string, repo: string): Promise<string> {
  const entry = (await worktrees(repo)).find((candidate) => candidate.branch === branch)
  if (entry) return entry.path
  if ((await currentBranch(repo)) === branch) return repo
  throw new TeaBranchError(t('分支 {branch} 没有 worktree，先用 `git worktree add` 创建一个。', { branch }))
}

/** Memoised: the answer is fixed at creation time, and branch refreshes ask it constantly. */
const managedCache = new Map<string, boolean>()

export const forgetManaged = (worktree: string): void => void managedCache.delete(resolve(worktree))

/** Under `<repo>-worktree/`, or carrying the marker written at creation. */
export function isManaged(worktree: string, repo: string): boolean {
  const key = resolve(worktree)
  const cached = managedCache.get(key)
  if (cached !== undefined) return cached
  const base = join(dirname(repo), `${basename(repo)}-worktree`)
  let managed = key === base || key.startsWith(`${base}/`)
  if (!managed) {
    for (const relative of ['enterprise/app-ee/.env.development.local', '.env.development.local']) {
      try {
        const contents = readFileSync(join(worktree, relative), 'utf8')
        if (contents.includes('# WORKTREE_SLOT=') || contents.includes('# ---- BranchPilot overrides ----')) {
          managed = true
          break
        }
      } catch {
        // No such file.
      }
    }
  }
  managedCache.set(key, managed)
  return managed
}

/** Database and Redis of every worktree, for the "reuse / clone from" pickers. */
export async function worktreeDbInfo(repo: string): Promise<WorktreeDbInfo[]> {
  return (await worktrees(repo)).map((entry) => {
    const url = envFile.baseDatabaseURL(entry.path)
    return {
      branchName: entry.branch,
      databaseName: url ? envFile.databaseURL.nameOf(url) : undefined,
      databaseURL: url,
      redisURI: envFile.value('BACKEND_CACHE_REDIS_URI', entry.path),
    }
  })
}

/** Map a forwarded local port back to a branch via its SERVER_PORT. */
export async function branchForServerPort(port: number, repo: string): Promise<string | undefined> {
  if (!port) return undefined
  return (await worktrees(repo)).find((entry) => envFile.port('SERVER_PORT', entry.path) === port)?.branch
}
