import { describe, expect, it } from 'vitest'
import { StreamParser } from './agentRunner'

const feed = (parser: StreamParser, events: object[]) => events.flatMap((event) => parser.consume(JSON.stringify(event)))

describe('StreamParser', () => {
  it('tracks background tasks and reports the one that finished', () => {
    const parser = new StreamParser('agent')
    feed(parser, [
      { type: 'system', subtype: 'init', model: 'opus' },
      { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1' }] },
      { type: 'system', subtype: 'task_started', task_id: 'b1', task_type: 'local_bash', description: 'Poll CI', is_backgrounded: true },
      { type: 'system', subtype: 'task_started', task_id: 'a1', task_type: 'local_agent', description: 'Look', is_backgrounded: false },
    ])
    expect(parser.background.map((task) => [task.id, task.kind])).toEqual([['b1', 'command']])
    const lines = feed(parser, [
      { type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed', summary: 'CI is green' },
      { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
    ])
    expect(parser.background).toEqual([])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ kind: 'task', text: 'CI is green', task: { kind: 'command', status: 'completed', description: 'Poll CI' } })
  })

  it('files a subagent’s steps under its call and drops what it says', () => {
    const parser = new StreamParser('agent')
    const lines = feed(parser, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call', name: 'Agent', input: { description: 'Look' } }] } },
      { type: 'assistant', parent_tool_use_id: 'call', message: { content: [{ type: 'text', text: 'thinking aloud' }] } },
      { type: 'assistant', parent_tool_use_id: 'call', message: { content: [{ type: 'tool_use', id: 'inner', name: 'Bash', input: { command: 'ls' } }] } },
    ])
    expect(lines.map((line) => [line.kind, line.toolUseId, line.parentToolUseId])).toEqual([
      ['tool', 'call', undefined],
      ['tool', 'inner', 'call'],
    ])
  })
})
