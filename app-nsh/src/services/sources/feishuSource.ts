import type { AutopilotConfig, ChatMode, SourceStatus } from '../../shared/types'
import { t } from '../../shared/i18n'
import { attachmentMarker } from '../../shared/attachments'
import { errorMessage, log } from '../../core/log'
import { loadAutopilotConfig, saveAutopilotConfig } from '../../core/settingsStore'
import { truncate } from '../agentRunner'
import * as hub from '../autopilotHub'
import { ingest } from '../bus'
import * as feishu from '../feishu'
import type { Source } from './source'

/**
 * Feishu as a source. Its fast path, in code: which chats are listened to and how, who may drive it,
 * and what is too little to be a request. What passes goes to the bus.
 */

let changed: () => void = () => undefined
let running = false
let lastEventAt: number | undefined

export const feishuSource: Source & { reconnect(): Promise<void>; onChange(listener: () => void): void } = {
  id: 'feishu',
  onChange(listener) {
    changed = listener
  },
  async start() {
    running = true
    await this.reconnect()
  },
  stop() {
    running = false
    feishu.disconnect()
  },
  async reconnect() {
    if (!running) return
    try {
      await feishu.connect({
        config: loadAutopilotConfig(),
        listener: (message) => void onMessage(message).catch((error) => log.warn(`feishu message: ${errorMessage(error)}`)),
        changed,
        directs: () => loadAutopilotConfig().userDirectMode !== 'ignore',
        // Speaking as you, only the chats you switched on are read.
        chats: () =>
          Object.values(loadAutopilotConfig().chats)
            .filter((chat) => chat.mode !== 'ignore')
            .map((chat) => chat.id),
        discovered: (chats) => {
          const latest = loadAutopilotConfig()
          for (const chat of chats)
            latest.chats[chat.id] = {
              id: chat.id,
              name: chat.name,
              mode: latest.chats[chat.id]?.mode ?? 'ignore',
              seenAt: latest.chats[chat.id]?.seenAt ?? 0,
            }
          saveAutopilotConfig(latest)
        },
      })
    } catch (error) {
      log.warn(`feishu connect: ${errorMessage(error)}`)
    }
    changed()
  },
  status(): SourceStatus {
    const { state, error, bot } = feishu.status()
    const config = loadAutopilotConfig()
    const listening = Object.values(config.chats).filter((chat) => chat.mode !== 'ignore').length
    const states: Record<typeof state, SourceStatus['state']> = {
      off: 'off',
      noCredentials: 'setup',
      connecting: 'connecting',
      reconnecting: 'connecting',
      connected: 'online',
      failed: 'error',
    }
    const who = bot ? `${config.feishuIdentity === 'user' ? '' : '🤖 '}${bot.name}` : undefined
    return {
      id: 'feishu',
      state: states[state],
      detail: [who, `${listening} chats`].filter(Boolean).join(' · '),
      error,
      lastEventAt,
    }
  },
}

/** Where a chat stands, decided in code before any model sees the message. */
function chatMode(config: AutopilotConfig, chatId: string, direct: boolean): ChatMode {
  if (direct) return config.userDirectMode
  return config.chats[chatId]?.mode ?? config.unknownChatMode
}

/** Remember a chat the bot heard from, so it can be configured; a new one gets the default mode. */
async function noteChat(config: AutopilotConfig, chatId: string): Promise<void> {
  const known = config.chats[chatId]
  if (known && Date.now() - known.seenAt < 3_600_000) return
  const name = known?.name && known.name !== chatId ? known.name : await feishu.chatName(chatId)
  const latest = loadAutopilotConfig()
  latest.chats[chatId] = { id: chatId, name, mode: known?.mode ?? latest.unknownChatMode, seenAt: Date.now() }
  saveAutopilotConfig(latest)
}

/** Too little to be a request: an acknowledgement, an emoji, a sticker. */
const isNoise = (text: string): boolean =>
  text.replace(/\s|@\S+/g, '').length < 4 || /^\[(sticker|image|file|audio|media)\]$/.test(text.trim())

async function onMessage(message: feishu.FeishuMessage): Promise<void> {
  lastEventAt = Date.now()
  const config = loadAutopilotConfig()
  const direct = message.chatType === 'p2p'
  if (!direct) await noteChat(config, message.chatId)
  const thread = hub.feishuThread(message.chatId, message.rootId)
  const held = hub.holders(thread).length > 0
  // You, writing to the bot: always listened to, whatever the chat settings say.
  const owner = !!message.fromOwner && !!message.toBot
  // A direct message to the bot follows the bot's own setting; your direct messages, read as you,
  // follow theirs.
  const mode: ChatMode = owner
    ? 'mention'
    : message.toBot
      ? config.directMessages
        ? 'mention'
        : 'ignore'
      : chatMode(config, message.chatId, direct)
  const author = owner ? t('我') : await feishu.userName(message.senderId)
  // A forwarded conversation arrives as one message: spell it out, it's the point of the forward.
  if (message.text === '[merge_forward]') message.text = (await feishu.forwardedText(message.messageId, message.toBot)) ?? message.text

  const allowed = owner || !config.allowedUsers.length || config.allowedUsers.includes(message.senderId)
  // A topic an issue holds is that issue's conversation, mention or not; so is one the router is
  // talking in — an answer to its question doesn't @ it again.
  const talking = Date.now() - (hub.thread(thread)?.repliedAt ?? 0) < 86_400_000
  // "好的", "+1", a sticker: no reason to wake anyone, unless it was asked directly.
  const noise = isNoise(message.text) && !message.mentionsBot
  const wanted = mode !== 'ignore' && !noise && (held || talking || message.mentionsBot || mode === 'candidate')
  if (!allowed || !wanted) {
    hub.record({
      source: 'feishu',
      thread,
      author,
      text: message.text,
      outcome: 'ignored',
      detail: !allowed ? 'user not allowed' : noise ? 'noise' : `chat mode: ${mode}`,
    })
    changed()
    return
  }

  const chat = direct ? author : (config.chats[message.chatId]?.name ?? message.chatId)
  // The message this one answers: the context a reply makes no sense without.
  const parent = message.parentId ? await feishu.messageText(message.parentId, message.toBot) : undefined
  const images = (await Promise.all(message.images.map((key) => feishu.downloadImage(message.messageId, key, message.toBot)))).filter(
    (path): path is string => !!path,
  )
  const marked = message.text.replace(/\[image (\d+)\]/g, (_, n: string) => attachmentMarker(Number(n)))
  await ingest({
    source: 'feishu',
    thread,
    threadTitle: truncate(message.text.replace(/\s+/g, ' '), 60),
    replyTo: message.messageId,
    asBot: message.toBot,
    author,
    text: parent ? `(in reply to: ${truncate(parent, 400)})\n${message.text}` : message.text,
    agentText: `<message source="feishu" chat="${chat}" from="${author}">\n${marked}${parent ? `\n(in reply to: ${truncate(parent, 300)})` : ''}\n</message>`,
    images,
    attrs: {
      chat,
      from: author,
      // A direct message is addressed to whoever it went to — except yours, when read only for bugs.
      addressed: message.mentionsBot || talking || (direct && mode === 'mention') ? 'yes' : 'no',
      owner: owner ? 'yes' : '',
      images: images.length ? String(images.length) : '',
    },
  })
  changed()
}
