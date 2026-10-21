import { databaseURL } from '../core/envFile'
import { log, TeaBranchError } from '../core/log'
import { run } from '../core/shell'

/** Postgres provisioning through the `psql` CLI — whatever server the env file points at. */

/** The same server's `postgres` maintenance database, without query parameters. */
const adminURL = (url: string): string => databaseURL.replacingName(url, 'postgres').split('?')[0]

async function exists(name: string, admin: string): Promise<boolean> {
  const result = await run('psql', [admin, '-tAc', `SELECT 1 FROM pg_database WHERE datname = '${name}'`])
  return result.out === '1'
}

/**
 * Create `name` from `template` unless it exists. A template someone is connected to can't be
 * copied, so that degrades to an empty database instead of failing the whole worktree.
 */
export async function create(name: string, template: string, baseURL: string): Promise<string> {
  const admin = adminURL(baseURL)
  if (await exists(name, admin)) {
    log.info(`Database '${name}' already exists`)
    return databaseURL.replacingName(baseURL, name)
  }
  log.info(`Creating database '${name}' from template '${template}'`)
  const created = await run('psql', [admin, '-c', `CREATE DATABASE "${name}" TEMPLATE "${template}"`])
  if (!created.ok) {
    if (!created.stderr.includes('being accessed by other users')) {
      throw new TeaBranchError(`Failed to create database: ${created.stderr}`)
    }
    log.info(`Template db '${template}' in use, creating empty database '${name}'`)
    const empty = await run('psql', [admin, '-c', `CREATE DATABASE "${name}"`])
    if (!empty.ok) throw new TeaBranchError(`Failed to create database: ${empty.stderr}`)
  }
  return databaseURL.replacingName(baseURL, name)
}

/** Make sure the database a URL names exists, creating it empty if not. */
export async function ensureExists(url: string): Promise<string> {
  const name = databaseURL.nameOf(url)
  if (!name) throw new TeaBranchError('Cannot extract database name from URL')
  const admin = adminURL(url)
  if (await exists(name, admin)) return url
  log.info(`Database '${name}' does not exist, creating empty`)
  const created = await run('psql', [admin, '-c', `CREATE DATABASE "${name}"`])
  if (!created.ok) throw new TeaBranchError(`Failed to create database '${name}': ${created.stderr}`)
  return url
}
