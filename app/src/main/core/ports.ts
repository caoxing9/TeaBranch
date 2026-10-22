import { createServer } from 'node:net'
import { log } from './log'
import { run } from './shell'
import { sleep } from './spawn'

/** Whether we could bind the port on 127.0.0.1 right now. */
export function isAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close(() => resolve(true))
    })
  })
}

/**
 * Ports never handed to a worktree even when nothing holds them this second: a datastore that is
 * merely down would come back and collide. 5000/7000 are macOS AirPlay/Control Center.
 */
const reservedPorts = new Set([
  5000, 7000, 3306, 5432, 6379, 11211, 27017, 9200, 9300, 5672, 15672, 8080, 8443, 9000, 9090, 4000, 5173, 5174,
])

/** Below 1024 needs root; 49152+ is the kernel's ephemeral range. */
export const isReserved = (port: number): boolean => port < 1024 || port >= 49152 || reservedPorts.has(port)

/** First port at or after `start` that is free on the machine and unclaimed by us. */
export async function findAvailable(start: number, used: Set<number>): Promise<number> {
  for (let port = start; port < 65535; port++) {
    if (used.has(port) || isReserved(port)) continue
    if (await isAvailable(port)) return port
  }
  return start
}

const pids = (text: string): number[] =>
  text
    .split(/\s+/)
    .map((token) => Number.parseInt(token, 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0)

/** PIDs currently LISTENing on the port. */
export async function listeners(port: number): Promise<number[]> {
  const result = await run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])
  return pids(result.stdout)
}

export const isListening = async (port: number): Promise<boolean> => (await listeners(port)).length > 0

/** Every LISTENing port, from one `lsof` call — the reconcile loop's whole view of the machine. */
export async function allListening(): Promise<Set<number>> {
  const result = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'n'])
  const ports = new Set<number>()
  for (const line of result.stdout.split('\n')) {
    if (!line.startsWith('n')) continue
    const port = Number.parseInt(line.slice(line.lastIndexOf(':') + 1), 10)
    if (Number.isFinite(port)) ports.add(port)
  }
  return ports
}

/** Port → the PID holding it. How an adopted orphan is attributed to a process at all. */
export async function listenersByPort(): Promise<Map<number, number>> {
  const result = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn'])
  const map = new Map<number, number>()
  if (!result.ok) return map
  let currentPID: number | undefined
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('p')) currentPID = Number.parseInt(line.slice(1), 10)
    else if (line.startsWith('n') && currentPID) {
      const port = Number.parseInt(line.slice(line.lastIndexOf(':') + 1), 10)
      if (Number.isFinite(port) && !map.has(port)) map.set(port, currentPID)
    }
  }
  return map
}

const signal = (pid: number, sig: NodeJS.Signals): void => {
  try {
    process.kill(pid, sig)
  } catch {
    // Already gone.
  }
}

/** SIGKILL anything bound to the port — the last-resort cleanup path. */
export async function killPort(port: number): Promise<void> {
  const result = await run('lsof', ['-ti', `tcp:${port}`])
  for (const pid of pids(result.stdout)) signal(pid, 'SIGKILL')
}

async function waitForRelease(port: number, deadlineMs: number): Promise<number[]> {
  const end = Date.now() + deadlineMs
  while (Date.now() < end) {
    const holders = await listeners(port)
    if (holders.length === 0) return []
    await sleep(250)
  }
  return listeners(port)
}

/**
 * SIGTERM → wait → SIGKILL → wait, until nothing LISTENs on the port.
 *
 * Returns the PIDs that survived all of it; empty means free. "Stop" that silently leaves a server
 * up is the most confusing thing this app can do, so callers need the answer, not a fire-and-forget.
 */
export async function reclaim(port: number): Promise<number[]> {
  const holders = await listeners(port)
  if (holders.length === 0) return []

  log.info(`Port ${port} held by ${holders.join(',')}, sending SIGTERM`)
  holders.forEach((pid) => signal(pid, 'SIGTERM'))
  if ((await waitForRelease(port, 4000)).length === 0) return []

  const remaining = await listeners(port)
  if (remaining.length === 0) return []
  log.info(`Port ${port} still held by ${remaining.join(',')}, SIGKILL`)
  remaining.forEach((pid) => signal(pid, 'SIGKILL'))

  const survivors = await waitForRelease(port, 3000)
  if (survivors.length > 0) log.warn(`port ${port} still held by ${survivors.join(',')} after SIGKILL`)
  return survivors
}
