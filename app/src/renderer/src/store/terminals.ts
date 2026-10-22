import { create } from 'zustand'
import { api, on } from '@/lib/api'

/**
 * The terminal dock, MonoCode style: a panel under the conversation with its own tabs. Terminals
 * group like chat tabs — each belongs to the issue that was selected when it opened (or to the
 * free-standing group) and shows only there. The shells live in the main process; this is the
 * tab list, which doesn't outlive the app (the shells don't either).
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
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return { open: saved.open === true, height: typeof saved.height === 'number' ? saved.height : DEFAULT_HEIGHT }
  } catch {
    return { open: false, height: DEFAULT_HEIGHT }
  }
}

const saveDock = (dock: { open: boolean; height: number }): void => {
  try {
    localStorage.setItem(KEY, JSON.stringify(dock))
  } catch {
    // Not persisted; the dock just starts closed next time.
  }
}

interface TerminalsStore {
  open: boolean
  height: number
  terms: Term[]
  /** Per group, the terminal in front. */
  active: Record<string, string>
  /** Bumped to ask the dock for a new terminal in the current place (⌘`). */
  addRequest: number
  /** Bumped to show or hide the dock (⌘J); the dock decides, as it knows what's showing. */
  toggleRequest: number
  toggle(): void
  setOpen(open: boolean): void
  setHeight(height: number, persist?: boolean): void
  add(group: string, cwd: string): void
  select(group: string, id: string): void
  close(id: string): void
  closeOthers(id: string): void
  move(id: string, before: string | null): void
}

export const DEFAULT_DOCK_HEIGHT = DEFAULT_HEIGHT

export const useTerminals = create<TerminalsStore>((set, get) => ({
  ...loadDock(),
  terms: [],
  active: {},
  addRequest: 0,
  toggleRequest: 0,

  toggle() {
    set({ toggleRequest: get().toggleRequest + 1 })
  },

  setOpen(open) {
    set({ open })
    saveDock({ open, height: get().height })
  },

  setHeight(height, persist = true) {
    set({ height })
    if (persist) saveDock({ open: get().open, height })
  },

  add(group, cwd) {
    const id = crypto.randomUUID()
    const name = cwd.split('/').pop() || cwd
    set({ terms: [...get().terms, { id, group, cwd, title: name, exited: false }], active: { ...get().active, [group]: id } })
    get().setOpen(true)
  },

  select(group, id) {
    set({ active: { ...get().active, [group]: id } })
  },

  close(id) {
    const { terms, active } = get()
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
    set({ terms: terms.filter((candidate) => candidate.id !== id), active: next })
    // The last terminal of the group closed: fold the dock away, like MonoCode.
    if (!rest.length) get().setOpen(false)
  },

  closeOthers(id) {
    const term = get().terms.find((candidate) => candidate.id === id)
    if (!term) return
    for (const other of get().terms) if (other.group === term.group && other.id !== id) get().close(other.id)
  },

  move(id, before) {
    const term = get().terms.find((candidate) => candidate.id === id)
    if (!term) return
    const rest = get().terms.filter((candidate) => candidate.id !== id)
    const at = before ? rest.findIndex((candidate) => candidate.id === before) : -1
    set({ terms: at < 0 ? [...rest, term] : [...rest.slice(0, at), term, ...rest.slice(at)] })
  },
}))

const patch = (id: string, change: Partial<Term>) =>
  useTerminals.setState({ terms: useTerminals.getState().terms.map((term) => (term.id === id ? { ...term, ...change } : term)) })

on('terminalTitle', ({ id, title }) => patch(id, { title }))
on('terminalExit', ({ id }) => patch(id, { exited: true }))
on('menu', (action) => {
  const store = useTerminals.getState()
  if (action === 'toggleTerminal') store.toggle()
  if (action === 'newTerminal') useTerminals.setState({ addRequest: store.addRequest + 1 })
})
