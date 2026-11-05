import { mkdirSync } from '../node/fs'
import { type HttpRequest, type HttpResponse, HttpServer } from 'teabranch/native'
import { serve } from '../node/http'
import { join } from 'path'
import * as lark from '../node/lark'
import type { AutopilotConfig, FeishuState } from '../shared/types'
import { httpFetch } from '../core/http'
import { log } from '../core/log'
import { readSecret, writeSecret } from '../core/secrets'
import { configDirectory, loadAutopilotConfig } from '../core/settingsStore'

/**
 * Feishu (or Lark) as a channel, in one of two identities.
 *
 * As the app's bot, messages come in over the open platform's long connection — no public callback
 * URL, so it works from a laptop — and replies go out as the bot.
 *
 * As you, after you authorize the app once in the browser: Feishu pushes events only to bots, so the
 * chats you let it listen to are read every few seconds with your token, and replies go out under your
 * name, marked 🤖 so nobody takes them for you.
 */

export interface FeishuMessage {
  messageId: string
  /** The topic it belongs to: its root message, or itself when it starts one. */
  rootId: string
  parentId?: string
  chatId: string
  chatType: 'p2p' | 'group'
  senderId: string
  /** Text with @-mentions spelled out by name, images as `[image N]`. */
  text: string
  /** Addressed to it: the bot @-mentioned, or — speaking as you — you. */
  mentionsBot: boolean
  /** Image keys, in the order the text numbers them. */
  images: string[]
  at: number
  /** A direct message to the app's bot — answered as the bot, whoever it is speaking as elsewhere. */
  toBot?: boolean
  /** Sent by the person who authorized it: the owner, giving instructions. */
  fromOwner?: boolean
}

type Listener = (message: FeishuMessage) => void

/** What marks a reply sent under your name as the assistant's. */
export const AI_PREFIX = '🤖 '

let client: lark.Client | null = null
let socket: lark.WSClient | null = null
let pollTimer: ReturnType<typeof setTimeout> | null = null
let identity: AutopilotConfig['feishuIdentity'] = 'bot'
let state: FeishuState = 'off'
let lastError: string | undefined
/** Who it speaks as: the bot, or you. */
let self: { name: string; openId: string } | undefined
let onState: () => void = () => undefined
/** Feishu redelivers an event it thinks was missed, and polls overlap; one message is handled once. */
const seen = new Set<string>()
const names = new Map<string, string>()
const chatNames = new Map<string, string>()

export const status = (): { state: FeishuState; error?: string; bot?: { name: string; openId: string } } => ({
  state,
  error: lastError,
  bot: self,
})

const setState = (next: FeishuState, error?: string): void => {
  state = next
  lastError = error
  onState()
}

const openBase = (domain: AutopilotConfig['feishuDomain']): string =>
  domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
const accountsBase = (domain: AutopilotConfig['feishuDomain']): string =>
  domain === 'lark' ? 'https://accounts.larksuite.com' : 'https://accounts.feishu.cn'

export interface ConnectOptions {
  config: AutopilotConfig
  listener: Listener
  changed: () => void
  /** Speaking as you: the chats to read, asked fresh each round. */
  chats: () => string[]
  /** Speaking as you: whether to read your direct messages too. */
  directs: () => boolean
  /** Speaking as you: every group you're in, now and then, so they can be switched on. */
  discovered: (chats: { id: string; name: string }[]) => void
}

/** Bumped by every connect: a connect overtaken while it awaited stops instead of adding a second loop. */
let generation = 0

