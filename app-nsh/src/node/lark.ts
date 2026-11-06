/**
 * The slice of Feishu's Node SDK the app used, without Node: `Client.request` over `fetch` with the
 * tenant token kept fresh, the long connection (`WSClient`) over the host's WebSocket with the
 * SDK's protobuf frames written by hand, and the event dispatcher that feeds the handler.
 */

export const Domain = { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' } as const
export type DomainValue = (typeof Domain)[keyof typeof Domain]
export const LoggerLevel = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 } as const

const USER_TOKEN = Symbol('userAccessToken')

export interface RequestOptions {
  lark?: { [USER_TOKEN]?: string }
}

/** Requests under a user's access token instead of the app's. */
export const withUserAccessToken = (userAccessToken: string): RequestOptions => ({ lark: { [USER_TOKEN]: userAccessToken } })

export interface RequestPayload {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  url: string
  data?: unknown
  params?: Record<string, string | number | boolean | undefined>
  headers?: Record<string, string>
}

interface ApiEnvelope {
  code?: number
  msg?: string
  [key: string]: unknown
}

export class Client {
  private readonly appId: string
  private readonly appSecret: string
  private readonly domain: string
  private tenantToken: { value: string; expiresAt: number } | null = null
  readonly im: { messageResource: { get: (payload: ResourcePayload, options?: RequestOptions) => Promise<Resource> } }

  constructor(params: { appId: string; appSecret: string; domain: string; loggerLevel?: number }) {
    this.appId = params.appId
    this.appSecret = params.appSecret
    this.domain = params.domain
    this.im = { messageResource: { get: (payload, options) => this.messageResource(payload, options) } }
  }

  /** The tenant token, fetched when missing or within a minute of expiring. */
  private async tenantAccessToken(): Promise<string> {
    if (this.tenantToken && this.tenantToken.expiresAt > Date.now() + 60_000) return this.tenantToken.value
    const response = await fetch(`${this.domain}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    })
    const body = (await response.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number }
    if (body.code !== 0 || !body.tenant_access_token) throw new Error(`feishu auth: ${body.msg ?? `code ${body.code}`}`)
    this.tenantToken = { value: body.tenant_access_token, expiresAt: Date.now() + (body.expire ?? 7200) * 1000 }
    return body.tenant_access_token
  }

  private async authorization(options?: RequestOptions): Promise<string> {
    const user = options?.lark?.[USER_TOKEN]
    return `Bearer ${user ?? (await this.tenantAccessToken())}`
  }

  private url(path: string, params?: RequestPayload['params']): string {
    const url = new URL(path, this.domain)
    for (const [key, value] of Object.entries(params ?? {})) if (value !== undefined) url.searchParams.set(key, String(value))
    return url.toString()
  }

  /** An API call; the JSON body, or an error carrying the API's message. */
  async request<T = ApiEnvelope>(payload: RequestPayload, options?: RequestOptions): Promise<T> {
    const response = await fetch(this.url(payload.url, payload.params), {
      method: payload.method,
      headers: {
        Authorization: await this.authorization(options),
        ...(payload.data !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
        ...payload.headers,
      },
      body: payload.data !== undefined ? JSON.stringify(payload.data) : undefined,
    })
    const text = await response.text()
    let body: ApiEnvelope
    try {
      body = JSON.parse(text) as ApiEnvelope
    } catch {
      throw new Error(`feishu ${payload.method} ${payload.url}: ${response.status} ${text.slice(0, 200)}`)
    }
    if (body.code !== undefined && body.code !== 0) {
      throw Object.assign(new Error(`feishu ${payload.url}: ${body.msg ?? `code ${body.code}`}`), { code: body.code, response: { data: body } })
    }
    return body as T
  }

  private async messageResource(payload: ResourcePayload, options?: RequestOptions): Promise<Resource> {
    const { message_id, file_key } = payload.path
    const response = await fetch(this.url(`/open-apis/im/v1/messages/${message_id}/resources/${file_key}`, payload.params), {
      headers: { Authorization: await this.authorization(options) },
    })
    if (!response.ok) throw new Error(`feishu resource ${file_key}: ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    return {
      bytes,
      writeFile: async (path: string) => {
        const { writeFileSync } = await import('./fs')
        writeFileSync(path, bytes)
      },
    }
  }
}

export interface ResourcePayload {
  path: { message_id: string; file_key: string }
  params: { type: 'image' | 'file' }
}

export interface Resource {
  bytes: Uint8Array
  writeFile(path: string): Promise<void>
}

// MARK: - Events

type EventHandler = (data: Record<string, unknown>) => Promise<unknown> | unknown

interface EventEnvelope {
  schema?: string
  header?: { event_type?: string; event_id?: string; token?: string; create_time?: string; tenant_key?: string; app_id?: string }
  event?: Record<string, unknown>
}

/** Handlers by event type, as the SDK's: the handler gets the header's and the event's fields together. */
export class EventDispatcher {
  private readonly handles = new Map<string, EventHandler>()

