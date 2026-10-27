import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentMessage, shownMessage } from '@shared/attachments'
import { t } from '@shared/i18n'
import type { AgentAccess, AgentModel, Chat, ConversationEntry, QueuedMessage } from '@shared/types'
import { state } from '../core/appState'
import { emit } from '../core/events'
import { TeaBranchError } from '../core/log'
import { deleteChatTranscript, loadChats, loadChatTranscript, loadTeableConfig, saveChats, saveChatTranscript } from '../core/settingsStore'
import { entry, type Handle, runClaude } from './agentRunner'
import { uploadsDir } from './issueContext'

/**
 * Free-standing AI conversations: a new Claude Code session in a checkout you pick, with no issue
 * behind it. Each chat keeps one session and resumes it, like an issue's agent does.
 */
class ChatAgent {
  private chats: Record<string, Chat> = loadChats()
  private transcripts = new Map<string, ConversationEntry[]>()
  private handles = new Map<string, Handle>()
  private dirty = new Set<string>()
  private flushTimer: NodeJS.Timeout | null = null

  constructor() {
    // A process that was running when the app quit died with it.
    for (const chat of Object.values(this.chats)) {
      chat.running = false
      chat.background = undefined
    }
  }

  runningCount = (): number => this.handles.size

  list(): Chat[] {
    return Object.values(this.chats).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  transcript(id: string): ConversationEntry[] {
    let list = this.transcripts.get(id)
    if (!list) {
      list = loadChatTranscript(id)
      this.transcripts.set(id, list)
    }
    return list
  }

  create(workspace: { cwd: string; branch?: string; issueId?: string }): Chat {
    if (!existsSync(workspace.cwd)) throw new TeaBranchError(t('找不到目录 {path}', { path: workspace.cwd }))
    const now = Date.now()
    const chat: Chat = {
      id: randomUUID(),
      title: t('新对话'),
      cwd: workspace.cwd,
      branch: workspace.branch,
      issueId: workspace.issueId,
      sessionId: randomUUID(),
      costUSD: 0,
      running: false,
      createdAt: now,
      updatedAt: now,
    }
    this.chats[chat.id] = chat
    this.changed()
    return chat
  }

  update(id: string, patch: { model?: AgentModel | null; access?: AgentAccess | null; title?: string }): void {
    const chat = this.get(id)
    if (patch.model !== undefined) chat.model = patch.model ?? undefined
    if (patch.access !== undefined) chat.access = patch.access ?? undefined
    if (patch.title?.trim()) chat.title = patch.title.trim()
    this.changed()
  }

  /** From the composer: sent now when idle; while a turn runs, queued for after it or steered into it. */
  say(id: string, message: string, attachments: string[] = [], steer = false): void {
    const chat = this.get(id)
    if (!this.handles.has(id)) return this.send(id, message, attachments)
    const queued: QueuedMessage = { id: randomUUID(), text: message, attachments }
    chat.queued = [...(chat.queued ?? []), queued]
    this.changed()
    if (steer) this.steer(id, queued.id)
  }

  /** A queued message, now: into the running turn, or as the next turn when there is none. */
  steer(id: string, queuedId: string): void {
    const chat = this.get(id)
    const queued = chat.queued?.find((candidate) => candidate.id === queuedId)
    if (!queued) return
    const handle = this.handles.get(id)
    // Too late for this turn: it stays queued and goes out the moment the turn ends.
    if (handle && !handle.steer?.(agentMessage(queued.text, queued.attachments))) return
    this.unqueue(id, queuedId)
    if (handle) this.append(id, entry('user', 'agent', shownMessage(queued.text, queued.attachments)))
    else this.send(id, queued.text, queued.attachments)
  }

  unqueue(id: string, queuedId: string): void {
    const chat = this.get(id)
    chat.queued = chat.queued?.filter((candidate) => candidate.id !== queuedId)
    this.changed()
  }

  private send(id: string, message: string, attachments: string[] = []): void {
    const chat = this.get(id)
    this.append(id, entry('user', 'agent', shownMessage(message, attachments)))
    if (untitled.has(chat.title)) chat.title = message.replace(/\s+/g, ' ').slice(0, 40)
    chat.running = true
    chat.updatedAt = Date.now()
    this.changed()

    const config = loadTeableConfig()
    const uploads = uploadsDir(`chat-${id}`)
    const handle = runClaude({
      prompt: agentMessage(message, attachments),
      cwd: chat.cwd,
      session: { kind: sessionExists(chat.sessionId, chat.cwd) ? 'resume' : 'new', id: chat.sessionId },
      model: chat.model ?? config.fixModel,
      access: chat.access ?? config.access,
      baseCommand: state.settings.agentCommand,
      extraArgs: existsSync(uploads) ? ['--add-dir', uploads] : [],
      channel: 'agent',
      onEntry: (line) => this.append(id, line),
      onContext: (used) => {
        const current = this.chats[id]
        if (!current) return
        current.context = { used, window: current.context?.window }
        this.changed()
      },
      onBackground: (tasks) => {
        const current = this.chats[id]
        if (!current) return
        current.background = tasks.length ? tasks : undefined
        this.changed()
      },
      // Waiting on background tasks: what was typed during the turn goes in now.
      onIdle: () => {
        const next = this.chats[id]?.queued?.[0]
        if (next) this.steer(id, next.id)
      },
      onExit: (outcome) => {
        this.handles.delete(id)
        const current = this.chats[id]
        if (!current) return
        current.running = false
        current.background = undefined
        current.costUSD += outcome.costUSD
        if (outcome.contextWindow) current.context = { used: current.context?.used ?? 0, window: outcome.contextWindow }
        current.updatedAt = Date.now()
        if (outcome.cancelled) this.append(id, entry('system', 'agent', t('已停止')))
        else if (outcome.isError && !outcome.finalText) this.append(id, entry('error', 'agent', outcome.diagnosis ?? t('agent 异常退出')))
        this.changed()
        // What was typed during the turn goes next. After a stop it waits for you instead.
        const next = current.queued?.[0]
        if (next && !outcome.cancelled) this.steer(id, next.id)
      },
    })
    this.handles.set(id, handle)
  }

  cancel(id: string): void {
    this.handles.get(id)?.cancel()
  }

  delete(id: string): void {
    this.cancel(id)
    delete this.chats[id]
    this.transcripts.delete(id)
    deleteChatTranscript(id)
    this.changed()
  }

  /** Persist pending transcript lines now (on quit). */
  flush(): void {
    for (const id of this.dirty) if (this.chats[id]) saveChatTranscript(id, this.transcript(id))
    this.dirty.clear()
    saveChats(this.chats)
  }

  private get(id: string): Chat {
    const chat = this.chats[id]
    if (!chat) throw new TeaBranchError(t('找不到这个对话'))
    return chat
  }

  private append(id: string, line: ConversationEntry): void {
    this.transcript(id).push(line)
    emit('chatTranscript', { chatId: id, entries: [line] })
    this.dirty.add(id)
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, 1000)
  }

  private changed(): void {
    saveChats(this.chats)
    emit('chatsChanged', undefined)
  }
}

/** A new chat's placeholder title, in either language: the first message replaces it. */
const untitled = new Set(['新对话', 'New Chat', 'New chat']) // i18n-ignore

function sessionExists(sessionId: string, cwd: string): boolean {
  let resolved = cwd
  try {
    resolved = realpathSync(cwd)
  } catch {
    // Use as is.
  }
  return existsSync(join(homedir(), '.claude/projects', resolved.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`))
}

export const chatAgent = new ChatAgent()