export async function connect(options: ConnectOptions): Promise<void> {
  const { config } = options
  disconnect()
  const current = ++generation
  const stale = (): boolean => current !== generation
  onState = options.changed
  identity = config.feishuIdentity
  refreshOwner()
  const appSecret = readSecret('feishu.secret')
  if (!config.feishuAppId || !appSecret) return setState('noCredentials')
  const domain = config.feishuDomain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu
  const appId = config.feishuAppId
  client = new lark.Client({ appId, appSecret, domain, loggerLevel: lark.LoggerLevel.warn })
  setState('connecting')
  if (identity === 'user') {
    // Speaking as you, the bot still takes direct messages: the way to hand it something from your
    // phone, or forward it a conversation. Its connection doesn't decide the state; reading as you does.
    void startSocket(appId, appSecret, domain, options.listener, true, stale).catch((error) =>
      log.warn(`feishu bot socket: ${describe(error)}`),
    )
    return startPolling(config, options, stale)
  }

  try {
    const info = (await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' })) as {
      bot?: { open_id?: string; app_name?: string }
    }
    self = info.bot?.open_id ? { openId: info.bot.open_id, name: info.bot.app_name ?? 'bot' } : undefined
  } catch (error) {
    return stale() ? undefined : setState('failed', `bot info: ${describe(error)}`)
  }
  if (stale()) return
  await startSocket(appId, appSecret, domain, options.listener, false, stale)
}

/** The bot's long connection. `directOnly`: only its direct messages, and the state left to the caller. */
async function startSocket(
  appId: string,
  appSecret: string,
  domain: string,
  listener: Listener,
  directOnly: boolean,
  stale: () => boolean,
): Promise<void> {
  if (stale()) return
  const dispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      try {
        const message = parse(data as unknown as ReceiveEvent, directOnly)
        if (message) listener(message)
      } catch (error) {
        log.warn(`feishu event: ${describe(error)}`)
      }
    },
  })
  const report = (next: FeishuState, error?: string) => !directOnly && setState(next, error)
  socket = new lark.WSClient({
    appId,
    appSecret,
    domain,
    loggerLevel: lark.LoggerLevel.warn,
    handshakeTimeoutMs: 15_000,
    onReady: () => report('connected'),
    onReconnecting: () => report('reconnecting'),
    onReconnected: () => report('connected'),
    onError: (error) => report('failed', error.message),
  })
  await socket.start({ eventDispatcher: dispatcher })
}

export function disconnect(): void {
  socket?.close({ force: true })
  socket = null
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
  client = null
  self = undefined
  state = 'off'
  lastError = undefined
}

/** The socket as the SDK sees it now — for the watchdog, which restarts one that gave up. */
export const connectionState = (): string => (identity === 'user' ? state : (socket?.getConnectionStatus().state ?? 'idle'))

/**
 * Requests as you when speaking as you, as the app otherwise — and always as the app for the bot's own
 * direct messages (`asBot`), which you aren't part of.
 */
async function as(asBot = false): Promise<ReturnType<typeof lark.withUserAccessToken> | undefined> {
  if (identity !== 'user' || asBot) return undefined
  return lark.withUserAccessToken(await userToken())
}

/** Reply under a message, in its topic. Text only: long Markdown reads badly in a chat. */
export async function reply(messageId: string, text: string, asBot = false): Promise<void> {
  if (!client) throw new Error('feishu: not connected')
  // Under your name, always marked: an empty prefix in the settings still gets the default.
  const body = identity === 'user' && !asBot ? `${loadAutopilotConfig().replyPrefix || AI_PREFIX}${text}` : text
  await client.request(
    {
      method: 'POST',
      url: `/open-apis/im/v1/messages/${messageId}/reply`,
      data: { msg_type: 'text', content: JSON.stringify({ text: body }), reply_in_thread: false },
    },
    await as(asBot),
  )
}

/**
 * A forwarded conversation ("merge forward") spelled out, a line a message with who said it — what
 * the owner forwards when they want something in it looked into.
 */
