import { randomUUID } from 'crypto'
import { mkdirSync } from '../node/fs'
import { join } from 'path'
import type { ConversationEntry, IssueRun } from '../shared/types'
import { log } from '../core/log'
import { configDirectory, loadAutopilotConfig } from '../core/settingsStore'
import { state } from '../core/appState'
import { modelFor } from '../core/models'
import { runClaude, truncate, withoutSkipPermissions } from './agentRunner'

/**
 * The watchdog's second opinion: a process that keeps talking isn't the same as one getting
 * somewhere. A model reads the agent's last steps and says whether it is making progress, going in
 * circles, or drifting from the task — with a word to get it back on track. One short call, no
 * tools, on the router's model.
 */
export interface Verdict {
  progress: 'yes' | 'stuck' | 'drifting'
  reason: string
  advice: string
}

/** The last steps, one line each: what the agent said and did, enough to see a loop in. */
function digest(entries: ConversationEntry[]): string {
  return entries
    .filter((entry) => entry.kind !== 'system' && entry.kind !== 'result')
    .slice(-60)
    .map((entry) => `[${entry.kind}${entry.isError ? ' error' : ''}] ${truncate(entry.text.replace(/\s+/g, ' '), 240)}`)
    .join('\n')
}

export function judgeProgress(run: IssueRun, entries: ConversationEntry[]): Promise<Verdict | undefined> {
  const steps = digest(entries)
  if (!steps) return Promise.resolve(undefined)
  const prompt = `You are the watchdog of a coding agent. Its task: ${run.issueKey} "${run.title}", now in the ${run.phase} phase.
Below are its most recent steps, oldest first. Judge whether it is making real progress on the task, going in circles (the same commands, edits or errors again and again, re-reading the same things, fighting one failure without a new idea), or drifting away from the task into something else.

<steps>
${steps}
</steps>

Answer with exactly one line of JSON and nothing else:
{"progress":"yes"|"stuck"|"drifting","reason":"<one sentence>","advice":"<what to tell the agent to get it moving: one or two sentences, in the language of its own messages>"}`
  const cwd = join(configDirectory, 'router')
  mkdirSync(cwd, { recursive: true })
  return new Promise((resolve) => {
    runClaude({
      prompt,
      cwd,
      session: { kind: 'new', id: randomUUID() },
      model: modelFor('router'),
      baseCommand: withoutSkipPermissions(state.settings.agentCommand),
      extraArgs: ['--tools', '', '--strict-mcp-config'],
      channel: 'agent',
      onEntry: () => undefined,
      onExit: (outcome) => {
        const match = /\{[\s\S]*\}/.exec(outcome.finalText)
        try {
          const parsed = JSON.parse(match?.[0] ?? '') as Partial<Verdict>
          if (parsed.progress === 'yes' || parsed.progress === 'stuck' || parsed.progress === 'drifting') {
            resolve({ progress: parsed.progress, reason: String(parsed.reason ?? ''), advice: String(parsed.advice ?? '') })
            return
          }
        } catch {
          // Not JSON: no verdict, which the warning below says.
        }
        log.warn(`progress check ${run.issueKey}: no verdict (${truncate(outcome.finalText, 120)})`)
        resolve(undefined)
      },
    })
  })
}
