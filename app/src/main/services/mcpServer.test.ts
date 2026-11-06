import { afterEach, describe, expect, it } from 'vitest'
import { type McpEndpoint, startMcpServer } from './mcpServer'

describe('mcpServer', () => {
  let endpoint: McpEndpoint | undefined
  afterEach(() => endpoint?.close())

  const call = async (body: unknown, auth = true): Promise<Response> => {
    const config = JSON.parse(endpoint!.config('t')).mcpServers.t
    return fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? config.headers : {}) },
      body: JSON.stringify(body),
    })
  }

  interface Reply {
    result: { capabilities?: { tools?: unknown }; tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean }
    error: { code: number }
  }
  const rpc = async (body: unknown): Promise<Reply> => (await (await call(body)).json()) as Reply

  it('lists and calls tools, behind its token', async () => {
    endpoint = await startMcpServer('test', [
      {
        name: 'echo',
        description: 'echo',
        inputSchema: { type: 'object' },
        run: async (args) => `got ${String(args.text)}`,
      },
      {
        name: 'boom',
        description: 'fails',
        inputSchema: { type: 'object' },
        run: async () => {
          throw new Error('nope')
        },
      },
    ])
    expect((await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, false)).status).toBe(401)

    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    expect(init.result.capabilities?.tools).toEqual({})
    expect((await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)

    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(list.result.tools?.map((tool) => tool.name)).toEqual(['echo', 'boom'])

    const echo = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } })
    expect(echo.result.content?.[0].text).toBe('got hi')

    const boom = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom' } })
    expect(boom.result).toMatchObject({ isError: true, content: [{ text: 'nope' }] })

    const missing = await rpc({ jsonrpc: '2.0', id: 5, method: 'nope' })
    expect(missing.error.code).toBe(-32601)
  })
})