export async function forwardedText(messageId: string, asBot = false): Promise<string | undefined> {
  if (!client) return undefined
  try {
    const result = (await client.request({ method: 'GET', url: `/open-apis/im/v1/messages/${messageId}` }, await as(asBot))) as {
      data?: { items?: (ListedMessage & { upper_message_id?: string })[] }
    }
    const items = (result.data?.items ?? []).filter((item) => item.upper_message_id === messageId)
    const lines: string[] = []
    for (const item of items) {
      const name = item.sender?.id ? await userName(item.sender.id) : '?'
      lines.push(`${name}: ${render(item.msg_type, item.body?.content ?? '', item.mentions ?? []).text}`)
    }
    return lines.length ? lines.join('\n') : undefined
  } catch (error) {
    log.warn(`feishu forwarded ${messageId}: ${describe(error)}`)
    return undefined
  }
}

/** One message's text, for the context around a reply. */
export async function messageText(messageId: string, asBot = false): Promise<string | undefined> {
  if (!client) return undefined
  try {
    const result = (await client.request({ method: 'GET', url: `/open-apis/im/v1/messages/${messageId}` }, await as(asBot))) as {
      data?: { items?: { msg_type: string; body?: { content?: string }; mentions?: Mention[] }[] }
    }
    const item = result.data?.items?.[0]
    return item ? render(item.msg_type, item.body?.content ?? '', item.mentions ?? []).text : undefined
  } catch {
    return undefined
  }
}

export async function userName(openId: string): Promise<string> {
  const cached = names.get(openId)
  if (cached || !client) return cached ?? openId
  try {
    const result = (await client.request(
      { method: 'GET', url: `/open-apis/contact/v3/users/${openId}`, params: { user_id_type: 'open_id' } },
      await as(),
    )) as { data?: { user?: { name?: string } } }
    const name = result.data?.user?.name || openId
    names.set(openId, name)
    return name
  } catch {
    // Contacts may be out of the app's scope; the id still tells people apart.
    names.set(openId, openId)
    return openId
  }
}

export async function chatName(chatId: string): Promise<string> {
  const cached = chatNames.get(chatId)
  if (cached || !client) return cached ?? chatId
  try {
    const result = (await client.request({ method: 'GET', url: `/open-apis/im/v1/chats/${chatId}` }, await as())) as {
      data?: { name?: string }
    }
    const name = result.data?.name || chatId
    chatNames.set(chatId, name)
    return name
  } catch {
    return chatId
  }
}

