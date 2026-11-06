import { Image, type JSX, Scroll, Text, View, signal } from 'nsh'
import { Popover } from 'nsh/base'
import claudeIcon from '../../../../assets/claude.svg'
import { t } from '../../../shared/i18n'
import type { AgentAccess, AgentEffort, AgentModel, ClaudeCatalog, ModelScene } from '../../../shared/types'
import { agentAccessModes, agentEffortLabel, agentEfforts, resolveModel } from '../../../shared/types'
import { Icon, type IconName } from '../../components/Icon'
import { TextInput } from '../../components/kit'
import { api } from '../../lib/api'
import { cn } from '../../lib/utils'
import { pref, setPref } from '../../prefs'
import { app } from '../../store/app'
import { createStore } from '../../store/base'
import { issues } from '../../store/issues'

/**
 * The composer's model and access pickers, after MonoCode's: a pill showing `Opus 5.5 High`, a
 * menu with Effort and Model rows whose lists open beside them, and an access pill whose menu
 * explains each mode.
 */

// MARK: - Catalog

const catalogFields = createStore<{ catalog: ClaudeCatalog | null; error: string | null }>({ catalog: null, error: null })

export const catalogStore = {
  ...catalogFields,
  load: async (): Promise<void> => {
    if (catalogFields.catalog()) return
    try {
      catalogFields.set({ catalog: await api.claudeCatalog(), error: null })
    } catch (error) {
      catalogFields.set({ error: String((error as Error).message ?? error) })
    }
  },
}

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

export const ClaudeMark = (props: { size?: number; class?: string }) => (
  <Image src={claudeIcon} class={cn('shrink-0', props.class)} style={{ width: props.size ?? 14, height: props.size ?? 14 }} />
)

const ProviderIcon = (props: { provider: AgentModel['provider']; size?: number }) => (
  <If when={props.provider === 'claude'} else={<Icon name="cpu" size={props.size ?? 14} tint="fg-2" />}>
    <ClaudeMark size={props.size} />
  </If>
)

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

const pillClass = 'h-7 shrink-0 flex-row items-center gap-1.5 rounded-lg px-2 hover:bg-accent'
const popupClass = 'rounded-xl border border-border bg-popover p-1 shadow-lg'

// MARK: - Model

/**
 * `down` for a picker at the top right of a page: the menu drops below it. By default it rises
 * from a composer. Without a `model` of its own it shows what `scene`'s rule gives (the fix model
 * by default); `inherit` names that state ("follows the fallback") and is the item that returns to it.
 */
export function ModelPicker(props: {
  model?: AgentModel
  onChange: (next: AgentModel | null) => void
  placement?: 'up' | 'down'
  scene?: ModelScene
  inherit?: string
}) {
  const open = signal(false)
  const fly = signal<'effort' | 'model'>('effort')
  const catalog = () => catalogStore.catalog()
  const inherited = () => !props.model && !!props.inherit
  const current = (): AgentModel => props.model ?? resolveModel(app.settings()?.models, props.scene ?? 'fix')
  const shownEffort = () => current().effort ?? (current().provider === 'claude' ? catalog()?.defaultEffort : undefined)
  const choose = (next: AgentModel | null) => {
    props.onChange(next)
    open.set(false)
  }
  return (
    <Popover
      open={open()}
      placement={props.placement === 'down' ? 'bottom' : 'top'}
      align={props.placement === 'down' ? 'end' : 'start'}
      offset={6}
      closeOnEscape
      closeOnPressOutside
      popupClass={popupClass}
      onOpenChange={(e) => {
        open.set(e.open)
        if (e.open) void catalogStore.load()
      }}
      trigger={
        <View class={pillClass} tooltip={t('模型与思考等级')} role="button" onPress={() => open.set(!open())}>
          <ProviderIcon provider={current().provider} />
          <If when={inherited()}>
            <Text class="text-[12px] text-fg-2">{props.inherit} ·</Text>
          </If>
          <Text class={cn('text-[12px]', inherited() ? 'text-fg-2' : 'text-fg')}>{nameOf(current(), catalog())}</Text>
          <If when={shownEffort()}>
            <Text class="text-[12px] text-fg-2">{agentEffortLabel(shownEffort())}</Text>
          </If>
          <Icon name="chevron-down" size={12} tint="fg-2" />
        </View>
      }
    >
      <View class="flex-row items-start gap-1.5">
        <View class="w-[230px]">
          <MenuRow
            active={fly() === 'effort'}
            onEnter={() => fly.set('effort')}
            label={t('思考等级')}
            value={<Text class="text-[12.5px] text-fg-2">{agentEffortLabel(shownEffort()) ?? t('默认')}</Text>}
          />
          <MenuRow
            active={fly() === 'model'}
            onEnter={() => fly.set('model')}
            label={t('模型')}
            value={
              <View class="max-w-36 flex-row items-center gap-1">
                <ProviderIcon provider={current().provider} />
                <Text class="text-[12.5px] text-fg-2" style={{ numberOfLines: 1 }}>
                  {nameOf(current(), catalog())}
                </Text>
              </View>
            }
          />
          <If when={props.model}>
            <View class="mx-2 my-1 h-px bg-border" />
            <View class="h-8 flex-row items-center rounded-lg px-2 hover:bg-accent" role="button" onPress={() => choose(null)}>
              <Text class="text-[12.5px] text-fg-2">{props.inherit ?? t('恢复默认')}</Text>
            </View>
          </If>
        </View>
        <View class={cn('rounded-xl border border-border bg-popover shadow-lg', fly() === 'effort' ? 'w-[210px] p-1' : 'w-[330px]')}>
          <If
            when={fly() === 'effort'}
            else={
              <ModelList
                current={current()}
                catalog={catalog()}
                onPick={(picked) => {
                  const efforts = effortsOf(picked, catalog())
                  choose({ ...picked, effort: current().effort && efforts.includes(current().effort as AgentEffort) ? current().effort : undefined })
                }}
              />
            }
          >
            <Each of={effortsOf(current(), catalog())} key={(effort) => effort}>
              {(effort) => (
                <View
                  class="h-8 flex-row items-center gap-2 rounded-lg px-2 hover:bg-accent"
                  role="button"
                  onPress={() => choose({ ...current(), effort: effort() })}
                >
                  <Text class="flex-1 text-[13px] text-fg">{agentEffortLabel(effort())}</Text>
                  <If when={shownEffort() === effort()}>
                    <Icon name="check" size={14} tint="fg-2" />
                  </If>
                </View>
              )}
            </Each>
          </If>
        </View>
      </View>
    </Popover>
  )
}

