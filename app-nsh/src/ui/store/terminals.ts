import { randomUUID } from 'crypto'
import { api, on } from '../lib/api'
import { pref, setPref } from '../prefs'
import { createStore } from './base'

/**
 * The terminal dock, MonoCode style: a panel under the conversation with its own tabs. Terminals
 * group like chat tabs — each belongs to the issue that was selected when it opened (or to the
 * free-standing group) and shows only there. The shells live in the services; this is the tab
 * list, which doesn't outlive the app (the shells don't either).
 */
export interface Term {
  id: string
  /** Issue record id, or '' for the free-standing group. */
  group: string
  cwd: string
  title: string
  exited: boolean
}

const KEY = 'teabranch.terminalDock'
const DEFAULT_HEIGHT = 280

const loadDock = (): { open: boolean; height: number } => {
  const saved = pref<{ open?: unknown; height?: unknown }>(KEY, {})
  return { open: saved.open === true, height: typeof saved.height === 'number' ? saved.height : DEFAULT_HEIGHT }
}
const saveDock = (dock: { open: boolean; height: number }): void => setPref(KEY, dock)

interface TerminalsState {
  open: boolean
  height: number
  terms: Term[]
  /** Per group, the terminal in front. */
  active: Record<string, string>
  /** Bumped to ask the dock for a new terminal in the current place (⌘`). */
  addRequest: number
  /** Bumped to show or hide the dock (⌘J); the dock decides, as it knows what's showing. */
  toggleRequest: number
}

export const DEFAULT_DOCK_HEIGHT = DEFAULT_HEIGHT

const fields = createStore<TerminalsState>({ ...loadDock(), terms: [], active: {}, addRequest: 0, toggleRequest: 0 })

export const terminals = {
  ...fields,

  toggle(): void {
    fields.set({ toggleRequest: fields.toggleRequest() + 1 })
  },

  setOpen(open: boolean): void {
    fields.set({ open })
    saveDock({ open, height: fields.height() })
  },

  setHeight(height: number, persist = true): void {
    fields.set({ height })
    if (persist) saveDock({ open: fields.open(), height })
  },

  add(group: string, cwd: string): void {
    const id = randomUUID()
    const name = cwd.split('/').pop() || cwd
    fields.set({ terms: [...fields.terms(), { id, group, cwd, title: name, exited: false }], active: { ...fields.active(), [group]: id } })
    terminals.setOpen(true)
  },

  select(group: string, id: string): void {
    fields.set({ active: { ...fields.active(), [group]: id } })
  },

  close(id: string): void {
    const terms = fields.terms()
    const active = fields.active()
    const term = terms.find((candidate) => candidate.id === id)
    if (!term) return
    void api.terminalKill(id)
    const siblings = terms.filter((candidate) => candidate.group === term.group)
    const index = siblings.findIndex((candidate) => candidate.id === id)
    const rest = siblings.filter((candidate) => candidate.id !== id)
    const next = { ...active }
    if (active[term.group] === id) {
      const neighbour = rest[Math.min(index, rest.length - 1)]
      if (neighbour) next[term.group] = neighbour.id
      else delete next[term.group]
    }
    fields.set({ terms: terms.filter((candidate) => candidate.id !== id), active: next })
    // The last terminal of the group closed: fold the dock away, like MonoCode.
    if (!rest.length) terminals.setOpen(false)
  },

  closeOthers(id: string): void {
    const term = fields.terms().find((candidate) => candidate.id === id)
    if (!term) return
    for (const other of fields.terms()) if (other.group === term.group && other.id !== id) terminals.close(other.id)
  },

  move(id: string, before: string | null): void {
    const term = fields.terms().find((candidate) => candidate.id === id)
    if (!term) return
    const rest = fields.terms().filter((candidate) => candidate.id !== id)
    const at = before ? rest.findIndex((candidate) => candidate.id === before) : -1
    fields.set({ terms: at < 0 ? [...rest, term] : [...rest.slice(0, at), term, ...rest.slice(at)] })
  },
}

const patch = (id: string, change: Partial<Term>) =>
  fields.set({ terms: fields.terms().map((term) => (term.id === id ? { ...term, ...change } : term)) })

on('terminalTitle', ({ id, title }) => patch(id, { title }))
on('terminalExit', ({ id }) => patch(id, { exited: true }))
on('menu', (action) => {
  if (action === 'toggleTerminal') terminals.toggle()
  if (action === 'newTerminal') fields.set({ addRequest: fields.addRequest() + 1 })
})
