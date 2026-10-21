import type { NgrokTunnel } from '@shared/types'
import { state } from '../core/appState'
import * as envFile from '../core/envFile'
import { emit } from '../core/events'
import { log, TeaBranchError } from '../core/log'
import { ngrokLogs } from '../core/logStore'
import { run } from '../core/shell'
import { killGroup, spawnShell } from '../core/spawn'
import * as git from './git'

const key = 'ngrok'

/** `… msg="started tunnel" … url=https://abc.ngrok-free.app` → the URL. */
export function publicURLFromLog(line: string): string | undefined {
  if (!line.includes('started tunnel')) return undefined
  const match = / url=(\S+)/.exec(line)
  return match && /^https?:\/\//.test(match[1]) ? match[1] : undefined
}

/**
 * Tunnel a branch's SERVER_PORT and record the URL as its SANDBOX_TEABLE_ENDPOINT. One agent at a
 * time — the free plan allows no more — so whatever runs is retired first.
 */
export async function start(branch: string): Promise<NgrokTunnel> {
  const repo = state.projectPath
  if (!repo) throw new TeaBranchError('No project path set')
  if (state.ngrokPID) {
    killGroup(state.ngrokPID)
    state.ngrokPID = undefined
    state.ngrokTunnel = undefined
  }

  const worktree = await git.worktreePath(branch, repo)
  const port = envFile.port('SERVER_PORT', worktree)
  if (!port) throw new TeaBranchError('SERVER_PORT not found in worktree env file')

  ngrokLogs.clear(key)
  let deliver: (url: string) => void = () => undefined
  const urlArrived = new Promise<string>((resolve) => {
    deliver = resolve
  })
  const child = spawnShell(`ngrok http ${port} --log=stdout`, worktree, {}, (line) => {
    const url = publicURLFromLog(line)
    if (url) deliver(url)
    ngrokLogs.append(key, line)
  })
  void child.exited.then(() => log.info('ngrok exited'))

  const publicURL = await Promise.race([urlArrived, new Promise<null>((r) => setTimeout(() => r(null), 25_000))])
  if (!publicURL) {
    killGroup(child.pid)
    throw new TeaBranchError('Timed out waiting for ngrok tunnel')
  }

  try {
    envFile.writeOverrides({ SANDBOX_TEABLE_ENDPOINT: publicURL }, worktree)
  } catch (error) {
    log.warn(`tunnel started but failed to update env file: ${String(error)}`)
  }

  const tunnel = { branchName: branch, port, publicURL }
  state.ngrokPID = child.pid
  state.ngrokTunnel = tunnel
  emit('ngrokChanged', tunnel)
  return tunnel
}

export function stop(): void {
  if (state.ngrokPID) killGroup(state.ngrokPID)
  state.ngrokPID = undefined
  state.ngrokTunnel = undefined
  emit('ngrokChanged', null)
}

/** The agent API on :4040 is the source of truth: adopt a running tunnel, drop a vanished one. */
export async function reconcile(): Promise<void> {
  const response = await run('curl', ['-s', '--max-time', '2', 'http://127.0.0.1:4040/api/tunnels'])
  const clearStale = (): void => {
    if (!state.ngrokTunnel) return
    state.ngrokPID = undefined
    state.ngrokTunnel = undefined
    emit('ngrokChanged', null)
  }
  if (!response.ok || !response.stdout) return clearStale()

  let tunnels: { public_url?: string; config?: { addr?: string } }[]
  try {
    tunnels = JSON.parse(response.stdout).tunnels ?? []
  } catch {
    return
  }
  const tunnel = tunnels.find((t) => t.public_url?.startsWith('https')) ?? tunnels[0]
  if (!tunnel?.public_url) return clearStale()
  if (state.ngrokTunnel?.publicURL === tunnel.public_url) return

  const localPort = Number.parseInt(tunnel.config?.addr?.split(':').pop() ?? '0', 10) || 0
  const branch = state.projectPath ? ((await git.branchForServerPort(localPort, state.projectPath)) ?? '') : ''
  const pgrep = await run('pgrep', ['-x', 'ngrok'])
  state.ngrokPID = Number.parseInt(pgrep.out.split(/\s+/)[0] ?? '', 10) || undefined
  state.ngrokTunnel = { branchName: branch, port: localPort, publicURL: tunnel.public_url }
  emit('ngrokChanged', state.ngrokTunnel)
}