/** A message's image, saved where the issue's agent can read it; undefined when it can't be fetched. */
export async function downloadImage(messageId: string, key: string, asBot = false): Promise<string | undefined> {
  if (!client) return undefined
  const dir = join(configDirectory, 'feishu-files')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${key}.png`)
  try {
    const file = await client.im.messageResource.get(
      { path: { message_id: messageId, file_key: key }, params: { type: 'image' } },
      await as(asBot),
    )
    await file.writeFile(path)
    return path
  } catch (error) {
    log.warn(`feishu image ${key}: ${describe(error)}`)
    return undefined
  }
}

// MARK: - Speaking as you: authorization

/** Registered in the app's security settings as a redirect URL; the browser lands here after you approve. */
export const REDIRECT_URL = 'http://127.0.0.1:17635/feishu/oauth'

/** What it reads and sends as you. Each must be enabled, as a user scope, in the app. */
export const USER_SCOPES = [
  'im:message',
  'im:message.send_as_user',
  'im:message.group_msg:get_as_user',
  'im:message.p2p_msg:get_as_user',
  'im:chat:read',
  'im:resource',
  'contact:user.base:readonly',
  'search:message',
  'offline_access',
]

interface UserToken {
  accessToken: string
  refreshToken?: string
  /** Epoch ms. */
  expiresAt: number
  refreshExpiresAt?: number
  openId: string
  name: string
}

const loadUser = (): UserToken | undefined => {
  try {
    const raw = readSecret('feishu.user')
    return raw ? (JSON.parse(raw) as UserToken) : undefined
  } catch {
    return undefined
  }
}

/** Who authorized, without the token. */
export const authorizedUser = (): { name: string; openId: string } | undefined => {
  const user = loadUser()
  return user ? { name: user.name, openId: user.openId } : undefined
}

export const signOutUser = (): void => writeSecret('feishu.user', undefined)

let authServer: HttpServer | null = null

/**
 * Send you to Feishu to approve, and wait for the browser to come back with the code. `open` opens
 * the page; resolves with who signed in.
 */
export function authorizeUser(config: AutopilotConfig, open: (url: string) => void): Promise<{ name: string }> {
  const appSecret = readSecret('feishu.secret')
  if (!config.feishuAppId || !appSecret) return Promise.reject(new Error('App ID and App Secret first'))
  authServer?.stop()
  const stateToken = Math.random().toString(36).slice(2)
  return new Promise((resolve, reject) => {
    const server = new HttpServer()
    authServer = server
    const timeout = setTimeout(() => {
      server.stop()
      reject(new Error('authorization timed out'))
    }, 300_000)
    const page = (ok: boolean, text: string): HttpResponse => {
      clearTimeout(timeout)
      // Stopped after the answer went out.
      setTimeout(() => server.stop(), 500)
      return {
        status: ok ? 200 : 400,
        headers: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
        body: `<meta charset="utf-8"><body style="font:15px -apple-system;padding:40px">${text}</body>`,
      }
    }
    const onRequest = async (request: HttpRequest): Promise<HttpResponse> => {
      const url = new URL(request.url, REDIRECT_URL)
      if (url.pathname !== '/feishu/oauth') return { status: 404, headers: null, body: null }
      const code = url.searchParams.get('code')
      if (!code || url.searchParams.get('state') !== stateToken) {
        reject(new Error(url.searchParams.get('error') ?? 'no code'))
        return page(false, 'TeaBranch: authorization was not completed.')
      }
      try {
        const user = await exchange(config, appSecret, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URL })
        resolve({ name: user.name })
        return page(true, `TeaBranch can now read and reply as ${user.name}. You can close this tab.`)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return page(false, `TeaBranch: ${describe(error)}`)
      }
    }
    server.start(17635).then(
      () => {
        serve(server, onRequest)
        const query = new URLSearchParams({
          client_id: config.feishuAppId,
          redirect_uri: REDIRECT_URL,
          scope: USER_SCOPES.join(' '),
          state: stateToken,
          response_type: 'code',
        })
        open(`${accountsBase(config.feishuDomain)}/open-apis/authen/v1/authorize?${query}`)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** The OAuth token endpoint, for a first code or a refresh; saves and returns who it is. */
async function exchange(config: AutopilotConfig, appSecret: string, grant: Record<string, string>): Promise<UserToken> {
  const base = openBase(config.feishuDomain)
  const response = await httpFetch(`${base}/open-apis/authen/v2/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ ...grant, client_id: config.feishuAppId, client_secret: appSecret }),
  })
  const token = (await response.json()) as {
    code?: number
    error?: string
    error_description?: string
    access_token?: string
    expires_in?: number
    refresh_token?: string
    refresh_token_expires_in?: number
  }
  if (!token.access_token)
    throw new Error(token.error_description || token.error || `token request failed (${token.code ?? response.status})`)
  const previous = loadUser()
  let who = previous && grant.grant_type === 'refresh_token' ? { name: previous.name, openId: previous.openId } : undefined
  if (!who) {
    const info = (await (
      await httpFetch(`${base}/open-apis/authen/v1/user_info`, { headers: { Authorization: `Bearer ${token.access_token}` } })
    ).json()) as { data?: { open_id?: string; name?: string } }
    if (!info.data?.open_id) throw new Error('could not read who authorized')
    who = { openId: info.data.open_id, name: info.data.name ?? info.data.open_id }
  }
  const now = Date.now()
  const user: UserToken = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? previous?.refreshToken,
    expiresAt: now + (token.expires_in ?? 7200) * 1000,
    refreshExpiresAt: token.refresh_token_expires_in ? now + token.refresh_token_expires_in * 1000 : previous?.refreshExpiresAt,
    ...who,
  }
  writeSecret('feishu.user', JSON.stringify(user))
  return user
}

