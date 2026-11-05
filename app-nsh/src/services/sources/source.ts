import type { SourceId, SourceStatus } from '../../shared/types'

/**
 * Where autopilot's events come from: the issue table, Feishu, GitHub — and whatever comes next.
 * A source watches its own channel and runs its own fast path in code (which chats, which people,
 * which statuses), then hands what passed to the bus as `SourceEvent`s. The bus decides the rest the
 * same way for every source: straight to the agent holding the thread, or to the router.
 */
export interface Source {
  id: SourceId
  start(): Promise<void>
  stop(): void
  status(): SourceStatus
}

export interface SourceEvent {
  source: SourceId
  /** The conversation it belongs to: a Feishu topic, a PR, an issue's own record. */
  thread: string
  threadTitle: string
  /** Where a reply goes, when that isn't the thread itself — the newest message of a topic. */
  replyTo?: string
  /** Replies here go out as the app's bot even while it speaks as you elsewhere: its own direct messages. */
  asBot?: boolean
  author?: string
  /** What happened, as the feed shows it and the router reads it. */
  text: string
  /** The same for an issue's agent, when it reads differently — wrapped as a <message>. */
  agentText?: string
  /** Local files that came with it: a chat's screenshots. */
  images?: string[]
  /** The router's <event> attributes: chat, sender, whether it was addressed to it. */
  attrs?: Record<string, string>
  /** The issue it is about, when the source knows: a record, a PR. */
  recordId?: string
  /** Settled in code by a rule you set — the router only hears about it. */
  direct?: { describe: string; run(): void }
  /** Worth the router knowing, never worth a turn of its own. */
  fyi?: boolean
}