  constructor(_params: Record<string, unknown> = {}) {}

  register(handlers: Record<string, EventHandler>): this {
    for (const [type, handler] of Object.entries(handlers)) this.handles.set(type, handler)
    return this
  }

  async invoke(data: EventEnvelope): Promise<unknown> {
    const type = data.header?.event_type ?? ''
    const handler = this.handles.get(type)
    if (!handler) return `no ${type} event handle`
    return handler({ ...data.header, ...data.event })
  }
}

// MARK: - The long connection

interface Header {
  key: string
  value: string
}

interface Frame {
  seqId: number
  logId: number
  service: number
  method: number
  headers: Header[]
  payloadEncoding?: string
  payloadType?: string
  payload?: Uint8Array
  logIdNew?: string
}

const FRAME_CONTROL = 0
const FRAME_DATA = 1

/** Protobuf, the two messages the connection speaks (`pbbp2.Frame`, `pbbp2.Header`). */
class Writer {
  private readonly parts: number[] = []

  varint(value: number): this {
    let v = value >>> 0
    if (value > 0xffffffff) {
      // Only small values are written here; a 64-bit id would need BigInt arithmetic.
      v = 0
    }
    while (v >= 0x80) {
      this.parts.push((v & 0x7f) | 0x80)
      v >>>= 7
    }
    this.parts.push(v)
    return this
  }

  tag(field: number, wire: number): this {
    return this.varint((field << 3) | wire)
  }

  bytes(field: number, data: Uint8Array): this {
    this.tag(field, 2).varint(data.length)
    for (const byte of data) this.parts.push(byte)
    return this
  }

  string(field: number, text: string): this {
    return this.bytes(field, new TextEncoder().encode(text))
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.parts)
  }
}

function encodeHeader(header: Header): Uint8Array {
  return new Writer().string(1, header.key).string(2, header.value).finish()
}

function encodeFrame(frame: Frame): Uint8Array {
  const writer = new Writer()
  writer.tag(1, 0).varint(frame.seqId)
  writer.tag(2, 0).varint(frame.logId)
  writer.tag(3, 0).varint(frame.service)
  writer.tag(4, 0).varint(frame.method)
  for (const header of frame.headers) writer.bytes(5, encodeHeader(header))
  if (frame.payloadEncoding) writer.string(6, frame.payloadEncoding)
  if (frame.payloadType) writer.string(7, frame.payloadType)
  if (frame.payload) writer.bytes(8, frame.payload)
  if (frame.logIdNew) writer.string(9, frame.logIdNew)
  return writer.finish()
}

class Reader {
  pos = 0
  constructor(private readonly data: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.data.length
  }

  varint(): number {
    let result = 0
    let shift = 0
    for (;;) {
      const byte = this.data[this.pos++]
      if (byte === undefined) throw new Error('truncated varint')
      result += (byte & 0x7f) * 2 ** shift
      if (!(byte & 0x80)) return result
      shift += 7
    }
  }

  bytes(): Uint8Array {
    const length = this.varint()
    const slice = this.data.subarray(this.pos, this.pos + length)
    this.pos += length
    return slice
  }

  skip(wire: number): void {
    if (wire === 0) this.varint()
    else if (wire === 2) this.bytes()
    else if (wire === 1) this.pos += 8
    else if (wire === 5) this.pos += 4
    else throw new Error(`unknown wire type ${wire}`)
  }
}

function decodeHeader(data: Uint8Array): Header {
  const reader = new Reader(data)
  const header: Header = { key: '', value: '' }
  while (!reader.done) {
    const tag = reader.varint()
    const field = tag >>> 3
    if (field === 1) header.key = new TextDecoder().decode(reader.bytes())
    else if (field === 2) header.value = new TextDecoder().decode(reader.bytes())
    else reader.skip(tag & 7)
  }
  return header
}

