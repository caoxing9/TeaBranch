import { type JSX, Text, View } from 'nsh'
import { Select } from 'nsh/base'
import { t } from '../../shared/i18n'
import { cn } from '../lib/utils'
import { Icon } from './Icon'
import { inputClass } from './kit'

export interface SearchOption {
  id: string
  name: string
  /** Options sharing a group sit under its heading, in the order they came. */
  group?: string
}

/**
 * A select you can type into: a field that opens a filtered list, ↑↓ to move, ⏎ to pick. For lists
 * too long to scroll through — every base in every space — where a plain menu gives up.
 */
export function SearchSelect(props: {
  /** null while loading. */
  options: SearchOption[] | null
  value: string | undefined
  onChange: (id: string | undefined) => void
  placeholder?: string
  /** An entry for "nothing", listed first: picking it clears the value. */
  none?: string
  disabled?: boolean
  icon?: JSX.Element
}) {
  const selected = () => props.options?.find((option) => option.id === props.value)
  const items = () => [
    ...(props.none ? [{ value: '', title: props.none }] : []),
    ...(props.options ?? []).map((option) => ({ value: option.id, title: option.name, group: option.group ?? null })),
  ]
  const label = () =>
    selected()
      ? selected()!.name
      : props.value
        ? props.value
        : !props.options && !props.disabled
          ? t('加载中…')
          : props.disabled
            ? '—'
            : (props.none ?? props.placeholder ?? t('选择…'))
  return (
    <Select
      items={items()}
      value={props.value ?? ''}
      searchable
      searchPlaceholder={t('搜索')}
      disabled={props.disabled || !props.options}
      onChange={(e) => props.onChange(e.value || undefined)}
      class={cn(inputClass, 'flex-row items-center gap-2')}
      popupClass="min-w-64 rounded-lg border border-border bg-popover shadow-lg"
      listClass="max-h-72 py-1"
      itemClass="h-8 flex-row items-center px-3 text-[13px] text-fg hover:bg-fill-hover"
      groupClass="px-3 pt-2 pb-1 text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase"
      searchClass="h-9 border-b border-border/70 px-2.5 text-[13px]"
      empty={<Text class="px-3 py-2 text-[12.5px] text-fg-3">{t('没有匹配的')}</Text>}
      trigger={
        <View class="flex-1 flex-row items-center gap-2">
          {props.icon}
          <Text class={cn('min-w-0 flex-1 text-[13px]', !selected() && !props.value ? 'text-muted-foreground' : 'text-fg', !selected() && props.value && 'font-mono')} style={{ numberOfLines: 1 }}>
            {label()}
          </Text>
          <If when={selected()?.group}>
            <Text class="max-w-[40%] shrink-0 text-[11.5px] text-fg-3" style={{ numberOfLines: 1 }}>
              {selected()?.group}
            </Text>
          </If>
          <Icon name="chevrons-up-down" size={14} tint="fg-3" />
        </View>
      }
    />
  )
}
