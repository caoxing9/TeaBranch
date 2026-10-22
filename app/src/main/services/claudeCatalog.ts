import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentEffort, ClaudeCatalog, ClaudeModelOption } from '@shared/types'
import { log } from '../core/log'
import { childEnvironment } from '../core/shell'

/**
 * The Claude models this machine can run, asked of Claude Code itself (MonoCode's approach): a
 * throwaway stream-json session answers `initialize` then `list_models`, which reports display
 * names ("Opus 5.5") and each model's effort levels. Cached; the list changes with CLI releases.
 */

const TTL_MS = 10 * 60_000
let cached: { at: number; catalog: ClaudeCatalog } | null = null
let inflight: Promise<ClaudeCatalog> | null = null

export function claudeCatalog(agentCommand: string): Promise<ClaudeCatalog> {
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(withDefaults(cached.catalog))
  inflight ??= probe(agentCommand.trim().split(/\s+/)[0] || 'claude')
    .then((catalog) => {
      cached = { at: Date.now(), catalog }
      return withDefaults(catalog)
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

type Row = Record<string, unknown>

function probe(binary: string): Promise<ClaudeCatalog> {
  return new Promise((resolve, reject) => {
    const args = [
      binary,
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--input-format',
      'stream-json',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--mcp-config',
      JSON.stringify({ mcpServers: {} }),
      '--settings',
      JSON.stringify({ disableAllHooks: true }),
    ]
    const child = spawn('/usr/bin/env', args, { cwd: homedir(), env: childEnvironment(), stdio: ['pipe', 'pipe', 'ignore'] })
    const timer = setTimeout(() => finish(new Error('Claude Code did not list its models in time')), 20_000)
    let buffer = ''
    let done = false
    const finish = (error: Error | null, catalog?: ClaudeCatalog) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      if (error) {
        log.warn(`Claude model catalog: ${error.message}`)
        reject(error)
      } else resolve(catalog as ClaudeCatalog)
    }
    child.on('error', (error) => finish(error))
    child.on('exit', () => finish(new Error('Claude Code exited before listing its models')))
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        let event: Row
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        const response = event.type === 'control_response' ? (event.response as Row) : null
        if (response?.request_id === 'list_models') {
          const payload = (response.response ?? {}) as Row
          finish(null, catalogFrom(Array.isArray(payload.models) ? (payload.models as Row[]) : []))
        }
      }
    })
    const request = (id: string, subtype: string) =>
      child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype } })}\n`)
    request('initialize', 'initialize')
    request('list_models', 'list_models')
  })
}

export function catalogFrom(rows: Row[]): ClaudeCatalog {
  const models: ClaudeModelOption[] = []
  let defaultName = 'Claude'
  for (const row of rows) {
    if (row.disabled === true) continue
    const value = String(row.value ?? '')
    const description = String(row.description ?? '')
    if (value === 'default') {
      // "Opus 5.5 · Best for everyday, complex tasks"
      defaultName = description.split('·')[0].trim() || defaultName
      continue
    }
    if (!value || value.startsWith('cc-update-required') || models.some((model) => model.value === value)) continue
    const levels = Array.isArray(row.supportedEffortLevels) ? (row.supportedEffortLevels as AgentEffort[]) : []
    const efforts: AgentEffort[] =
      row.supportsEffort === true || levels.length > 0 ? (levels.length ? [...levels] : ['low', 'medium', 'high', 'max']) : []
    if (efforts.includes('xhigh')) efforts.push('ultracode')
    if (efforts.length) efforts.push('ultrathink')
    models.push({ value, resolved: String(row.resolvedModel || value), name: String(row.displayName || value), description, efforts })
  }
  return { models, defaultName }
}

/** `~/.claude/settings.json` decides what a run without `--model`/`--effort` gets. */
function withDefaults(catalog: ClaudeCatalog): ClaudeCatalog {
  let settings: { model?: string; effortLevel?: AgentEffort } = {}
  try {
    settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'))
  } catch {
    // No user settings: the CLI's own defaults apply.
  }
  const configured = settings.model ? catalog.models.find((model) => model.value === settings.model) : undefined
  return {
    ...catalog,
    defaultName: configured?.name ?? (settings.model && !catalog.models.length ? settings.model : catalog.defaultName),
    defaultEffort: settings.effortLevel,
  }
}