function decodeFrame(data: Uint8Array): Frame {
  const reader = new Reader(data)
  const frame: Frame = { seqId: 0, logId: 0, service: 0, method: 0, headers: [] }
  while (!reader.done) {
    const tag = reader.varint()
    const field = tag >>> 3
    const wire = tag & 7
    switch (field) {
      case 1:
        frame.seqId = reader.varint()
        break
      case 2:
        frame.logId = reader.varint()
        break
      case 3:
        frame.service = reader.varint()
        break
      case 4:
        frame.method = reader.varint()
        break
      case 5:
        frame.headers.push(decodeHeader(reader.bytes()))
        break
      case 6:
        frame.payloadEncoding = new TextDecoder().decode(reader.bytes())
        break
      case 7:
        frame.payloadType = new TextDecoder().decode(reader.bytes())
        break
      case 8:
        frame.payload = reader.bytes()
        break
      case 9:
        frame.logIdNew = new TextDecoder().decode(reader.bytes())
        break
      default:
        reader.skip(wire)
    }
  }
  return frame
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed'

export interface WSClientParams {
  appId: string
  appSecret: string
  domain: string
  loggerLevel?: number
  handshakeTimeoutMs?: number
  onReady?: () => void
  onReconnecting?: () => void
  onReconnected?: () => void
  onError?: (error: Error) => void
}

interface WsConfig {
  connectUrl: string
  serviceId: number
  pingInterval: number
  reconnectCount: number
  reconnectInterval: number
  reconnectNonce: number
}

/** Fragments of one event, joined when all arrived. */
class Fragments {
  private readonly cache = new Map<string, { parts: (Uint8Array | undefined)[]; at: number }>()

  merge(messageId: string, sum: number, seq: number, data: Uint8Array): Record<string, unknown> | null {
    if (!Number.isInteger(sum) || sum <= 0 || !Number.isInteger(seq) || seq < 0 || seq >= sum) throw new Error('bad fragment')
    let entry = this.cache.get(messageId)
    if (!entry) {
      entry = { parts: new Array<Uint8Array | undefined>(sum).fill(undefined), at: Date.now() }
      this.cache.set(messageId, entry)
    }
    entry.parts[seq] = data
    if (!entry.parts.every(Boolean)) return null
    this.cache.delete(messageId)
    const total = entry.parts.reduce((n, p) => n + (p?.length ?? 0), 0)
    const joined = new Uint8Array(total)
    let offset = 0
    for (const part of entry.parts) {
      joined.set(part as Uint8Array, offset)
      offset += (part as Uint8Array).length
    }
    for (const [id, old] of this.cache) if (Date.now() - old.at > 60_000) this.cache.delete(id)
    return JSON.parse(new TextDecoder().decode(joined)) as Record<string, unknown>
  }
}

export class WSClient {
  private readonly params: WSClientParams
  private socket: WebSocket | null = null
  private config: WsConfig | null = null
  private dispatcher: EventDispatcher | null = null
  private pingTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly fragments = new Fragments()
  private state: ConnectionState = 'idle'
  private attempts = 0
  private everConnected = false
  private closed = false
  private generation = 0

  constructor(params: WSClientParams) {
    this.params = params
  }

  getConnectionStatus(): { state: ConnectionState; reconnectAttempts: number } {
    return { state: this.state, reconnectAttempts: this.attempts }
  }

  async start(options: { eventDispatcher: EventDispatcher }): Promise<void> {
    this.dispatcher = options.eventDispatcher
    this.closed = false
    this.state = 'connecting'
    const ok = await this.connectOnce(++this.generation)
    if (!ok) this.scheduleReconnect()
  }

  close(_options?: { force?: boolean }): void {
    this.closed = true
    this.generation++
    this.state = 'closed'
    this.clearTimers()
    const socket = this.socket
    this.socket = null
    socket?.close()
  }

  private clearTimers(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.pingTimer = null
    this.reconnectTimer = null
  }

  /** The endpoint's answer: where to connect and how often to ping. */
  private async pullConfig(): Promise<{ ok: true } | { ok: false; retryable: boolean; error?: string }> {
    try {
      const response = await fetch(`${this.params.domain}/callback/ws/endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', locale: 'zh' },
        body: JSON.stringify({ AppID: this.params.appId, AppSecret: this.params.appSecret }),
      })
      const body = (await response.json()) as {
        code?: number
        msg?: string
        data?: { URL?: string; ClientConfig?: { PingInterval?: number; ReconnectCount?: number; ReconnectInterval?: number; ReconnectNonce?: number } }
      }
      if (body.code !== 0 || !body.data?.URL) {
        const retryable = body.code === 1 || body.code === 1000040343
        return { ok: false, retryable, error: `ws endpoint: code=${body.code}, ${body.msg ?? ''}` }
      }
      const url = new URL(body.data.URL)
      const client = body.data.ClientConfig ?? {}
      this.config = {
        connectUrl: body.data.URL,
        serviceId: Number(url.searchParams.get('service_id') ?? 0),
        pingInterval: (client.PingInterval ?? 120) * 1000,
        reconnectCount: client.ReconnectCount ?? -1,
        reconnectInterval: (client.ReconnectInterval ?? 120) * 1000,
        reconnectNonce: (client.ReconnectNonce ?? 30) * 1000,
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, retryable: true, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async connectOnce(generation: number): Promise<boolean> {
    const pulled = await this.pullConfig()
    if (generation !== this.generation) return true
    if (!pulled.ok) {
      if (!pulled.retryable) {
        this.state = 'failed'
        this.params.onError?.(new Error(pulled.error ?? 'ws endpoint refused'))
      }
      return false
    }
    const config = this.config as WsConfig
    return new Promise<boolean>((resolve) => {
      let settled = false
      const settle = (ok: boolean) => {
        if (settled) return
        settled = true
        if (handshake) clearTimeout(handshake)
        resolve(ok)
      }
      let socket: WebSocket
      try {
        socket = new WebSocket(config.connectUrl)
      } catch {
        return settle(false)
      }
      socket.binaryType = 'arraybuffer'
      const handshake = setTimeout(() => {
        socket.close()
        settle(false)
      }, this.params.handshakeTimeoutMs ?? 15_000)
      socket.onopen = () => {
        if (generation !== this.generation) return socket.close()
        this.socket = socket
        this.attempts = 0
        const reconnected = this.everConnected
        this.everConnected = true
        this.state = 'connected'
        this.pingLoop()
        if (reconnected) this.params.onReconnected?.()
        else this.params.onReady?.()
        settle(true)
      }
      socket.onerror = () => settle(false)
      socket.onmessage = (event) => {
        if (generation !== this.generation) return
        const data = event.data as ArrayBuffer | string
        if (typeof data === 'string') return
        void this.handle(decodeFrame(new Uint8Array(data))).catch((error) =>
          console.warn(`[TeaBranch] feishu ws frame: ${error instanceof Error ? error.message : String(error)}`),
        )
      }
      socket.onclose = () => {
        settle(false)
        if (generation !== this.generation || this.closed) return
        this.socket = null
        if (this.pingTimer) clearTimeout(this.pingTimer)
        this.pingTimer = null
        this.scheduleReconnect()
      }
    })
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    const config = this.config
    if (config && config.reconnectCount >= 0 && this.attempts >= config.reconnectCount) {
      this.state = 'failed'
      this.params.onError?.(new Error('feishu ws: reconnect attempts exhausted'))
      return
    }
    this.state = this.everConnected ? 'reconnecting' : 'connecting'
    if (this.everConnected) this.params.onReconnecting?.()
    const base = this.attempts === 0 ? 1000 : (config?.reconnectInterval ?? 120_000)
    const delay = base + Math.random() * (config?.reconnectNonce ?? 30_000)
    const generation = this.generation
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (generation !== this.generation || this.closed) return
      this.attempts += 1
      const ok = await this.connectOnce(generation)
      if (!ok) this.scheduleReconnect()
    }, delay)
  }

  private send(frame: Frame): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encodeFrame(frame))
  }

  private pingLoop(): void {
    const config = this.config
    if (!config) return
    this.send({ seqId: 0, logId: 0, service: config.serviceId, method: FRAME_CONTROL, headers: [{ key: 'type', value: 'ping' }] })
    this.pingTimer = setTimeout(() => this.pingLoop(), config.pingInterval)
  }

  private async handle(frame: Frame): Promise<void> {
    const headers = Object.fromEntries(frame.headers.map((h) => [h.key, h.value]))
    if (frame.method === FRAME_CONTROL) {
      if (headers.type === 'pong' && frame.payload && this.config) {
        try {
          const pong = JSON.parse(new TextDecoder().decode(frame.payload)) as Record<string, number>
          if (pong.PingInterval) this.config.pingInterval = pong.PingInterval * 1000
          if (pong.ReconnectCount !== undefined) this.config.reconnectCount = pong.ReconnectCount
          if (pong.ReconnectInterval) this.config.reconnectInterval = pong.ReconnectInterval * 1000
          if (pong.ReconnectNonce) this.config.reconnectNonce = pong.ReconnectNonce * 1000
        } catch {
          // A pong without a readable config changes nothing.
        }
      }
      return
    }
    if (frame.method !== FRAME_DATA || headers.type !== 'event' || !frame.payload) return
    const merged = this.fragments.merge(headers.message_id ?? '', Number(headers.sum ?? 1), Number(headers.seq ?? 0), frame.payload)
    if (!merged) return
    const started = Date.now()
    const answer: { code: number; data?: string } = { code: 200 }
    try {
      const result = await this.dispatcher?.invoke(merged as EventEnvelope)
      if (result !== undefined && result !== null) answer.data = btoa(unescape(encodeURIComponent(JSON.stringify(result))))
    } catch (error) {
      answer.code = 500
      console.warn(`[TeaBranch] feishu event ${headers.message_id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.send({
      ...frame,
      headers: [...frame.headers, { key: 'biz_rt', value: String(Date.now() - started) }],
      payload: new TextEncoder().encode(JSON.stringify(answer)),
    })
  }
}
