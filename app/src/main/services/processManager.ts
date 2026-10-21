import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isLive } from '@shared/types'
import { state } from '../core/appState'
import * as envFile from '../core/envFile'
import { emitSoon } from '../core/events'
import { errorMessage, log, TeaBranchError } from '../core/log'
import { logs } from '../core/logStore'
import { KeyedMutex, Mutex } from '../core/mutex'
import * as ports from '../core/ports'
import { exitDescription, groupAlive, isCleanExit, signalGroup, sleep, spawnShell } from '../core/spawn'
import * as database from './database'
import * as git from './git'
import * as ngrok from './ngrok'

/** One dev process to start, with the port it should serve. */
interface StartCommand {
  label: string
  command: string
  port: number
  environment: Record<string, string>
}

/**
 * Start/stop run concurrently across branches and serially within one: a Delete's
 * `git worktree remove --force` must never run alongside the same branch's `pnpm install`.
 */
const branchLocks = new KeyedMutex()
/** Held across "read the ports in use → claim ours", so two starts can't pick the same port. */
const allocationLock = new Mutex()

export const withBranchLock = <T>(branch: string, body: () => Promise<T>): Promise<T> => branchLocks.run(branch, body)

/** Say what a start is doing in the branch's own log — a four-minute start must not look hung. */
const note = (branch: string, message: string): void => logs.append(branch, `[dev] \u001B[36m▸\u001B[0m ${message}`)

// MARK: - Start

export const start = (branch: string): Promise<void> => withBranchLock(branch, () => performStart(branch))

async function performStart(branch: string): Promise<void> {
  const repo = state.projectPath
  if (!repo) throw new TeaBranchError('No project path set')
  if (isLive(state.environment(branch)?.status ?? 'stopped')) throw new TeaBranchError('Branch is already running')

  const worktree = await git.worktreePath(branch, repo)

  // Ports from the worktree's own env file when it has them — that file is the contract the dev
  // servers read. Allocation is only the fallback, and it happens under the lock.
  const allocated = await allocationLock.run(async () => {
    if (isLive(state.environment(branch)?.status ?? 'stopped')) throw new TeaBranchError('Branch is already running')
    const used = state.portsInUse()
    const backendPort = envFile.port('SERVER_PORT', worktree) ?? (await ports.findAvailable(state.settings.basePort, used))
    used.add(backendPort)
    const socketPort = envFile.port('SOCKET_PORT', worktree) ?? (await ports.findAvailable(backendPort + 1, used))
    used.add(socketPort)
    const frontendPort = envFile.port('PORT', worktree) ?? (await ports.findAvailable(socketPort + 1, used))
    const url = envFile.baseDatabaseURL(worktree)
    state.setEnvironment({
      branchName: branch,
      worktreePath: worktree,
      port: frontendPort,
      backendPort,
      socketPort,
      status: 'building',
      databaseName: (url && envFile.databaseURL.nameOf(url)) || envFile.databaseURL.forBranch(branch),
    })
    return { backendPort, socketPort, frontendPort }
  })

  log.info(
    `start_branch: branch=${branch}, worktree=${worktree}, backend=${allocated.backendPort}, socket=${allocated.socketPort}, frontend=${allocated.frontendPort}`,
  )
  emitSoon('branchesChanged')

  try {
    await startService(branch, worktree, allocated.backendPort, allocated.socketPort, allocated.frontendPort)
  } catch (error) {
    state.mutateEnvironment(branch, (environment) => {
      environment.status = 'error'
    })
    emitSoon('branchesChanged')
    throw error
  }
}

async function startService(
  branch: string,
  worktree: string,
  backendPort: number,
  socketPort: number,
  frontendPort: number,
): Promise<void> {
  note(branch, `Starting ${branch}`)

  // A stale Next.js dev lock makes the next boot bail with "is another instance running?".
  for (const relative of ['enterprise/app-ee/.next/dev/lock', '.next/dev/lock']) {
    const lock = join(worktree, relative)
    if (existsSync(lock)) {
      log.info(`Removing stale Next.js lock: ${lock}`)
      rmSync(lock, { force: true })
    }
  }

  // Reclaim our ports from zombies of a previous run before anything tries to bind.
  for (const port of [backendPort, socketPort, frontendPort]) {
    if (await ports.isListening(port)) note(branch, `Port ${port} is still held — reclaiming it`)
    await ports.reclaim(port)
  }

  await ensureDependencies(worktree, branch)

  const shared: Record<string, string> = {}
  const envURL = envFile.baseDatabaseURL(worktree)
  if (envURL) {
    note(branch, 'Checking database')
    try {
      shared.PRISMA_DATABASE_URL = await database.ensureExists(envURL)
    } catch (error) {
      log.warn(`database check failed: ${errorMessage(error)}. Using env URL.`)
      shared.PRISMA_DATABASE_URL = envURL
    }
  }
  const redis = envFile.value('BACKEND_CACHE_REDIS_URI', worktree)
  if (redis) shared.BACKEND_CACHE_REDIS_URI = redis

  const commands = detectStartCommands(worktree, backendPort, socketPort, frontendPort).map((command) => ({
    ...command,
    environment: { ...command.environment, ...shared },
  }))

  for (const command of commands) {
    note(branch, `Launching ${command.label} on port ${command.port}`)
    spawnCommand(command, branch, worktree)
  }
  note(branch, 'Waiting for the first output…')

  state.mutateEnvironment(branch, (environment) => {
    environment.status = 'running'
  })
  startWatchdog(branch, worktree, commands, state.bumpWatchdogGeneration(branch))
  emitSoon('branchesChanged')
}

