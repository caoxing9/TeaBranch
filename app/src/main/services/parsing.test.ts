import { describe, expect, it } from 'vitest'
import { parseWorktreeList } from './git'
import { parseElapsed, scriptName } from './processStats'
import { stripEnvPrefix } from './processManager'
import { publicURLFromLog } from './ngrok'

describe('parsing', () => {
  it('reads branch-backed worktrees and skips detached ones', () => {
    const out =
      'worktree /r\nHEAD a\nbranch refs/heads/develop\n\nworktree /r-wt/x\nHEAD b\ndetached\n\nworktree /r-wt/y\nbranch refs/heads/feat/y\n'
    expect(parseWorktreeList(out)).toEqual([
      { branch: 'develop', path: '/r' },
      { branch: 'feat/y', path: '/r-wt/y' },
    ])
  })

  it('strips env assignments in front of a script', () => {
    expect(stripEnvPrefix('SERVER_PORT=3003 SOCKET_PORT=3003 pnpm -r dev')).toBe('pnpm -r dev')
  })

  it('names node processes by their script', () => {
    expect(scriptName('node -r /x/register.js /app/backend-ee/dist/index.js')).toBe('index')
    expect(scriptName('/usr/bin/postgres -D /data')).toBe('postgres')
    expect(parseElapsed('1-02:03:04')).toBe(86400 + 7384)
    expect(parseElapsed('05:06')).toBe(306)
  })

  it('pulls the tunnel url out of ngrok logs', () => {
    expect(publicURLFromLog('t=1 msg="started tunnel" addr=http://localhost:5103 url=https://abc.ngrok-free.app')).toBe(
      'https://abc.ngrok-free.app',
    )
  })
})
