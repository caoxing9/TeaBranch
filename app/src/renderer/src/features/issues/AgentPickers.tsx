import { Popover } from '@base-ui/react/popover'
import { Check, ChevronDown, ChevronRight, Cpu, Lock, Pencil, Search, Shield, Sparkles, Star } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import type { AgentAccess, AgentEffort, AgentModel, ClaudeCatalog } from '@shared/types'
import { agentAccessModes, agentEffortLabel, agentEfforts } from '@shared/types'
import claudeIcon from '@/assets/claude.svg'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useIssues } from '@/store/issues'

/**
 * The composer's model and access pickers, after MonoCode's: a pill showing `Opus 5.5 High`, a
 * menu with Effort and Model rows that fly out to the right, and an access pill whose menu
 * explains each mode.
 */

// MARK: - Catalog

export const useCatalog = create<{ catalog: ClaudeCatalog | null; error: string | null; load: () => Promise<void> }>((set, get) => ({
  catalog: null,
  error: null,
  load: async () => {
    if (get().catalog) return
    try {
      set({ catalog: await api.claudeCatalog(), error: null })
    } catch (error) {
      set({ error: String((error as Error).message ?? error) })
    }
  },
}))

/** "Opus 5.5" for `claude-opus-5-5` or `opus`; gateway model ids stay as they are. */
export function modelDisplayName(id: string, catalog: ClaudeCatalog | null): string {
  const listed = catalog?.models.find((option) => option.value === id || option.resolved === id)
  if (listed) return listed.name
  const match = /^claude-([a-z]+)-(\d+(?:-\d+)?)/.exec(id)
  if (!match) return id
  return `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2].replace('-', '.')}`
}

const FAVORITES_KEY = 'teabranch.favoriteModels'
const modelKey = (m: AgentModel) => `${m.provider}:${m.model ?? ''}`

function loadFavorites(): string[] {
  try {
    return JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? '[]')
  } catch {
    return []
  }
}

function saveFavorites(favorites: string[]): void {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites))
  } catch {
    // Storage blocked: favourites just won't persist.
  }
}

export const ClaudeMark = ({ className }: { className?: string }) => (
  <img src={claudeIcon} alt="" aria-hidden className={cn('size-3.5 shrink-0', className)} />
)

const ProviderIcon = ({ provider, className }: { provider: AgentModel['provider']; className?: string }) =>
  provider === 'claude' ? <ClaudeMark className={className} /> : <Cpu className={cn('size-3.5 shrink-0 text-muted-foreground', className)} />

/** What a model is called in the picker: the CLI's display name when it is known. */
function nameOf(model: AgentModel, catalog: ClaudeCatalog | null): string {
  if (model.provider === 'magpie') return model.model ?? 'Magpie'
  if (!model.model) return catalog?.defaultName ?? 'Claude'
  return catalog?.models.find((option) => option.value === model.model)?.name ?? model.model[0].toUpperCase() + model.model.slice(1)
}

function effortsOf(model: AgentModel, catalog: ClaudeCatalog | null): AgentEffort[] {
  if (model.provider !== 'claude' || !catalog) return agentEfforts.map((option) => option.value)
  const listed = catalog.models.find((option) => option.value === model.model) ?? catalog.models.find((option) => option.name === catalog.defaultName)
  return listed?.efforts.length ? listed.efforts : agentEfforts.map((option) => option.value)
}

const pillClass =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12px] text-foreground/90 transition-colors hover:bg-accent data-[popup-open]:bg-accent'

const popupClass =
  '[&_button]:outline-none relative rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg outline-none data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 transition-opacity duration-100'

// MARK: - Model