// MARK: - Command detection

/** Teable splits its dev server into `dev:backend:swc` + `dev:frontend`; anything else runs `dev`. */
export function detectStartCommands(
  worktree: string,
  backendPort: number,
  socketPort: number,
  frontendPort: number,
): StartCommand[] {
  const fallback: StartCommand = {
    label: 'dev',
    command: 'npm run dev',
    port: frontendPort,
    environment: { PORT: String(frontendPort) },
  }
  let scripts: Record<string, string>
  try {
    scripts = JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8')).scripts ?? {}
  } catch {
    return [fallback]
  }

  const backendScript = scripts['dev:backend:swc']
  const frontendScript = scripts['dev:frontend']
  if (backendScript && frontendScript) {
    // Ports go in as *process* env as well as via the env file: Next.js reads the dev server port
    // from the process before it loads .env.
    const portEnv = { SERVER_PORT: String(backendPort), SOCKET_PORT: String(socketPort) }
    return [
      { label: 'backend', command: stripEnvPrefix(backendScript), port: backendPort, environment: portEnv },
      {
        label: 'frontend',
        command: stripEnvPrefix(frontendScript),
        port: frontendPort,
        environment: { ...portEnv, PORT: String(frontendPort) },
      },
    ]
  }

  const script = scripts.dev ? 'dev' : scripts.start ? 'start' : 'dev'
  return [{ ...fallback, command: `${detectPackageManager(worktree)} run ${script}` }]
}

/** `SERVER_PORT=3003 SOCKET_PORT=3003 pnpm -r dev` → `pnpm -r dev`; we set those ourselves. */
export function stripEnvPrefix(script: string): string {
  const parts = script.split(/\s+/).filter(Boolean)
  const first = parts.findIndex((part) => !part.includes('='))
  return first < 0 ? '' : parts.slice(first).join(' ')
}

export function detectPackageManager(worktree: string): string {
  const has = (name: string): boolean => existsSync(join(worktree, name))
  if (has('pnpm-lock.yaml')) return 'pnpm'
  if (has('yarn.lock')) return 'yarn'
  if (has('bun.lock') || has('bun.lockb')) return 'bun'
  return 'npm'
}

async function ensureDependencies(worktree: string, branch: string): Promise<void> {
  if (existsSync(join(worktree, 'node_modules'))) return
  const manager = detectPackageManager(worktree)
  note(branch, 'Installing dependencies — first run for this worktree, expect several minutes')
  const child = spawnShell(`${manager} install`, worktree, {}, (line) => logs.append(branch, `[dev] ${line}`))
  if (!isCleanExit(await child.exited)) {
    throw new TeaBranchError(`Dependency install failed — see the log for what ${manager} said.`)
  }
}

// MARK: - Spawning

function spawnCommand(command: StartCommand, branch: string, worktree: string): number {
  log.info(`spawn: branch=${branch}, label=${command.label}, cmd='${command.command}', port=${command.port}`)

  // Cap Node's heap so a watch-mode rebuild loop can't eat the machine — appended, never replacing
  // what the user set.
  const environment = { ...command.environment }
  const existing = process.env.NODE_OPTIONS ?? ''
  if (!existing.includes('--max-old-space-size')) {
    environment.NODE_OPTIONS = existing ? `${existing} --max-old-space-size=768` : '--max-old-space-size=768'
  }

  const tag = `[${command.label}] `
  const child = spawnShell(command.command, worktree, environment, (line) => logs.append(branch, tag + line))
  state.setPID(child.pid, branch, command.label)

  void child.exited.then((reason) => {
    log.info(`process exited: branch=${branch}, label=${command.label}, ${exitDescription(reason)}`)
    // A single process dying (frontend down, backend up) would otherwise just look like quiet.
    logs.append(branch, `${tag}⚠️  process ${exitDescription(reason)}`)
    // Only clear the slot if it is still ours — a watchdog restart may have replaced it already.
    if (state.pidsByLabel(branch).get(child.pid) === command.label) state.removePID(branch, command.label)
    if (!state.isManagingProcesses(branch)) {
      state.mutateEnvironment(branch, (env) => {
        if (env.status === 'running') env.status = 'error'
      })
    }
    emitSoon('branchesChanged')
  })
  return child.pid
}