function MenuRow(props: { label: string; value: JSX.Element; active: boolean; onEnter: () => void }) {
  return (
    <View
      class={cn('h-9 flex-row items-center gap-2 rounded-lg px-2', props.active ? 'bg-accent' : 'hover:bg-accent')}
      role="button"
      onMouseEnter={props.onEnter}
      onPress={props.onEnter}
    >
      <Text class="flex-1 text-[13px] text-fg">{props.label}</Text>
      {props.value}
      <Icon name="chevron-right" size={14} tint="fg-3" />
    </View>
  )
}

type Tab = 'favorites' | 'claude' | 'magpie'

function ModelList(props: { current: AgentModel; catalog: ClaudeCatalog | null; onPick: (m: AgentModel) => void }) {
  const favorites = signal<string[]>(pref<string[]>(FAVORITES_KEY, []))
  const tab = signal<Tab>(props.current.provider)
  const query = signal('')
  if (!issues.magpieModels().length) void issues.loadMagpieModels()
  const all = () => {
    const claude = (props.catalog?.models ?? []).map((option) => ({
      model: { provider: 'claude' as const, model: option.value },
      name: option.name,
      source: 'Claude',
    }))
    const routed = issues.magpieModels().map((name) => ({ model: { provider: 'magpie' as const, model: name }, name, source: 'Magpie' }))
    return [...claude, ...routed]
  }
  const needle = () => query().trim().toLowerCase()
  const rows = () =>
    all().filter((row) => {
      if (needle()) return row.name.toLowerCase().includes(needle()) || (row.model.model ?? '').toLowerCase().includes(needle())
      if (tab() === 'favorites') return favorites().includes(modelKey(row.model))
      return row.model.provider === tab()
    })
  const toggleFavorite = (key: string) => {
    const next = favorites().includes(key) ? favorites().filter((item) => item !== key) : [...favorites(), key]
    favorites.set(next)
    setPref(FAVORITES_KEY, next)
  }
  const empty = () =>
    tab() === 'favorites' && !needle()
      ? t('还没有收藏的模型')
      : tab() === 'claude' && !props.catalog
        ? (catalogStore.error() ?? t('正在读取 Claude 模型…'))
        : tab() === 'magpie' && !issues.magpieModels().length
          ? issues.magpieError()
            ? t('打开 Magpie 后重试')
            : t('正在读取 Magpie 模型…')
          : t('没有匹配的模型')
  const isSelected = (row: { model: AgentModel; name: string }) =>
    modelKey(row.model) === modelKey({ ...props.current, effort: undefined }) ||
    (props.current.provider === 'claude' && !props.current.model && row.model.provider === 'claude' && row.name === props.catalog?.defaultName)
  return (
    <View class="h-[360px] flex-row overflow-hidden rounded-xl">
      <View class="w-11 shrink-0 items-center gap-1 border-r border-border p-1.5">
        <RailButton title={t('收藏夹')} selected={tab() === 'favorites'} onSelect={() => tab.set('favorites')} icon="star" />
        <RailButton title="Claude" selected={tab() === 'claude'} onSelect={() => tab.set('claude')} mark />
        <RailButton title="Magpie" selected={tab() === 'magpie'} onSelect={() => tab.set('magpie')} icon="cpu" />
      </View>
      <View class="min-w-0 flex-1">
        <View class="shrink-0 flex-row items-center gap-2 border-b border-border px-3 py-2">
          <Icon name="search" size={14} tint="fg-2" />
          <TextInput
            autoFocus
            value={query()}
            onChange={(e) => query.set(e.value)}
            onSubmit={() => rows()[0] && props.onPick(rows()[0].model)}
            placeholder={t('搜索模型')}
            class="h-6 flex-1 border-0 bg-transparent px-0 shadow-none"
          />
        </View>
        <Scroll class="min-h-0 flex-1" contentClass="p-1">
          <If when={rows().length === 0}>
            <Text class="px-2 py-3 text-[12px] text-fg-2">{empty()}</Text>
          </If>
          <Each of={rows()} key={(row) => modelKey(row.model)}>
            {(row) => (
              <View class={cn('h-8 flex-row items-center rounded-lg px-1', isSelected(row()) ? 'bg-accent' : 'hover:bg-accent')}>
                <View class="h-full min-w-0 flex-1 flex-row items-center px-1.5" role="button" onPress={() => props.onPick(row().model)}>
                  <Text class="flex-1 text-[13px] text-fg" style={{ numberOfLines: 1 }}>
                    {row().name}
                  </Text>
                </View>
                <If when={tab() === 'favorites' || !!needle()}>
                  <Text class="shrink-0 px-1 text-[10px] text-fg-2">{row().source}</Text>
                </If>
                <View
                  class="size-6 shrink-0 items-center justify-center rounded-md"
                  tooltip={favorites().includes(modelKey(row().model)) ? t('取消收藏') : t('收藏')}
                  role="button"
                  onPress={() => toggleFavorite(modelKey(row().model))}
                >
                  <Icon name="star" size={14} tint={favorites().includes(modelKey(row().model)) ? 'warn' : 'fg-3'} />
                </View>
                <If when={isSelected(row())}>
                  <View class="size-6 shrink-0 items-center justify-center">
                    <Icon name="check" size={14} tint="fg-2" />
                  </View>
                </If>
              </View>
            )}
          </Each>
        </Scroll>
      </View>
    </View>
  )
}