let refreshing: Promise<UserToken> | null = null
let tokenConfig: AutopilotConfig | null = null

/** Your access token, refreshed when it has less than five minutes left. */
async function userToken(): Promise<string> {
  const user = loadUser()
  if (!user) throw new Error('not authorized — authorize with your Feishu account first')
  if (user.expiresAt - Date.now() > 300_000) return user.accessToken
  const appSecret = readSecret('feishu.secret')
  if (!user.refreshToken || !appSecret || !tokenConfig) throw new Error('authorization expired — authorize again')
  refreshing ??= exchange(tokenConfig, appSecret, { grant_type: 'refresh_token', refresh_token: user.refreshToken }).finally(() => {
    refreshing = null
  })
  return (await refreshing).accessToken
}

// MARK: - Speaking as you: reading chats

/** Where each chat was read up to, epoch ms. A chat starts at the moment it's first read: no backlog. */
const cursors = new Map<string, number>()
let lastDiscovery = 0

async function startPolling(config: AutopilotConfig, options: ConnectOptions, stale: () => boolean): Promise<void> {
  tokenConfig = config
  const user = loadUser()
  if (!user) return setState('noCredentials', 'authorize with your Feishu account')
  try {
    await userToken()
  } catch (error) {
    return stale() ? undefined : setState('failed', describe(error))
  }
  if (stale()) return
  self = { name: user.name, openId: user.openId }
  setState('connected')
  const round = async (): Promise<void> => {
    pollTimer = null
    if (!client || stale()) return
    try {
      if (Date.now() - lastDiscovery > 600_000) {
        lastDiscovery = Date.now()
        options.discovered(await listChats())
      }
      for (const chatId of options.chats()) {
        for (const message of await readChat(chatId)) options.listener(message)
      }
      // Direct messages need a scope of their own; without it the chats are still read.
      if (options.directs()) {
        try {
          for (const message of await readDirects()) options.listener(message)
        } catch (error) {
          log.warn(`feishu direct messages: ${describe(error)}`)
        }
      }
      if (state !== 'connected') setState('connected')
    } catch (error) {
      log.warn(`feishu poll: ${describe(error)}`)
      setState('failed', describe(error))
    }
    if (client && !stale()) pollTimer = setTimeout(() => void round(), Math.max(5, config.pollSeconds) * 1000)
  }
  void round()
}

async function listChats(): Promise<{ id: string; name: string }[]> {
  const chats: { id: string; name: string }[] = []
  let pageToken = ''
  for (let page = 0; page < 20; page++) {
    const result = (await client!.request(
      { method: 'GET', url: '/open-apis/im/v1/chats', params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) } },
      await as(),
    )) as { data?: { items?: { chat_id: string; name?: string }[]; has_more?: boolean; page_token?: string } }
    for (const item of result.data?.items ?? []) {
      chatNames.set(item.chat_id, item.name || item.chat_id)
      chats.push({ id: item.chat_id, name: item.name || item.chat_id })
    }
    if (!result.data?.has_more || !result.data.page_token) break
    pageToken = result.data.page_token
  }
  return chats
}

interface ListedMessage {
  message_id: string
  root_id?: string
  parent_id?: string
  msg_type: string
  create_time: string
  chat_id: string
  deleted?: boolean
  sender?: { id?: string; sender_type?: string }
  body?: { content?: string }
  mentions?: Mention[]
}

/** What was said in a chat since the last read: people only, and never you — your own messages, and
 *  the assistant's replies under your name, are not requests to it. */
