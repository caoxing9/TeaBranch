import { Sys } from 'teabranch/native'
import { statSync } from '../node/fs'
import { join, resolve } from 'path'

/**
 * Where Claude Code keeps what it generates for a directory:
 * `/private/tmp/claude-<uid>/<cwd with / → ->/<session>/{scratchpad,tasks}`.
 */
export function scratchRoot(worktreePath: string): string | undefined {
  const slug = resolve(worktreePath).replace(/\//g, '-')
  const root = join('/private/tmp', `claude-${Sys.uid()}`, slug)
  try {
    return statSync(root).isDirectory() ? root : undefined
  } catch {
    return undefined
  }
}