// MARK: - Health watchdog

/** First compiles of the backend take minutes. */
const bootGraceMs = 300_000
const tickMs = 10_000
/** Failed probes tolerated once the port has been up — watch-mode rebuilds drop it briefly. */
const missLimit = 9
const maxRestarts = 3

interface Watched {
  command: StartCommand
  spawnedAt: number
  everUp: boolean
  misses: number
  upStreak: number
  restarts: number
  gaveUp: boolean
}

/**
 * Supervise by PORT, not just by PID. `nest start -w` happily outlives its crashed inner app,
 * leaving a live process with a dead port — invisible to the exit handler.
 */
function startWatchdog(branch: string, worktree: string, commands: StartCommand[], generation: number): void {
  const watched: Watched[] = commands.map((command) => ({
    command,
    spawnedAt: Date.now(),
    everUp: false,
    misses: 0,
    upStreak: 0,
    restarts: 0,
    gaveUp: false,
  }))

  const tick = async (): Promise<void> => {
    if (state.watchdogGeneration(branch) !== generation) return
    const status = state.environment(branch)?.status
    if (!status || status === 'stopped') return
    for (const process of watched) if (!process.gaveUp) await step(process, branch, worktree)
    setTimeout(() => void tick(), tickMs)
  }
  setTimeout(() => void tick(), tickMs)
}

async function step(process: Watched, branch: string, worktree: string): Promise<void> {
  const { label, port } = process.command
  const listening = await ports.isListening(port)
  const pidAlive = state.hasPID(branch, label)

  if (listening) {
    process.everUp = true
    process.misses = 0
    process.upStreak += 1
    if (process.upStreak >= 6) process.restarts = 0 // healthy for a minute
    return
  }
  process.upStreak = 0

  let unhealthy: boolean
  if (!pidAlive) unhealthy = true
  else if (!process.everUp) unhealthy = Date.now() - process.spawnedAt > bootGraceMs
  else unhealthy = ++process.misses >= missLimit
  if (!unhealthy) return

  if (process.restarts >= maxRestarts) {
    process.gaveUp = true
    watchdogLog(branch, label, `port ${port} still dead after ${process.restarts} restarts — giving up, check the logs above`)
    state.mutateEnvironment(branch, (environment) => {
      environment.status = 'error'
    })
    emitSoon('branchesChanged')
    return
  }

  process.restarts += 1
  const reason = !pidAlive
    ? 'process exited'
    : !process.everUp
      ? `port ${port} never came up (process alive but not serving)`
      : `port ${port} went dark while the process kept running`
  watchdogLog(branch, label, `${reason} — auto-restarting (${process.restarts}/${maxRestarts})`)

  const pid = state.removePID(branch, label)
  if (pid) signalGroup(pid, 'SIGTERM')
  await ports.reclaim(port)
  try {
    spawnCommand(process.command, branch, worktree)
    process.spawnedAt = Date.now()
    process.everUp = false
    process.misses = 0
    state.mutateEnvironment(branch, (environment) => {
      environment.status = 'running'
    })
    emitSoon('branchesChanged')
  } catch (error) {
    watchdogLog(branch, label, `restart failed: ${errorMessage(error)}`)
  }
}

function watchdogLog(branch: string, label: string, message: string): void {
  log.info(`watchdog: branch=${branch}, label=${label}: ${message}`)
  logs.append(branch, `[${label}] 🩺 TeaBranch watchdog: ${message}`)
}

// MARK: - Stop

/**
 * Stop a branch and *wait until it is actually stopped*: suppress reconcile, kill by process group
 * and by port, and throw if the ports never free up. Stop that returns early and lets reconcile
 * read the dying server as Running again is how Stop used to look like it did nothing.
 */
export const stop = (branch: string): Promise<void> => withBranchLock(branch, () => performStop(branch))

