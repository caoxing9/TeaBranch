import { errorMessage } from '../core/log'
import * as hub from './autopilotHub'
import { issueAgent } from './issueAgent'
import * as router from './router'
import type { SourceEvent } from './sources/source'

/**
 * Where every source's events meet, once its own filter let them through. Routing is the same for
 * all of them, cheapest first:
 *
 * 1. A rule settled it in code (a status that means "fix") — run it; the router only hears of it.
 * 2. An issue's agent holds the thread — straight to that agent, no model in between.
 * 3. Only worth knowing — noted for the router's next turn, never a turn of its own.
 * 4. Anything else — the router decides.
 */
export async function ingest(event: SourceEvent): Promise<void> {
  hub.touchThread(event.thread, event.threadTitle, event.replyTo, event.asBot)
  const base = { source: event.source, thread: event.thread, author: event.author, text: event.text, recordId: event.recordId }
  const fyi = (id: string, task?: string): void =>
    router.push({
      id,
      source: event.source,
      thread: event.thread,
      attrs: { ...event.attrs, task: task ?? '' },
      text: event.text,
      fyi: true,
    })

  if (event.direct) {
    const item = hub.record({ ...base, outcome: 'action', detail: event.direct.describe })
    try {
      event.direct.run()
    } catch (error) {
      hub.annotate(item.id, { outcome: 'error', detail: `${event.direct.describe}: ${errorMessage(error)}` })
    }
    fyi(item.id)
    return
  }

  const holders = hub.holders(event.thread)
  if (holders.length) {
    const item = hub.record({ ...base, outcome: 'delivered', recordId: holders[0] })
    hub.setEventFiles(item.id, event.images ?? [])
    for (const recordId of holders) {
      await issueAgent
        .deliver(recordId, event.agentText ?? event.text, event.images ?? [], event.text)
        .catch((error) => hub.record({ ...base, outcome: 'error', detail: errorMessage(error), recordId }))
    }
    fyi(item.id, holders.map((id) => issueAgent.allRuns()[id]?.issueKey ?? id).join(', '))
    return
  }

  if (event.fyi) {
    fyi(hub.record({ ...base, outcome: 'ignored', detail: 'noted' }).id)
    return
  }

  const item = hub.record({ ...base, outcome: 'routed' })
  hub.setEventFiles(item.id, event.images ?? [])
  router.push({ id: item.id, source: event.source, thread: event.thread, attrs: event.attrs ?? {}, text: event.text })
}
