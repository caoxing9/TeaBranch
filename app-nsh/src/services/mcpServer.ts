import { randomBytes } from 'crypto'
import { type HttpRequest, type HttpResponse, HttpServer } from 'teabranch/native'
import { serve } from '../node/http'
import { log } from '../core/log'

/**
 * The smallest MCP server Claude Code talks to: Streamable HTTP on loopback, JSON responses only, tools
 * only. Enough to hand an agent TeaBranch's own actions without a dependency, behind a bearer token.
 * The socket is the Rust base's; every request comes here as a plain call.
 */

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** What the tool did, as text for the model. A thrown error comes back as a failed call. */
  run(args: Record<string, unknown>): Promise<string>
}

interface Rpc {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

export interface McpEndpoint {
  /** For `--mcp-config`: the server under `name`, with its token in the headers. */
  config(name: string): string
  close(): void
}

const header = (request: HttpRequest, name: string): string | undefined =>
  request.headers.find((h) => h.name.toLowerCase() === name)?.value

const json = (status: number, body: unknown): HttpResponse => ({
  status,
  headers: [{ name: 'Content-Type', value: 'application/json' }],
  body: JSON.stringify(body),
})

export async function startMcpServer(serverName: string, tools: McpTool[]): Promise<McpEndpoint> {
  const token = randomBytes(24).toString('hex')
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  const handle = async (rpc: Rpc): Promise<unknown> => {
    switch (rpc.method) {
      case 'initialize':
        return {
          protocolVersion: String(rpc.params?.protocolVersion ?? '2025-06-18'),
          capabilities: { tools: {} },
          serverInfo: { name: serverName, version: '1' },
        }
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }
      case 'tools/call': {
        const tool = byName.get(String(rpc.params?.name))
        if (!tool) throw Object.assign(new Error(`unknown tool ${String(rpc.params?.name)}`), { code: -32602 })
        try {
          const text = await tool.run((rpc.params?.arguments ?? {}) as Record<string, unknown>)
          return { content: [{ type: 'text', text }] }
        } catch (error) {
          return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
        }
      }
      default:
        throw Object.assign(new Error(`method not found: ${rpc.method}`), { code: -32601 })
    }
  }

  const respond = async (rpc: Rpc): Promise<unknown> => {
    // Notifications get no answer.
    if (rpc.id === undefined || rpc.id === null) {
      await handle(rpc).catch(() => undefined)
      return undefined
    }
    try {
      return { jsonrpc: '2.0', id: rpc.id, result: await handle(rpc) }
    } catch (error) {
      const code = (error as { code?: number }).code ?? -32603
      return { jsonrpc: '2.0', id: rpc.id, error: { code, message: error instanceof Error ? error.message : String(error) } }
    }
  }

  const onRequest = async (request: HttpRequest): Promise<HttpResponse> => {
    if (header(request, 'authorization') !== `Bearer ${token}`) return { status: 401, headers: null, body: null }
    // No server-initiated stream: everything is request and response.
    if (request.method !== 'POST') return { status: 405, headers: [{ name: 'Allow', value: 'POST' }], body: null }
    if (request.body.length > 5_000_000) return { status: 413, headers: null, body: null }
    let payload: Rpc | Rpc[]
    try {
      payload = JSON.parse(request.body) as Rpc | Rpc[]
    } catch {
      return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    }
    const batch = Array.isArray(payload)
    const messages: Rpc[] = Array.isArray(payload) ? payload : [payload]
    const results = await Promise.all(messages.map(respond))
    const answers = results.filter((result) => result !== undefined)
    if (!answers.length) return { status: 202, headers: null, body: null }
    return json(200, batch ? answers : answers[0])
  }

  const server = new HttpServer()
  const port = await server.start(0)
  serve(server, onRequest)
  const url = `http://127.0.0.1:${port}/mcp`
  log.info(`${serverName} MCP on ${url}`)
  return {
    config: (name) => JSON.stringify({ mcpServers: { [name]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }),
    close: () => server.stop(),
  }
}
