import { ChevronDown, Plus, SquareTerminal, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ContextMenuArea } from '@/components/kit'
import { cn } from '@/lib/utils'
import { useIssues } from '@/store/issues'
import { currentGroup } from '@/store/tabs'
import { DEFAULT_DOCK_HEIGHT, useTerminals } from '@/store/terminals'
import { useHere } from '../issues/place'
import { TerminalView } from './TerminalView'

const MIN_HEIGHT = 120
const clamp = (height: number) => Math.round(Math.min(Math.max(height, MIN_HEIGHT), window.innerHeight - 180))

/**
 * MonoCode's terminal dock: under the conversation, its own tabs, drag the top edge to resize
 * (double-click resets), ⌘J to show or hide, ⌘` for another terminal. Each group — the selected
 * issue, or the free-standing chats — has its own terminals, opened where "here" is.
 */
export function TerminalDock() {
  const { open, height, terms, active, addRequest, toggleRequest, setOpen, setHeight, add, select, close, closeOthers, move } =
    useTerminals()
  const selection = useIssues((s) => s.selection)
  const { place } = useHere()
  const group = currentGroup(selection) ?? ''
  const mine = terms.filter((term) => term.group === group)
  const front = mine.find((term) => term.id === active[group]) ?? mine[0]
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null)
  const drag = useRef<{ y: number; height: number } | null>(null)

  const addHere = () => place && add(group, place.cwd)

  // ⌘J hides what shows, or shows the dock — starting a shell here when the group has none, as does
  // ⌘`. Browsing to an issue without terminals just shows none: a shell per issue clicked would be
  // a surprise.
  const lastToggle = useRef(toggleRequest)
  useEffect(() => {
    if (toggleRequest === lastToggle.current) return
    lastToggle.current = toggleRequest
    if (open && mine.length) setOpen(false)
    else if (mine.length) setOpen(true)
    else addHere()
  }, [toggleRequest])
  const lastAdd = useRef(addRequest)
  useEffect(() => {
    if (addRequest === lastAdd.current) return
    lastAdd.current = addRequest
    addHere()
  }, [addRequest])

  if (!mine.length) return null
  return (
    <section className={cn('relative flex shrink-0 flex-col border-t bg-background', !open && 'hidden')} style={{ height }}>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整终端高度"
        className="no-drag absolute inset-x-0 -top-[3px] z-10 h-1.5 cursor-row-resize hover:bg-brand/30"
        onPointerDown={(event) => {
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { y: event.clientY, height }
        }}
        onPointerMove={(event) => {
          if (drag.current) setHeight(clamp(drag.current.height + drag.current.y - event.clientY), false)
        }}
        onPointerUp={() => {
          drag.current = null
          setHeight(height)
        }}
        onDoubleClick={() => setHeight(DEFAULT_DOCK_HEIGHT)}
      />
      <div className="flex h-8 shrink-0 items-center gap-0.5 px-2">
        {mine.map((term, index) => {
          const isFront = term.id === front?.id
          return (
            <ContextMenuArea
              key={term.id}
              entries={() => [
                { label: '关闭', onSelect: () => close(term.id) },
                { label: '关闭其他终端', disabled: mine.length < 2, onSelect: () => closeOthers(term.id) },
              ]}
            >
              <div
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', term.id)
                  setDragging(term.id)
                }}
                onDragOver={(event) => {
                  if (!dragging || dragging === term.id) return
                  event.preventDefault()
                  const box = event.currentTarget.getBoundingClientRect()
                  setOver({ id: term.id, after: event.clientX > box.left + box.width / 2 })
                }}
                onDragLeave={() => setOver((current) => (current?.id === term.id ? null : current))}
                onDrop={(event) => {
                  event.preventDefault()
                  if (dragging && dragging !== term.id && over) move(dragging, over.after ? (mine[index + 1]?.id ?? null) : term.id)
                  setDragging(null)
                  setOver(null)
                }}
                onDragEnd={() => {
                  setDragging(null)
                  setOver(null)
                }}
                onClick={() => select(group, term.id)}
                onAuxClick={(event) => event.button === 1 && close(term.id)}
                title={term.cwd}
                className={cn(
                  'group flex h-6 max-w-48 min-w-0 cursor-default items-center gap-1.5 rounded-md pr-0.5 pl-2 text-[11.5px] transition-colors',
                  isFront ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                  term.exited && 'opacity-60',
                  dragging === term.id && 'opacity-40',
                  over?.id === term.id &&
                    (over.after ? 'shadow-[inset_-2px_0_0_var(--color-brand)]' : 'shadow-[inset_2px_0_0_var(--color-brand)]'),
                )}
              >
                <SquareTerminal className="size-3 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{term.title}</span>
                <button
                  type="button"
                  aria-label="关闭终端"
                  onClick={(event) => {
                    event.stopPropagation()
                    close(term.id)
                  }}
                  className={cn(
                    'grid size-4.5 shrink-0 place-items-center rounded hover:bg-foreground/10',
                    isFront ? 'opacity-70' : 'opacity-0 group-hover:opacity-70',
                  )}
                >
                  <X className="size-3" />
                </button>
              </div>
            </ContextMenuArea>
          )
        })}
        <button
          type="button"
          title={place ? `新终端 · ${place.label}（⌘\`）` : '新终端'}
          disabled={!place}
          onClick={addHere}
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          <Plus className="size-3.5" />
        </button>
        <div className="flex-1" />
        <button
          type="button"
          title="隐藏终端（⌘J）"
          onClick={() => setOpen(false)}
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronDown className="size-3.5" />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        {mine.map((term) => (
          <div key={term.id} className={term.id === front?.id ? 'absolute inset-0' : 'hidden'}>
            <TerminalView id={term.id} cwd={term.cwd} active={open && term.id === front?.id} />
          </div>
        ))}
      </div>
    </section>
  )
}

/** The tab bar's toggle for the dock, lit while it shows. */
export function TerminalToggle() {
  const group = currentGroup(useIssues((s) => s.selection)) ?? ''
  const open = useTerminals((s) => s.open && s.terms.some((term) => term.group === group))
  const toggle = useTerminals((s) => s.toggle)
  return (
    <button
      type="button"
      title={open ? '隐藏终端（⌘J）' : '终端（⌘J）'}
      onClick={toggle}
      className={cn(
        'no-drag mb-1 grid size-7 shrink-0 place-items-center rounded-lg hover:bg-accent hover:text-foreground',
        open ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      <SquareTerminal className="size-4" />
    </button>
  )
}