async function performStop(branch: string): Promise<void> {
  // Nothing running, nothing to tear down. This guard keeps Delete safe: reclaiming the ports named
  // in a stopped branch's env file would kill whatever unrelated process holds them today.
  const live = isLive(state.environment(branch)?.status ?? 'stopped')
  if (!live && !state.isManagingProcesses(branch)) {
    state.mutateEnvironment(branch, (environment) => {
      environment.status = 'stopped'
    })
    return
  }

  // Retire the watchdog first, or it reads the intentional stop as a crash and respawns.
  state.bumpWatchdogGeneration(branch)
  state.beginStopping(branch)
  try {
    const toReclaim = await portsToReclaim(branch)
    const pids = state.takePIDs(branch)
    for (const pid of pids) signalGroup(pid, 'SIGTERM')

    // Reclaim escalates and waits per port — which reaches orphans and escaped children too.
    const stuck: { port: number; holders: number[] }[] = []
    for (const port of toReclaim) {
      const survivors = await ports.reclaim(port)
      if (survivors.length) stuck.push({ port, holders: survivors })
    }

    // With no port to wait on, give the groups the grace period here instead.
    if (toReclaim.length === 0 && pids.length > 0) {
      for (let i = 0; i < 12 && pids.some(groupAlive); i++) await sleep(250)
    }
    for (const pid of pids) if (groupAlive(pid)) signalGroup(pid, 'SIGKILL')

    if (stuck.length) {
      const detail = stuck.map((s) => `port ${s.port} (pid ${s.holders.join(', ')})`).join('; ')
      // Leave the status: the server really is up. What was missing was anyone saying why.
      logs.append(branch, `[dev] ⛔️ TeaBranch: stop failed — still listening on ${detail} after SIGTERM and SIGKILL`)
      emitSoon('branchesChanged')
      throw new TeaBranchError(`Stop failed — still listening on ${detail}.`)
    }

    state.mutateEnvironment(branch, (environment) => {
      environment.status = 'stopped'
      environment.port = undefined
      environment.backendPort = undefined
      environment.socketPort = undefined
    })
    // Logs survive a stop: you stop a server *because* something went wrong.
    emitSoon('branchesChanged')
  } finally {
    state.endStopping(branch)
  }
}

/** What we recorded at start, else the worktree's env file — the only record for an orphan. */
async function portsToReclaim(branch: string): Promise<number[]> {
  const environment = state.environment(branch)
  const recorded = [environment?.port, environment?.backendPort, environment?.socketPort].filter(
    (port): port is number => !!port,
  )
  if (recorded.length) return recorded
  let path = environment?.worktreePath
  if (!path && state.projectPath) path = await git.worktreePath(branch, state.projectPath).catch(() => undefined)
  if (!path) return []
  return ['PORT', 'SERVER_PORT', 'SOCKET_PORT']
    .map((key) => envFile.port(key, path))
    .filter((port): port is number => !!port)
}

/** Kill everything we started, and everything on a live branch's ports. Called on quit. */
export async function cleanupAll(): Promise<void> {
  for (const pid of state.allPIDs()) signalGroup(pid, 'SIGKILL')
  if (state.ngrokPID) signalGroup(state.ngrokPID, 'SIGKILL')
  for (const environment of state.allEnvironments()) {
    if (!isLive(environment.status)) continue
    for (const port of [environment.port, environment.backendPort, environment.socketPort]) {
      if (port) await ports.killPort(port)
    }
  }
}

// MARK: - Reconcile

/**
 * Adopt dev servers listening on a worktree's configured ports that we don't own — orphans of a
 * force-quit — and drop recovered ones whose ports went away. Safe to call repeatedly.
 */
export async function reconcile(): Promise<void> {
  const repo = state.projectPath
  if (!repo) return
  const listening = await ports.allListening()
  let changed = false

  for (const entry of await git.worktrees(repo)) {
    if (state.isManagingProcesses(entry.branch) || state.isStopping(entry.branch)) continue
    const frontend = envFile.port('PORT', entry.path)
    const backend = envFile.port('SERVER_PORT', entry.path)
    const socket = envFile.port('SOCKET_PORT', entry.path)
    const live = (!!frontend && listening.has(frontend)) || (!!backend && listening.has(backend))
    const previous = state.environment(entry.branch)?.status

    if (live) {
      if (previous !== 'running') changed = true
      const url = envFile.baseDatabaseURL(entry.path)
      state.setEnvironment({
        branchName: entry.branch,
        worktreePath: entry.path,
        port: frontend,
        backendPort: backend,
        socketPort: socket,
        status: 'running',
        databaseName: url ? envFile.databaseURL.nameOf(url) : undefined,
      })
    } else if (previous === 'running') {
      state.mutateEnvironment(entry.branch, (environment) => {
        environment.status = 'stopped'
        environment.port = undefined
        environment.backendPort = undefined
        environment.socketPort = undefined
      })
      changed = true
    }
  }
  if (changed) emitSoon('branchesChanged')
}

/** Keep recovered state in sync every six seconds, like the builds before this one. */
export function startReconcileLoop(): void {
  const loop = async (): Promise<void> => {
    try {
      await reconcile()
      await ngrok.reconcile()
    } catch (error) {
      log.warn(`reconcile failed: ${errorMessage(error)}`)
    }
    setTimeout(() => void loop(), 6000)
  }
  setTimeout(() => void loop(), 800)
}
