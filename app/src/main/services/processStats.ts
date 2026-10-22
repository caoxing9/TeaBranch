import type { BranchUsage, ProcessSample } from '@shared/types'
import { listenersByPort } from '../core/ports'
import { run } from '../core/shell'

export interface Target {
  branch: string
  /** Process-group leader → the label of the command started in it. */
  pgids: Map<number, string>
  ports: number[]
}

/**
 * Per-branch CPU and memory from one `ps`. Everything TeaBranch spawns leads its own process
 * group, so a branch's whole `pnpm → turbo → next dev` tree is one grouping key. Branches adopted
 * as orphans have no PIDs of ours and are resolved through the ports they serve.
 */
export async function sample(targets: Target[]): Promise<Record<string, BranchUsage>> {
  if (!targets.length) return {}
  const needsPortLookup = targets.some((t) => t.pgids.size === 0 && t.ports.length > 0)
  const known = targets.flatMap((t) => [...t.pgids.keys()])
  const columns = 'pid=,pgid=,%cpu=,rss=,etime=,args='
  const result =
    !needsPortLookup && known.length ? await run('ps', ['-o', columns, '-g', known.join(',')]) : await run('ps', ['-Ao', columns])
  if (!result.ok && !result.stdout) return {}

  const rows: { pgid: number; process: ProcessSample }[] = []
  const pgidByPID = new Map<number, number>()
  for (const line of result.stdout.split('\n')) {
    const row = parse(line)
    if (!row) continue
    rows.push(row)
    pgidByPID.set(row.process.pid, row.pgid)
  }
  const listeners = needsPortLookup ? await listenersByPort() : new Map<number, number>()

  const usage: Record<string, BranchUsage> = {}
  for (const target of targets) {
    const labelByPgid = new Map(target.pgids)
    if (labelByPgid.size === 0) {
      for (const port of target.ports) {
        const pid = listeners.get(port)
        const pgid = pid ? pgidByPID.get(pid) : undefined
        if (pgid) labelByPgid.set(pgid, `:${port}`)
      }
    }
    if (!labelByPgid.size) continue
    const processes = rows
      .filter((row) => labelByPgid.has(row.pgid))
      .map((row) => ({ ...row.process, group: labelByPgid.get(row.pgid) ?? '' }))
    if (!processes.length) continue
    // Grouped by command, heaviest first: with a dozen workers, the one burning memory is the one
    // you are looking for.
    processes.sort((a, b) => (a.group === b.group ? b.residentBytes - a.residentBytes : a.group.localeCompare(b.group)))
    usage[target.branch] = {
      processes,
      cpuPercent: processes.reduce((sum, p) => sum + p.cpuPercent, 0),
      residentBytes: processes.reduce((sum, p) => sum + p.residentBytes, 0),
      uptimeSeconds: Math.max(...processes.map((p) => p.elapsedSeconds)),
    }
  }
  return usage
}

function parse(line: string): { pgid: number; process: ProcessSample } | undefined {
  const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
  if (!match) return undefined
  return {
    pgid: Number(match[2]),
    process: {
      pid: Number(match[1]),
      name: scriptName(match[6]),
      cpuPercent: Number(match[3]),
      residentBytes: Number(match[4]) * 1024,
      group: '',
      elapsedSeconds: parseElapsed(match[5]),
    },
  }
}

/** `node -r …/register.js …/backend-ee/dist/index` reads as `index`, not `node`. */
export function scriptName(args: string): string {
  const tokens = args.split(' ').filter(Boolean)
  const base = (path: string): string => path.split('/').pop() ?? path
  const executable = base(tokens[0] ?? args)
  if (executable !== 'node' && executable !== 'node.js') return executable
  const valueFlags = new Set(['-r', '--require', '--import', '--loader', '-e', '--eval'])
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]
    if (valueFlags.has(token)) {
      i += 1
      continue
    }
    if (token.startsWith('-') || token.includes('=')) continue
    const name = base(token).replace(/\.(m|c)?js$/, '')
    return name || executable
  }
  return executable
}

/** `[[dd-]hh:]mm:ss` → seconds. */
export function parseElapsed(raw: string): number {
  let days = 0
  let rest = raw
  const dash = raw.indexOf('-')
  if (dash >= 0) {
    days = Number.parseInt(raw.slice(0, dash), 10) || 0
    rest = raw.slice(dash + 1)
  }
  const parts = rest.split(':').map((part) => Number.parseInt(part, 10) || 0)
  const [a, b, c] = parts
  const seconds = parts.length === 3 ? a * 3600 + b * 60 + c : parts.length === 2 ? a * 60 + b : (a ?? 0)
  return days * 86400 + seconds
}
