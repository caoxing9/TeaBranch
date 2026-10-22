import { t } from '@shared/i18n'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TeaBranchError } from './log'

/** Search order for a plain read — the most specific file wins. */
const searchPaths = [
  'enterprise/app-ee/.env.development.local',
  '.env.development.local',
  'enterprise/app-ee/.env.local',
  '.env.local',
  'enterprise/app-ee/.env.development',
  '.env.development',
  'enterprise/app-ee/.env',
  '.env',
]

/** The files TeaBranch writes to; the first that exists wins. */
const writablePaths = ['enterprise/app-ee/.env.development.local', '.env.development.local']

/** The keys TeaBranch owns in a worktree's env file. */
export const managedKeys = [
  'PORT',
  'SOCKET_PORT',
  'SERVER_PORT',
  'PUBLIC_ORIGIN',
  'STORAGE_PREFIX',
  'PRISMA_DATABASE_URL',
  'PUBLIC_DATABASE_PROXY',
  'BACKEND_CACHE_REDIS_URI',
  'SANDBOX_TEABLE_ENDPOINT',
]

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

export function value(key: string, worktree: string): string | undefined {
  const prefix = `${key}=`
  for (const relative of searchPaths) {
    const contents = readText(join(worktree, relative))
    if (contents === undefined) continue
    for (const raw of contents.split('\n')) {
      const line = raw.trim()
      if (line.startsWith('#') || !line.includes('=')) continue
      if (line.startsWith(prefix)) return line.slice(prefix.length)
    }
  }
  return undefined
}

export function port(key: string, worktree: string): number | undefined {
  const raw = value(key, worktree)?.trim()
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : undefined
}

export const baseDatabaseURL = (worktree: string): string | undefined => value('PRISMA_DATABASE_URL', worktree)

export const writableFile = (worktree: string): string | undefined =>
  writablePaths.map((relative) => join(worktree, relative)).find((path) => existsSync(path))

/** Split a line into `[key, value]`, both trimmed — `FOO = bar` and `FOO=bar` are one variable. */
function parseAssignment(raw: string): [string, string] | undefined {
  const line = raw.trim()
  if (line.startsWith('#')) return undefined
  const equals = line.indexOf('=')
  if (equals < 0) return undefined
  const key = line.slice(0, equals).trim()
  return key ? [key, line.slice(equals + 1).trim()] : undefined
}

/**
 * Every assignment in the worktree's own env file, in file order. A repeated key resolves to its
 * last value — dotenv builds an object, so later lines win.
 */
export function entries(worktree: string): { key: string; value: string }[] {
  const target = writableFile(worktree)
  const contents = target ? readText(target) : undefined
  if (contents === undefined) return []
  const values = new Map<string, string>()
  for (const raw of contents.split('\n')) {
    const parsed = parseAssignment(raw)
    if (parsed) values.set(parsed[0], parsed[1])
  }
  return [...values].map(([key, value]) => ({ key, value }))
}

/**
 * Write entries back conservatively: unchanged lines byte for byte, only the line that *decides*
 * a value is rewritten, comments and the `# WORKTREE_SLOT=` marker survive — the file is usually
 * under version control, and the slot marker is what port allocation reads.
 */
export function writeEntries(updated: { key: string; value: string }[], worktree: string): void {
  const target = writableFile(worktree)
  if (!target) throw new TeaBranchError(t('worktree 里没有 .env.development.local'))
  const lines = readFileSync(target, 'utf8').split('\n')
  const values = new Map(updated.map((entry) => [entry.key, entry.value]))

  const decidingLine = new Map<string, number>()
  lines.forEach((line, index) => {
    const parsed = parseAssignment(line)
    if (parsed) decidingLine.set(parsed[0], index)
  })

  const output: string[] = []
  const seen = new Set<string>()
  lines.forEach((line, index) => {
    const parsed = parseAssignment(line)
    if (!parsed) {
      output.push(line)
      return
    }
    const [key, existing] = parsed
    const next = values.get(key)
    if (next === undefined) return // removed in the editor
    seen.add(key)
    output.push(decidingLine.get(key) === index && existing !== next ? `${key}=${next}` : line)
  })
  for (const entry of updated) if (!seen.has(entry.key)) output.push(`${entry.key}=${entry.value}`)
  writeFileSync(target, output.join('\n'))
}

/** Rewrite owned keys in place, appending any that were missing. Every other line is preserved. */
export function writeOverrides(overrides: Record<string, string>, worktree: string): void {
  const target = writableFile(worktree)
  if (!target) throw new TeaBranchError(t('worktree 里没有 .env.development.local'))
  const replaced = new Set<string>()
  const output = readFileSync(target, 'utf8')
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      const key = managedKeys.find((candidate) => trimmed.startsWith(`${candidate}=`))
      if (key && overrides[key] !== undefined) {
        replaced.add(key)
        return `${key}=${overrides[key]}`
      }
      return line
    })
  for (const [key, val] of Object.entries(overrides)) if (!replaced.has(key)) output.push(`${key}=${val}`)
  writeFileSync(target, output.join('\n'))
}

/** PostgreSQL URL surgery — the app rewrites the database name in a connection string a lot. */
export const databaseURL = {
  /** `postgresql://u:p@h:5432/teable?schema=public` → `…/<name>?schema=public` */
  replacingName(url: string, name: string): string {
    const scheme = url.lastIndexOf('://')
    if (scheme < 0) return url
    const pathStart = url.indexOf('/', scheme + 3)
    if (pathStart < 0) return url
    const query = url.indexOf('?', pathStart)
    return url.slice(0, pathStart + 1) + name + (query >= 0 ? url.slice(query) : '')
  },

  nameOf(url: string): string | undefined {
    const scheme = url.lastIndexOf('://')
    if (scheme < 0) return undefined
    const pathStart = url.indexOf('/', scheme + 3)
    if (pathStart < 0) return undefined
    const query = url.indexOf('?', pathStart)
    const name = url.slice(pathStart + 1, query >= 0 ? query : undefined)
    return name || undefined
  },

  /** `feat/my-thing` → `teable_feat_my_thing` */
  forBranch: (branch: string): string => `teable_${branch.replace(/\//g, '_').replace(/-/g, '_').toLowerCase()}`,
}
