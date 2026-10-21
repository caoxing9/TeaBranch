import type { AppSettings, BranchEnvironment, NgrokTunnel } from '@shared/types'
import { isLive } from '@shared/types'
import { loadSettings, saveSettings } from './settingsStore'

/**
 * Process-wide mutable state shared by the services. Single-threaded, so no locks — but every
 * service awaits subprocesses, so read-modify-write across an `await` still needs the mutexes in
 * `processManager`.
 */
class AppState {
  settings: AppSettings = loadSettings()
  private environments = new Map<string, BranchEnvironment>()
  /** `branch:label` → pid of the process-group leader. */
  private pids = new Map<string, number>()
  /** Bumped on every start/stop; a watchdog retires once its generation is stale. */
  private watchdogGenerations = new Map<string, number>()
  /**
   * Branches whose stop is in flight. Reconcile reads ground truth from env files, so between
   * "clicked Stop" and "port actually free" it would see the dying server and resurrect it.
   */
  private stopping = new Set<string>()
  ngrokPID: number | undefined
  ngrokTunnel: NgrokTunnel | undefined

  get projectPath(): string | undefined {
    return this.settings.projectPath
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.settings = { ...this.settings, ...patch }
    saveSettings(this.settings)
    return this.settings
  }

  // Environments

  environment = (branch: string): BranchEnvironment | undefined => this.environments.get(branch)
  allEnvironments = (): BranchEnvironment[] => [...this.environments.values()]
  environmentsByBranch = (): Record<string, BranchEnvironment> => Object.fromEntries(this.environments)

  setEnvironment(environment: BranchEnvironment): void {
    this.environments.set(environment.branchName, environment)
  }

  mutateEnvironment(branch: string, body: (environment: BranchEnvironment) => void): boolean {
    const environment = this.environments.get(branch)
    if (!environment) return false
    body(environment)
    return true
  }

  removeEnvironment = (branch: string): void => void this.environments.delete(branch)
  clearEnvironments = (): void => this.environments.clear()

  /** Ports claimed by live environments — never allocated twice. */
  portsInUse(): Set<number> {
    const ports = new Set<number>()
    for (const environment of this.environments.values()) {
      if (!isLive(environment.status)) continue
      for (const port of [environment.port, environment.backendPort, environment.socketPort]) if (port) ports.add(port)
    }
    return ports
  }

  // Child processes

  setPID = (pid: number, branch: string, label: string): void => void this.pids.set(`${branch}:${label}`, pid)

  removePID(branch: string, label: string): number | undefined {
    const key = `${branch}:${label}`
    const pid = this.pids.get(key)
    this.pids.delete(key)
    return pid
  }

  hasPID = (branch: string, label: string): boolean => this.pids.has(`${branch}:${label}`)

  isManagingProcesses = (branch: string): boolean => [...this.pids.keys()].some((key) => key.startsWith(`${branch}:`))

  /** pid → label: what turns nine `node` processes into "five backend, four frontend". */
  pidsByLabel(branch: string): Map<number, string> {
    const prefix = `${branch}:`
    const result = new Map<number, string>()
    for (const [key, pid] of this.pids) if (key.startsWith(prefix)) result.set(pid, key.slice(prefix.length))
    return result
  }

  takePIDs(branch: string): number[] {
    const prefix = `${branch}:`
    const taken: number[] = []
    for (const [key, pid] of [...this.pids]) {
      if (!key.startsWith(prefix)) continue
      taken.push(pid)
      this.pids.delete(key)
    }
    return taken
  }

  allPIDs = (): number[] => [...this.pids.values()]

  // Stop suppression

  beginStopping = (branch: string): void => void this.stopping.add(branch)
  endStopping = (branch: string): void => void this.stopping.delete(branch)
  isStopping = (branch: string): boolean => this.stopping.has(branch)

  // Watchdog generations

  bumpWatchdogGeneration(branch: string): number {
    const next = (this.watchdogGenerations.get(branch) ?? 0) + 1
    this.watchdogGenerations.set(branch, next)
    return next
  }

  watchdogGeneration = (branch: string): number => this.watchdogGenerations.get(branch) ?? 0
}

export const state = new AppState()
