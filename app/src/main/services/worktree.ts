import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { DbMode, WorktreeDbInfo, WorktreeProgress } from '@shared/types'
import * as envFile from '../core/envFile'
import { log, TeaBranchError } from '../core/log'
import { logs } from '../core/logStore'
import { isAvailable, isReserved } from '../core/ports'
import { git } from '../core/shell'
import { isCleanExit, spawnShell } from '../core/spawn'
import * as database from './database'
import * as gitService from './git'

/**
 * Teable's integration branch. Hard-coded on purpose: a worktree cut from anywhere else would not
 * match the schema of the database this app provisions.
 */
export const baseBranch = 'develop'

export const worktreeBase = (repo: string): string => join(dirname(repo), `${basename(repo)}-worktree`)

export const worktreeDirectory = (branch: string, repo: string): string => join(worktreeBase(repo), branch.replace(/\//g, '-'))

/** Run a command to completion, its output streamed into the branch's log as it arrives. */
async function runLogged(command: string, cwd: string, branch: string): Promise<boolean> {
  const child = spawnShell(command, cwd, {}, (line) => logs.append(branch, `[dev] ${line}`))
  return isCleanExit(await child.exited)
}

async function sourceInfo(branch: string, repo: string): Promise<WorktreeDbInfo> {
  const info = (await gitService.worktreeDbInfo(repo)).find((candidate) => candidate.branchName === branch)
  if (!info) throw new TeaBranchError(`Source branch '${branch}' not found or has no worktree`)
  return info
}

/**
 * The `wt` shell workflow, in code: fetch develop → add worktree → env file with an isolated port
 * block, database and Redis index → install → provision and migrate.
 *
 * An existing directory is returned as is — callers that know a previous attempt was cut short
 * remove it first.
 */
export async function create(
  branch: string,
  repo: string,
  dbMode: DbMode,
  progress: (progress: WorktreeProgress) => void,
): Promise<string> {
  const worktree = worktreeDirectory(branch, repo)
  if (existsSync(worktree)) return worktree
  mkdirSync(worktreeBase(repo), { recursive: true })
  const step = (name: string, message: string, done = false): void => {
    progress({ step: name, message, done })
    logs.append(branch, `[dev] \u001B[36m▸\u001B[0m ${message}`)
  }

  step('fetch', `Fetching origin/${baseBranch}...`)
  const fetch = await git(['fetch', 'origin', baseBranch], repo)
  if (!fetch.ok) throw new TeaBranchError(`git fetch failed: ${fetch.stderr}`)

  step('branch', `Creating branch ${branch}...`)
  const add = await git(['worktree', 'add', '-b', branch, worktree, `origin/${baseBranch}`, '--no-track'], repo)
  if (!add.ok) {
    if (!add.stderr.includes('already exists')) throw new TeaBranchError(`git worktree add failed: ${add.stderr}`)
    // The branch is already there — check it out into the worktree as is.
    const retry = await git(['worktree', 'add', worktree, branch], repo)
    if (!retry.ok) throw new TeaBranchError(`git worktree add failed: ${retry.stderr}`)
  }

  step('env', 'Setting up environment...')
  gitService.forgetManaged(worktree)
  const slot = await assignSlot(repo)
  const branchDbName = envFile.databaseURL.forBranch(branch)

  let databaseURLOverride: string | undefined
  let redisURIOverride: string | undefined
  if (dbMode.kind === 'reuse') {
    const source = await sourceInfo(dbMode.sourceBranch, repo)
    databaseURLOverride = source.databaseURL
    redisURIOverride = source.redisURI
  }
  const envDatabaseName = (databaseURLOverride && envFile.databaseURL.nameOf(databaseURLOverride)) || branchDbName
  writeEnvFile(repo, worktree, slot, envDatabaseName, databaseURLOverride, redisURIOverride)

  step('install', 'Installing dependencies (pnpm install)...')
  if (!(await runLogged('pnpm install', worktree, branch))) {
    throw new TeaBranchError('pnpm install failed — see the branch log for details')
  }

  if (dbMode.kind === 'reuse') {
    step('database', 'Reusing existing database (no creation needed)')
  } else {
    step('database', 'Setting up database...')
    const baseURL = envFile.baseDatabaseURL(repo)
    if (baseURL) {
      const template =
        dbMode.kind === 'clone'
          ? ((await sourceInfo(dbMode.sourceBranch, repo)).databaseName ?? 'teable')
          : (envFile.databaseURL.nameOf(baseURL) ?? 'teable')
      try {
        const url = await database.create(branchDbName, template, baseURL)
        log.info(`Created database '${branchDbName}' from template '${template}': ${url}`)
      } catch (error) {
        // Non-fatal: the migration below may still bring the database up.
        log.warn(`database creation failed: ${String(error)}. Will try migration anyway.`)
      }
    }
  }

  // Prisma client + migrations. Always: the client lives in node_modules, and `migrate deploy` is
  // idempotent, so this is safe even when reusing a database.
  step('migrate', 'Running database migration (make postgres.mode)...')
  if (!(await runLogged('make postgres.mode', worktree, branch))) log.warn('migration may have failed')

  step('done', 'Worktree ready!', true)
  return worktree
}

/**
 * Pick a free slot, which fixes a worktree's port block at 3000 + slot*100.
 *
 * Only real port values count, never the `# WORKTREE_SLOT` markers — the two drift apart when a
 * derived port was taken, and trusting the marker hands one port to two worktrees. Scans up from
 * slot 1 so gaps left by deleted worktrees are reused instead of the block creeping upward forever.
 */
export async function assignSlot(repo: string): Promise<number> {
  const used = new Set<number>()
  const directories = [repo]
  try {
    for (const name of readdirSync(worktreeBase(repo))) {
      const path = join(worktreeBase(repo), name)
      if (statSync(path).isDirectory()) directories.push(path)
    }
  } catch {
    // No worktrees yet.
  }
  for (const directory of directories) {
    let contents: string
    try {
      contents = readFileSync(join(directory, 'enterprise/app-ee/.env.development.local'), 'utf8')
    } catch {
      continue
    }
    for (const raw of contents.split('\n')) {
      const line = raw.trim()
      for (const key of ['PORT=', 'SOCKET_PORT=', 'SERVER_PORT=']) {
        if (!line.startsWith(key)) continue
        const port = Number.parseInt(line.slice(key.length).trim(), 10)
        if (Number.isFinite(port)) used.add(port)
      }
    }
  }

  for (let slot = 1; ; slot++) {
    const port = 3000 + slot * 100
    const companion = port + 3
    if (companion > 65535) return slot
    const collides =
      used.has(port) ||
      used.has(companion) ||
      isReserved(port) ||
      isReserved(companion) ||
      !(await isAvailable(port)) ||
      !(await isAvailable(companion))
    if (!collides) return slot
  }
}

/** Copy the main repo's env file, drop the keys we own, append our block. */
function writeEnvFile(
  repo: string,
  worktree: string,
  slot: number,
  databaseName: string,
  databaseURLOverride: string | undefined,
  redisURIOverride: string | undefined,
): void {
  const port = 3000 + slot * 100
  const serverPort = port + 3

  let baseContents = ''
  for (const relative of ['enterprise/app-ee/.env.development.local', 'enterprise/app-ee/.env.development']) {
    try {
      baseContents = readFileSync(join(repo, relative), 'utf8')
      break
    } catch {
      // Try the next one.
    }
  }

  const lines = [`# WORKTREE_SLOT=${slot}`]
  for (const raw of baseContents.split('\n')) {
    const trimmed = raw.trim()
    if (trimmed.startsWith('# WORKTREE_SLOT=')) continue
    if (envFile.managedKeys.some((key) => trimmed.startsWith(`${key}=`))) continue
    lines.push(raw)
  }

  const databaseURL =
    databaseURLOverride ??
    envFile.databaseURL.replacingName(
      envFile.baseDatabaseURL(repo) ?? `postgresql://teable:teable@127.0.0.1:5432/${databaseName}?schema=public&statement_cache_size=1`,
      databaseName,
    )
  const redisURI = redisURIOverride ?? `redis://:teable@127.0.0.1:6379/${slot}`

  lines.push(
    '',
    '# ---- BranchPilot overrides ----',
    `PORT=${port}`,
    `SOCKET_PORT=${serverPort}`,
    `SERVER_PORT=${serverPort}`,
    `PUBLIC_ORIGIN=http://127.0.0.1:${port}`,
    `STORAGE_PREFIX=http://127.0.0.1:${port}`,
    `PRISMA_DATABASE_URL=${databaseURL}`,
    'PUBLIC_DATABASE_PROXY=127.0.0.1:5432',
    `BACKEND_CACHE_REDIS_URI=${redisURI}`,
    // Sandbox agents call back into this worktree's frontend from inside Docker, so the endpoint
    // must track the slot's PORT — a value copied from the main repo points at the wrong stack.
    `SANDBOX_TEABLE_ENDPOINT=http://host.docker.internal:${port}`,
  )

  const target = join(worktree, 'enterprise/app-ee/.env.development.local')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, lines.join('\n'))
}

export async function remove(branch: string, repo: string): Promise<void> {
  const safeName = branch.replace(/\//g, '-')
  const candidates = [join(worktreeBase(repo), safeName), join(repo, '.worktrees', safeName)]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    gitService.forgetManaged(path)
    const result = await git(['worktree', 'remove', '--force', path], repo)
    if (result.ok) return
    // The directory is there but git no longer tracks it.
    if (result.stderr.includes('is not a working tree')) {
      rmSync(path, { recursive: true, force: true })
      return
    }
    throw new TeaBranchError(`git worktree remove failed: ${result.stderr}`)
  }
  // Created by hand elsewhere: ask git where it lives.
  const entry = (await gitService.worktrees(repo)).find((candidate) => candidate.branch === branch)
  if (entry) {
    const result = await git(['worktree', 'remove', '--force', entry.path], repo)
    if (!result.ok) throw new TeaBranchError(`git worktree remove failed: ${result.stderr}`)
  }
}