async function readChat(chatId: string): Promise<FeishuMessage[]> {
  const since = cursors.get(chatId)
  if (since === undefined) {
    cursors.set(chatId, Date.now())
    return []
  }
  const result = (await client!.request(
    {
      method: 'GET',
      url: '/open-apis/im/v1/messages',
      params: {
        container_id_type: 'chat',
        container_id: chatId,
        start_time: String(Math.floor(since / 1000)),
        sort_type: 'ByCreateTimeAsc',
        page_size: 50,
      },
    },
    await as(),
  )) as { data?: { items?: ListedMessage[] } }
  const messages: FeishuMessage[] = []
  let newest = since
  for (const item of result.data?.items ?? []) {
    const at = Number(item.create_time) || 0
    newest = Math.max(newest, at)
    if (item.deleted || seen.has(item.message_id)) continue
    remember(item.message_id)
    const senderId = item.sender?.id
    if (!senderId || item.sender?.sender_type !== 'user' || senderId === self?.openId) continue
    const mentions = item.mentions ?? []
    const { text, images } = render(item.msg_type, item.body?.content ?? '', mentions)
    messages.push({
      messageId: item.message_id,
      rootId: item.root_id || item.message_id,
      parentId: item.parent_id || undefined,
      chatId,
      chatType: 'group',
      senderId,
      text,
      mentionsBot: !!self && mentions.some((mention) => mentionId(mention) === self?.openId),
      images,
      at,
    })
  }
  cursors.set(chatId, newest)
  return messages
}

/** Direct messages to you are read up to here, epoch ms; starts when first asked for. */
let directCursor: number | undefined

/**
 * Direct messages people sent you since the last read. No API lists your one-to-one chats, so they
 * are found with message search — whose index can trail by a little, hence the look-back.
 */
async function readDirects(): Promise<FeishuMessage[]> {
  const now = Date.now()
  if (directCursor === undefined) {
    directCursor = now
    return []
  }
  const from = Math.floor((directCursor - 120_000) / 1000)
  const ids: string[] = []
  let pageToken = ''
  for (let page = 0; page < 5; page++) {
    const result = (await client!.request(
      {
        method: 'POST',
        url: '/open-apis/search/v2/message',
        params: { user_id_type: 'open_id', page_size: 50, ...(pageToken ? { page_token: pageToken } : {}) },
        data: { query: '', chat_type: 'p2p_chat', from_type: 'user', start_time: String(from), end_time: String(Math.ceil(now / 1000)) },
      },
      await as(),
    )) as { data?: { items?: string[]; has_more?: boolean; page_token?: string } }
    ids.push(...(result.data?.items ?? []))
    if (!result.data?.has_more || !result.data.page_token) break
    pageToken = result.data.page_token
  }
  directCursor = now
  const messages: FeishuMessage[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    remember(id)
    const detail = (await client!.request({ method: 'GET', url: `/open-apis/im/v1/messages/${id}` }, await as())) as {
      data?: { items?: ListedMessage[] }
    }
    const item = detail.data?.items?.[0]
    const senderId = item?.sender?.id
    if (!item || item.deleted || !senderId || item.sender?.sender_type !== 'user' || senderId === self?.openId) continue
    const mentions = item.mentions ?? []
    const { text, images } = render(item.msg_type, item.body?.content ?? '', mentions)
    messages.push({
      messageId: item.message_id,
      rootId: item.root_id || item.message_id,
      parentId: item.parent_id || undefined,
      chatId: item.chat_id,
      chatType: 'p2p',
      senderId,
      text,
      mentionsBot: false,
      images,
      at: Number(item.create_time) || now,
    })
  }
  return messages.sort((a, b) => a.at - b.at)
}

const remember = (id: string): void => {
  seen.add(id)
  if (seen.size > 5000) seen.delete(seen.values().next().value as string)
}

// MARK: - Parsing

interface Mention {
  key: string
  name: string
  id?: { open_id?: string } | string
}