export function ModelPicker({ model, onChange }: { model?: AgentModel; onChange: (next: AgentModel | null) => void }) {
  const fixModel = useIssues((s) => s.config?.fixModel)
  const { catalog, load } = useCatalog()
  const [open, setOpen] = useState(false)
  const [fly, setFly] = useState<'effort' | 'model' | null>(null)

  useEffect(() => void load(), [load])

  const current = model ?? fixModel ?? { provider: 'claude' as const }
  const shownEffort = current.effort ?? (current.provider === 'claude' ? catalog?.defaultEffort : undefined)
  const choose = (next: AgentModel | null) => {
    onChange(next)
    setOpen(false)
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) void load()
        if (!next) setFly(null)
      }}
    >
      <Popover.Trigger className={pillClass} title="模型与思考等级">
        <ProviderIcon provider={current.provider} />
        <span className="whitespace-nowrap">{nameOf(current, catalog)}</span>
        {shownEffort && <span className="text-muted-foreground">{agentEffortLabel(shownEffort)}</span>}
        <ChevronDown className={cn('size-3 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={6} className="z-50">
          <Popover.Popup className={cn(popupClass, 'w-[250px]')}>
            <MenuRow
              active={fly === 'effort'}
              onEnter={() => setFly('effort')}
              label="Effort"
              value={agentEffortLabel(shownEffort) ?? '默认'}
            />
            <MenuRow
              active={fly === 'model'}
              onEnter={() => setFly('model')}
              label="Model"
              value={
                <>
                  <ProviderIcon provider={current.provider} />
                  <span className="truncate">{nameOf(current, catalog)}</span>
                </>
              }
            />
            {model && (
              <>
                <div className="mx-2 my-1 h-px bg-border" />
                <button
                  type="button"
                  onMouseEnter={() => setFly(null)}
                  onClick={() => choose(null)}
                  className="flex h-8 w-full items-center rounded-lg px-2 text-left text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  恢复默认
                </button>
              </>
            )}

            {fly === 'effort' && (
              <Flyout className="w-[210px]">
                {effortsOf(current, catalog).map((effort) => (
                  <button
                    key={effort}
                    type="button"
                    onClick={() => choose({ ...current, effort })}
                    className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] hover:bg-accent"
                  >
                    <span className="flex-1">{agentEffortLabel(effort)}</span>
                    {shownEffort === effort && <Check className="size-3.5 text-muted-foreground" />}
                  </button>
                ))}
              </Flyout>
            )}
            {fly === 'model' && (
              <Flyout className="w-[330px] p-0">
                <ModelList
                  current={current}
                  catalog={catalog}
                  onPick={(picked) => {
                    const efforts = effortsOf(picked, catalog)
                    choose({ ...picked, effort: current.effort && efforts.includes(current.effort) ? current.effort : undefined })
                  }}
                />
              </Flyout>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function MenuRow({ label, value, active, onEnter }: { label: string; value: ReactNode; active: boolean; onEnter: () => void }) {
  return (
    <button
      type="button"
      onMouseEnter={onEnter}
      onClick={onEnter}
      className={cn('flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] outline-none', active ? 'bg-accent' : 'hover:bg-accent')}
    >
      <span className="flex-1">{label}</span>
      <span className="flex max-w-36 min-w-0 items-center gap-1 text-muted-foreground">{value}</span>
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/70" />
    </button>
  )
}

/** A submenu hung off the popup's right edge, bottom-aligned so it grows upward like the menu. */
const Flyout = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn('absolute bottom-0 left-full ml-1.5 rounded-xl border bg-popover p-1 shadow-lg', className)}>{children}</div>
)

type Tab = 'favorites' | 'claude' | 'magpie'

function ModelList({ current, catalog, onPick }: { current: AgentModel; catalog: ClaudeCatalog | null; onPick: (m: AgentModel) => void }) {
  const magpie = useIssues((s) => s.magpieModels)
  const magpieError = useIssues((s) => s.magpieError)
  const loadMagpieModels = useIssues((s) => s.loadMagpieModels)
  const catalogError = useCatalog((s) => s.error)
  const [favorites, setFavorites] = useState(loadFavorites)
  const [tab, setTab] = useState<Tab>(current.provider)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!magpie.length) void loadMagpieModels()
  }, [])

  const all = useMemo(() => {
    const claude = (catalog?.models ?? []).map((option) => ({
      model: { provider: 'claude' as const, model: option.value },
      name: option.name,
      source: 'Claude',
    }))
    const routed = magpie.map((name) => ({ model: { provider: 'magpie' as const, model: name }, name, source: 'Magpie' }))
    return [...claude, ...routed]
  }, [catalog, magpie])

  const needle = query.trim().toLowerCase()
  const rows = all.filter((row) => {
    if (needle) return row.name.toLowerCase().includes(needle) || (row.model.model ?? '').toLowerCase().includes(needle)
    if (tab === 'favorites') return favorites.includes(modelKey(row.model))
    return row.model.provider === tab
  })

  const toggleFavorite = (key: string) => {
    const next = favorites.includes(key) ? favorites.filter((item) => item !== key) : [...favorites, key]
    setFavorites(next)
    saveFavorites(next)
  }

  const empty =
    tab === 'favorites' && !needle
      ? '还没有收藏的模型'
      : tab === 'claude' && !catalog
        ? catalogError ?? '正在读取 Claude 模型…'
        : tab === 'magpie' && !magpie.length
          ? magpieError
            ? '打开 Magpie 后重试'
            : '正在读取 Magpie 模型…'
          : '没有匹配的模型'

  return (
    <div className="flex h-[360px] min-h-0 overflow-hidden rounded-xl">
      <nav className="flex w-11 shrink-0 flex-col items-center gap-1 border-r p-1.5">
        <RailButton title="收藏" selected={tab === 'favorites'} onSelect={() => setTab('favorites')}>
          <Star className="size-4" fill={tab === 'favorites' ? 'currentColor' : 'none'} />
        </RailButton>
        <RailButton title="Claude" selected={tab === 'claude'} onSelect={() => setTab('claude')}>
          <ClaudeMark className="size-4" />
        </RailButton>
        <RailButton title="Magpie" selected={tab === 'magpie'} onSelect={() => setTab('magpie')}>
          <Cpu className="size-4" />
        </RailButton>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <label className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5 text-muted-foreground">
          <Search className="size-3.5 shrink-0" />
          <input
            // biome-ignore lint/a11y/noAutofocus: the flyout opens to search
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && rows[0]) onPick(rows[0].model)
            }}
            placeholder="Search models"
            className="selectable min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {rows.length === 0 && <div className="px-2 py-3 text-[12px] text-muted-foreground">{empty}</div>}
          {rows.map((row) => {
            const key = modelKey(row.model)
            const selected =
              key === modelKey({ ...current, effort: undefined }) ||
              (current.provider === 'claude' && !current.model && row.model.provider === 'claude' && row.name === catalog?.defaultName)
            const favorited = favorites.includes(key)
            return (
              <div key={key} className={cn('group flex h-8 items-center rounded-lg px-1', selected ? 'bg-accent' : 'hover:bg-accent')}>
                <button
                  type="button"
                  onClick={() => onPick(row.model)}
                  className="flex h-full min-w-0 flex-1 items-center px-1.5 text-left text-[13px]"
                >
                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                </button>
                {(tab === 'favorites' || needle) && <span className="shrink-0 px-1 text-[10px] text-muted-foreground">{row.source}</span>}
                <button
                  type="button"
                  title={favorited ? '取消收藏' : '收藏'}
                  onClick={() => toggleFavorite(key)}
                  className={cn(
                    'grid size-6 shrink-0 place-items-center rounded-md',
                    favorited ? 'text-muted-foreground' : 'text-muted-foreground/60 opacity-0 group-hover:opacity-100',
                  )}
                >
                  <Star className="size-3.5" fill={favorited ? 'currentColor' : 'none'} />
                </button>
                {selected && (
                  <span className="grid size-6 shrink-0 place-items-center">
                    <Check className="size-3.5 text-muted-foreground" />
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function RailButton({ title, selected, onSelect, children }: { title: string; selected: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onMouseEnter={selected ? undefined : onSelect}
      onClick={onSelect}
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-md',
        selected ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

// MARK: - Access

const accessIcons: Record<AgentAccess, typeof Lock> = {
  supervised: Lock,
  acceptEdits: Pencil,
  auto: Sparkles,
  fullAccess: Shield,
}

export function AccessPicker({ access, onChange }: { access?: AgentAccess; onChange: (next: AgentAccess) => void }) {
  const configured = useIssues((s) => s.config?.access)
  const [open, setOpen] = useState(false)
  const value = access ?? configured ?? 'fullAccess'
  const mode = agentAccessModes.find((option) => option.value === value) ?? agentAccessModes[3]
  const Icon = accessIcons[value]

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={pillClass} title={mode.hint}>
        <Icon className={cn('size-3.5', value === 'fullAccess' ? 'text-amber-500' : 'text-muted-foreground')} />
        <span className="whitespace-nowrap">{mode.label}</span>
        <ChevronDown className={cn('size-3 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={6} className="z-50">
          <Popover.Popup className={cn(popupClass, 'w-[300px]')}>
            {agentAccessModes.map((option) => {
              const OptionIcon = accessIcons[option.value]
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    onChange(option.value)
                    setOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left',
                    option.value === value ? 'bg-accent' : 'hover:bg-accent',
                  )}
                >
                  <OptionIcon
                    className={cn('mt-0.5 size-3.5 shrink-0', option.value === 'fullAccess' ? 'text-amber-500' : 'text-muted-foreground')}
                  />
                  <span className="min-w-0">
                    <span className="block text-[13px] leading-5 font-medium">{option.label}</span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">{option.hint}</span>
                  </span>
                </button>
              )
            })}
            <p className="px-2 pt-1 pb-1.5 text-[11px] leading-4 text-muted-foreground">从下一条消息开始生效。</p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