function RailButton(props: { title: string; selected: boolean; onSelect: () => void; icon?: IconName; mark?: boolean }) {
  return (
    <View
      class={cn('size-8 shrink-0 items-center justify-center rounded-md', props.selected ? 'bg-accent' : 'hover:bg-accent/60')}
      tooltip={props.title}
      role="button"
      onMouseEnter={() => !props.selected && props.onSelect()}
      onPress={props.onSelect}
    >
      <If when={props.mark} else={<Icon name={props.icon ?? 'cpu'} size={16} tint={props.selected ? 'fg' : 'fg-2'} />}>
        <ClaudeMark size={16} />
      </If>
    </View>
  )
}

// MARK: - Access

const accessIcons: Record<AgentAccess, IconName> = {
  supervised: 'lock',
  acceptEdits: 'pencil',
  auto: 'sparkles',
  fullAccess: 'shield',
}

export function AccessPicker(props: { access?: AgentAccess; onChange: (next: AgentAccess) => void }) {
  const open = signal(false)
  const value = (): AgentAccess => props.access ?? issues.config()?.access ?? 'fullAccess'
  const mode = () => agentAccessModes.find((option) => option.value === value()) ?? agentAccessModes[3]
  return (
    <Popover
      open={open()}
      placement="top"
      align="start"
      offset={6}
      closeOnEscape
      closeOnPressOutside
      popupClass={cn(popupClass, 'w-[300px]')}
      onOpenChange={(e) => open.set(e.open)}
      trigger={
        <View class={pillClass} tooltip={mode().hint} role="button" onPress={() => open.set(!open())}>
          <Icon name={accessIcons[value()]} size={14} tint={value() === 'fullAccess' ? '#f59e0b' : 'fg-2'} />
          <Text class="text-[12px] text-fg">{mode().label}</Text>
          <Icon name="chevron-down" size={12} tint="fg-2" />
        </View>
      }
    >
      <Each of={agentAccessModes} key={(option) => option.value}>
        {(option) => (
          <View
            class={cn('flex-row items-start gap-2.5 rounded-lg px-2 py-2', option().value === value() ? 'bg-accent' : 'hover:bg-accent')}
            role="button"
            onPress={() => {
              props.onChange(option().value)
              open.set(false)
            }}
          >
            <Icon name={accessIcons[option().value]} size={14} tint={option().value === 'fullAccess' ? '#f59e0b' : 'fg-2'} class="mt-0.5" />
            <View class="min-w-0 flex-1">
              <Text class="text-[13px] leading-5 font-medium text-fg">{option().label}</Text>
              <Text class="mt-0.5 text-[11px] leading-4 text-fg-2">{option().hint}</Text>
            </View>
          </View>
        )}
      </Each>
      <Text class="px-2 pt-1 pb-1.5 text-[11px] leading-4 text-fg-2">{t('从下一条消息开始生效。')}</Text>
    </Popover>
  )
}
