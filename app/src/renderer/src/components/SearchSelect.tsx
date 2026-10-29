import { Check, ChevronsUpDown, Search } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export interface SearchOption {
  id: string
  name: string
  /** Options sharing a group sit under its heading, in the order they came. */
  group?: string
}

/**
 * A select you can type into: a field that opens a filtered list, ↑↓ to move, ⏎ to pick. For lists
 * too long to scroll through — every base in every space — where the native select gives up.
 */
export function SearchSelect({
  options,
  value,
  onChange,
  placeholder = t('选择…'),
  none,
  disabled,
  icon,
}: {
  /** null while loading. */
  options: SearchOption[] | null
  value: string | undefined
  onChange: (id: string | undefined) => void
  placeholder?: string
  /** An entry for "nothing", listed first: picking it clears the value. */
  none?: string
  disabled?: boolean
  icon?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  const selected = options?.find((option) => option.id === value)
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = (options ?? []).filter(
      (option) =>
        !needle ||
        option.name.toLowerCase().includes(needle) ||
        option.group?.toLowerCase().includes(needle) ||
        option.id.toLowerCase() === needle,
    )
    return none && !needle ? [{ id: '', name: none }, ...matches] : matches
  }, [options, query, none])

  // Keep the highlighted row in view as the arrows move it.
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const pick = (option: SearchOption | undefined) => {
    if (!option) return
    onChange(option.id || undefined)
    setOpen(false)
  }

  const label = selected ? selected.name : value ? value : !options && !disabled ? t('加载中…') : disabled ? '—' : (none ?? placeholder)

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setQuery('')
          setActive(
            Math.max(
              0,
              shown.findIndex((option) => option.id === (value ?? '')),
            ),
          )
        }
      }}
    >
      <PopoverTrigger
        disabled={disabled || !options}
        render={
          <button
            type="button"
            className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-transparent px-2.5 text-left text-[13px] shadow-xs outline-none hover:bg-fill-hover focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent dark:bg-input/30"
          >
            {icon}
            <span
              className={cn('min-w-0 flex-1 truncate', !selected && !value && 'text-muted-foreground', !selected && value && 'font-mono')}
            >
              {label}
            </span>
            {selected?.group && <span className="max-w-[40%] shrink-0 truncate text-[11.5px] text-fg-3">{selected.group}</span>}
            <ChevronsUpDown className="size-3.5 shrink-0 text-fg-3" />
          </button>
        }
      />
      <PopoverContent className="flex w-(--anchor-width) min-w-64 flex-col overflow-hidden p-0" sideOffset={4}>
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-2.5">
          <Search className="size-3.5 shrink-0 text-fg-3" />
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'ArrowDown') setActive((index) => Math.min(shown.length - 1, index + 1))
              else if (event.key === 'ArrowUp') setActive((index) => Math.max(0, index - 1))
              else if (event.key === 'Enter') pick(shown[active])
              else return
              event.preventDefault()
            }}
            placeholder={t('搜索')}
            className="selectable min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-3"
          />
        </div>
        <div ref={list} className="max-h-72 overflow-y-auto py-1">
          {shown.length === 0 && <div className="px-3 py-2 text-[12.5px] text-fg-3">{t('没有匹配的')}</div>}
          {shown.map((option, index) => {
            const heading = option.group && option.group !== shown[index - 1]?.group
            return (
              <div key={option.id || '-'}>
                {heading && (
                  <div className="px-3 pt-2 pb-1 text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase">{option.group}</div>
                )}
                <button
                  type="button"
                  data-index={index}
                  onMouseMove={() => setActive(index)}
                  onClick={() => pick(option)}
                  className={cn(
                    'flex h-8 w-full items-center gap-2 px-3 text-left text-[13px]',
                    index === active && 'bg-fill-hover',
                    !option.id && 'text-muted-foreground',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{option.name}</span>
                  {option.id === (value ?? '') && <Check className="size-3.5 shrink-0 text-brand" />}
                </button>
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
