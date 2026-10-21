import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { databaseURL, entries, value, writeEntries, writeOverrides } from './envFile'

function worktree(contents: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tb-env-'))
  mkdirSync(join(dir, 'enterprise/app-ee'), { recursive: true })
  const file = join(dir, 'enterprise/app-ee/.env.development.local')
  writeFileSync(file, contents)
  return { dir, file }
}

describe('envFile', () => {
  it('resolves a repeated key to its last value', () => {
    const { dir } = worktree('A=1\nA=2\n')
    expect(entries(dir)).toEqual([{ key: 'A', value: '2' }])
  })

  it('rewrites only the deciding line and keeps everything else byte for byte', () => {
    const { dir, file } = worktree('# WORKTREE_SLOT=3\nA = keep\nB=1\nB=2\n# comment\n')
    writeEntries(
      [
        { key: 'A', value: 'keep' },
        { key: 'B', value: '9' },
        { key: 'C', value: 'new' },
      ],
      dir,
    )
    expect(readFileSync(file, 'utf8')).toBe('# WORKTREE_SLOT=3\nA = keep\nB=1\nB=9\n# comment\n\nC=new')
  })

  it('drops keys removed in the editor', () => {
    const { dir, file } = worktree('A=1\nB=2')
    writeEntries([{ key: 'B', value: '2' }], dir)
    expect(readFileSync(file, 'utf8')).toBe('B=2')
  })

  it('writes overrides in place and appends missing ones', () => {
    const { dir, file } = worktree('PORT=3100\nOTHER=x')
    writeOverrides({ PORT: '3200', SANDBOX_TEABLE_ENDPOINT: 'https://t.ngrok' }, dir)
    expect(readFileSync(file, 'utf8')).toBe('PORT=3200\nOTHER=x\nSANDBOX_TEABLE_ENDPOINT=https://t.ngrok')
    expect(value('PORT', dir)).toBe('3200')
  })

  it('does surgery on database urls', () => {
    const url = 'postgresql://u:p@h:5432/teable?schema=public'
    expect(databaseURL.nameOf(url)).toBe('teable')
    expect(databaseURL.replacingName(url, 'teable_x')).toBe('postgresql://u:p@h:5432/teable_x?schema=public')
    expect(databaseURL.forBranch('feat/my-thing')).toBe('teable_feat_my_thing')
  })
})

import { sanitize } from './logStore'

describe('log sanitize', () => {
  it('keeps colour but drops cursor control and carriage-return redraws', () => {
    expect(sanitize('\u001B[2K\u001B[1GProgress: resolved 10\rProgress: resolved 20')).toBe('Progress: resolved 20')
    expect(sanitize('\u001B[32mok\u001B[39m done')).toBe('\u001B[32mok\u001B[39m done')
    expect(sanitize('\u001B[?25lhidden cursor\u001B[?25h')).toBe('hidden cursor')
    expect(sanitize('\u001B]0;title\u0007text')).toBe('text')
  })
})