interface ReceiveEvent {
  sender?: { sender_id?: { open_id?: string }; sender_type?: string }
  message?: {
    message_id: string
    root_id?: string
    parent_id?: string
    chat_id: string
    chat_type: string
    message_type: string
    content: string
    create_time?: string
    mentions?: Mention[]
  }
}

function parse(event: ReceiveEvent, directOnly = false): FeishuMessage | undefined {
  const message = event.message
  const senderId = event.sender?.sender_id?.open_id
  // Other bots, and this one, talk in chats too; only people drive it.
  if (!message || !senderId || event.sender?.sender_type !== 'user') return undefined
  // Reading chats as you already covers the groups; the bot adds only its own direct messages.
  if (directOnly && message.chat_type !== 'p2p') return undefined
  if (seen.has(message.message_id)) return undefined
  remember(message.message_id)
  const mentions = message.mentions ?? []
  const { text, images } = render(message.message_type, message.content, mentions)
  const mentionsBot = !!self && mentions.some((mention) => mentionId(mention) === self?.openId)
  return {
    messageId: message.message_id,
    rootId: message.root_id || message.message_id,
    parentId: message.parent_id || undefined,
    chatId: message.chat_id,
    chatType: message.chat_type === 'p2p' ? 'p2p' : 'group',
    senderId,
    text,
    mentionsBot,
    images,
    at: Number(message.create_time) || Date.now(),
    toBot: message.chat_type === 'p2p',
    fromOwner: !!owner && senderId === owner,
  }
}

/** The person who authorized speaking as them; open ids are per app, so theirs matches the bot's events. */
let owner: string | undefined
const refreshOwner = (): void => {
  owner = authorizedUser()?.openId
}

const mentionId = (mention: Mention): string | undefined => (typeof mention.id === 'string' ? mention.id : mention.id?.open_id)

interface PostNode {
  tag: string
  text?: string
  href?: string
  user_name?: string
  user_id?: string
  image_key?: string
}

/** Text and post messages to plain text; anything else to a placeholder naming its kind. */
export function render(type: string, raw: string, mentions: Mention[]): { text: string; images: string[] } {
  let content: Record<string, unknown> = {}
  try {
    content = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { text: raw, images: [] }
  }
  const images: string[] = []
  const named = (text: string): string => mentions.reduce((result, mention) => result.split(mention.key).join(`@${mention.name}`), text)
  if (type === 'text') return { text: named(String(content.text ?? '')), images }
  if (type === 'image' && typeof content.image_key === 'string') {
    images.push(content.image_key)
    return { text: '[image 1]', images }
  }
  if (type === 'post') {
    // Received posts are `{title, content}`; fetched ones may still be keyed by language.
    const post = (content.content ? content : (Object.values(content)[0] ?? {})) as { title?: string; content?: PostNode[][] }
    const lines = (post.content ?? []).map((line) =>
      line
        .map((node) => {
          if (node.tag === 'text') return node.text ?? ''
          if (node.tag === 'a') return node.href ? `${node.text ?? ''} (${node.href})` : (node.text ?? '')
          if (node.tag === 'at') return `@${node.user_name ?? node.user_id ?? ''}`
          if (node.tag === 'img' && node.image_key) {
            images.push(node.image_key)
            return `[image ${images.length}]`
          }
          if (node.tag === 'code_block') return `\n${node.text ?? ''}\n`
          return node.text ?? ''
        })
        .join(''),
    )
    const text = [post.title, ...lines].filter(Boolean).join('\n')
    return { text: named(text), images }
  }
  return { text: `[${type}]`, images }
}

function describe(error: unknown): string {
  const response = (error as { response?: { data?: { msg?: string; code?: number } } }).response?.data
  if (response?.msg) return `${response.code ?? ''} ${response.msg}`.trim()
  return error instanceof Error ? error.message : String(error)
}
