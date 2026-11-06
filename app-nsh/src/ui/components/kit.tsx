import { type JSX, type PressEvent, Scroll, Text, View, signal, windowSize } from 'nsh'
import { Button as BaseButton, Checkbox, Dialog as BaseDialog, Input, type InputProps, Tab, Tabs } from 'nsh/base'
import { Menu, type MenuItem as NativeMenuItem } from 'nsh/desktop'
import { t } from '../../shared/i18n'
import { cn } from '../lib/utils'
import { Icon } from './Icon'

/**
 * The app's small vocabulary of controls, on nsh's base components. Screens use these rather than
 * `nsh/base` directly, so the look changes in one place.
 */

export type Tone = 'plain' | 'accent' | 'danger' | 'ghost'

const toneClass: Record<Tone, string> = {
  plain: 'border border-input bg-card hover:bg-fill active:bg-fill-active',
  accent: 'bg-primary hover:bg-primary/90 active:bg-primary/80',
  danger: 'bg-err hover:bg-err/90 active:bg-err/80',
  ghost: 'hover:bg-fill active:bg-fill-active',
}

const toneText: Record<Tone, string> = {
  plain: 'text-fg',
  accent: 'text-primary-foreground',
  danger: 'text-white',
  ghost: 'text-fg-2',
}

/** A child given as text becomes a label in the tone's colour; anything else is placed as is. */
const label = (children: JSX.Element, textClass: string): JSX.Element =>
  typeof children === 'string' || typeof children === 'number' ? <Text class={cn('text-[12.5px] font-medium', textClass)}>{children}</Text> : children

export function Button(props: {
  tone?: Tone
  icon?: JSX.Element
  children?: JSX.Element
  class?: string
  disabled?: boolean
  title?: string
  onPress?: () => void
}) {
  const tone = () => props.tone ?? 'plain'
  return (
    <BaseButton
      class={cn('h-7 flex-row items-center gap-1.5 rounded-md px-2.5', toneClass[tone()], props.disabled && 'opacity-50', props.class)}
      disabled={props.disabled}
      tooltip={props.title}
      accessibilityLabel={props.title ?? null}
      onPress={props.onPress}
    >
      {props.icon}
      {label(props.children, toneText[tone()])}
    </BaseButton>
  )
}

/** Icon-only button. `label` is required: it is the tooltip and what VoiceOver reads. */
export function IconButton(props: { label: string; tone?: Tone; children: JSX.Element; class?: string; disabled?: boolean; onPress?: () => void }) {
  return (
    <BaseButton
      class={cn('size-7 items-center justify-center rounded-md', toneClass[props.tone ?? 'ghost'], props.disabled && 'opacity-50', props.class)}
      disabled={props.disabled}
      tooltip={props.label}
      accessibilityLabel={props.label}
      onPress={props.onPress}
    >
      {props.children}
    </BaseButton>
  )
}

export function Segmented<T extends string>(props: { value: T; options: { value: T; label: JSX.Element }[]; onChange: (value: T) => void; class?: string }) {
  return (
    <Tabs class={cn('h-7 flex-row rounded-lg bg-muted p-0.5', props.class)} indicatorClass="hidden">
      <Each of={props.options} key={(option) => option.value}>
        {(option) => (
          <Tab
            selected={props.value === option().value}
            class={cn('flex-1 flex-row items-center justify-center rounded-md px-2', props.value === option().value && 'bg-card shadow-xs')}
            onPress={() => props.onChange(option().value)}
          >
            {typeof option().label === 'string' ? (
              <Text class={cn('text-[12px]', props.value === option().value ? 'font-medium text-fg' : 'text-fg-2')}>{option().label}</Text>
            ) : (
              option().label
            )}
          </Tab>
        )}
      </Each>
    </Tabs>
  )
}

export const Spinner = (props: { class?: string; size?: number }) => (
  <Icon name="loader-2" size={props.size ?? 14} tint="fg-2" class={cn('animate-spin', props.class)} />
)

export function StatusDot(props: { color: string; pulse?: boolean }) {
  return (
    <View class="relative size-2 shrink-0">
      <If when={props.pulse}>
        <View class={cn('absolute inset-0 animate-ping rounded-full opacity-50', props.color)} />
      </If>
      <View class={cn('size-2 rounded-full', props.color)} />
    </View>
  )
}

/** A checkbox with its label. The box draws its own mark: nsh's checkbox shows only what the app gives it. */
export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: JSX.Element }) {
  return (
    <View class="flex-row items-center gap-2" onPress={() => props.onChange(!props.checked)}>
      <Checkbox
        checked={props.checked}
        onChange={(e) => props.onChange(e.checked)}
        class={cn('size-4 items-center justify-center rounded border', props.checked ? 'border-primary bg-primary' : 'border-input bg-card')}
        indicator={
          <If when={props.checked}>
            <Icon name="check" size={11} tint="#ffffff" />
          </If>
        }
      />
      {typeof props.label === 'string' ? <Text class="text-[13px] text-fg">{props.label}</Text> : props.label}
    </View>
  )
}

// MARK: - Menus

export interface MenuItem {
  label: string
  onSelect?: () => void
  danger?: boolean
  disabled?: boolean
  checked?: boolean
  /** A nested list, shown as a submenu. */
  items?: MenuItem[]
}

export type MenuEntry = MenuItem | 'separator'

const toNative = (entries: MenuEntry[]): NativeMenuItem[] =>
  entries.map((entry) =>
    entry === 'separator'
      ? { type: 'separator' as const }
      : {
          label: entry.danger ? `${entry.label}` : entry.label,
          disabled: entry.disabled,
          checked: entry.checked,
          onSelect: entry.onSelect,
          submenu: entry.items ? toNative(entry.items) : undefined,
        },
  )

/** The system's menu at a point: `entries` is evaluated on open, so it sees fresh state. */
export const popupMenu = (entries: () => MenuEntry[], at?: { x: number; y: number }): Promise<void> => Menu.popup(toNative(entries()), at)

/** An icon button that opens a menu, under the pointer. */
export function MenuButton(props: { entries: () => MenuEntry[]; children: JSX.Element; label: string; class?: string }) {
  return (
    <View
      class={cn('size-7 items-center justify-center rounded-md', toneClass.ghost, props.class)}
      tooltip={props.label}
      accessibilityLabel={props.label}
      role="button"
      onPress={(e: PressEvent) => void popupMenu(props.entries, { x: e.pagePosition.x, y: e.pagePosition.y + 12 })}
    >
      {props.children}
    </View>
  )
}

/** Right-click anywhere in `children` for the menu. */
export function ContextMenuArea(props: { entries: () => MenuEntry[]; children: JSX.Element; class?: string }) {
  return (
    <View class={props.class} onContextMenu={(e) => void popupMenu(props.entries, e.pagePosition)}>
      {props.children}
    </View>
  )
}

// MARK: - Dialog

/**
 * A modal box: a title, an optional strip under it that stays put (tabs), and a body that scrolls
 * once the box reaches 84% of the window. The host centres the box across the window but hangs it
 * from the top, so the box measures itself and takes the top margin that centres it.
 */
export function Dialog(props: { title: JSX.Element; onClose: () => void; children: JSX.Element; width?: number; toolbar?: JSX.Element }) {
  const height = signal(0)
  const top = () => Math.max(0, Math.round((windowSize().height - height()) / 2))
  return (
    <BaseDialog
      open
      animation="fade"
      closeOnEscape
      closeOnBackdropPress
      onClose={props.onClose}
      backdropClass="bg-black/40"
      backdropTestID="dialog-backdrop"
      class="items-center"
    >
      {/* The limit is in points: a percentage max-height has nothing definite to be a percentage of here, and the box ran off the window. */}
      <View
        class="overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
        style={{ width: props.width ?? 520, maxHeight: Math.round(windowSize().height * 0.84), marginTop: top() }}
        onLayout={(e) => height.set(e.bounds.size.height)}
      >
        <View class="flex-row items-center gap-3 border-b border-border px-5 py-3.5">
          {typeof props.title === 'string' ? (
            <Text class="flex-1 text-[14px] font-semibold text-fg">{props.title}</Text>
          ) : (
            <View class="flex-1">{props.title}</View>
          )}
          <IconButton label={t('关闭')} onPress={props.onClose}>
            <Icon name="x" size={14} tint="fg-2" />
          </IconButton>
        </View>
        <If when={props.toolbar}>
          <View class="border-b border-border px-5 py-2.5">{props.toolbar}</View>
        </If>
        {/* Sized by its content, up to the box's limit: `flex-1` in a box without a height of its own came out as nothing. */}
        <Scroll class="min-h-0 shrink" contentClass="px-5 py-4">
          {props.children}
        </Scroll>
      </View>
    </BaseDialog>
  )
}

export function Field(props: { label: JSX.Element; hint?: JSX.Element; children: JSX.Element }) {
  return (
    <View class="mb-3.5">
      {typeof props.label === 'string' ? <Text class="mb-1.5 text-[12.5px] font-medium text-fg">{props.label}</Text> : props.label}
      {props.children}
      <If when={props.hint}>
        {(hint) => (typeof hint() === 'string' ? <Text class="mt-1.5 text-[11.5px] text-muted-foreground">{hint() as string}</Text> : hint())}
      </If>
    </View>
  )
}

/** A titled group of settings: a section of a settings dialog. */
export function Group(props: { title: JSX.Element; footer?: JSX.Element; children: JSX.Element }) {
  return (
    <View class="mb-5">
      {typeof props.title === 'string' ? <Text class="mb-2 text-[11px] font-semibold tracking-wide text-fg-3 uppercase">{props.title}</Text> : props.title}
      <View class="gap-2.5 rounded-lg bg-fill p-3">{props.children}</View>
      <If when={props.footer}>
        {(footer) =>
          typeof footer() === 'string' ? (
            <Text class="mt-1.5 px-1 text-[11px] text-fg-3">{footer() as string}</Text>
          ) : (
            <View class="mt-1.5 px-1">{footer()}</View>
          )
        }
      </If>
    </View>
  )
}

/** One setting in a group: its name on the left, the control on the right. */
export function Line(props: { label: JSX.Element; children: JSX.Element }) {
  return (
    <View class="flex-row items-center gap-3">
      {typeof props.label === 'string' ? <Text class="w-36 shrink-0 text-[12px] text-fg-2">{props.label}</Text> : props.label}
      <View class="min-w-0 flex-1">{props.children}</View>
    </View>
  )
}

/** The input look, for text fields and selects. */
export const inputClass =
  'h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 text-[13px] text-fg shadow-xs placeholder:text-muted-foreground focus:border-ring'

/** A text field in the app's look. */
export function TextInput(props: InputProps & { class?: string }) {
  return <Input {...props} class={cn(inputClass, props.multiline && 'h-auto py-1.5', props.class)} />
}

export function EmptyState(props: { icon: JSX.Element; title: JSX.Element; detail?: JSX.Element }) {
  return (
    <View class="flex-1 items-center justify-center gap-2 px-6">
      <View class="mb-1 size-12 items-center justify-center rounded-xl border border-border bg-card shadow-xs">{props.icon}</View>
      {typeof props.title === 'string' ? <Text class="text-center text-[14px] font-medium text-fg">{props.title}</Text> : props.title}
      <If when={props.detail}>
        {(detail) =>
          typeof detail() === 'string' ? <Text class="max-w-sm text-center text-[13px] text-muted-foreground">{detail() as string}</Text> : detail()
        }
      </If>
    </View>
  )
}

/** Full-width tabs under the title bar — the section switcher — with room for a control after them. */
export function TabBar<T extends string>(props: {
  value: T
  options: { value: T; label: JSX.Element }[]
  onChange: (value: T) => void
  trailing?: JSX.Element
}) {
  return (
    <View class="flex-row items-center gap-1 px-2">
      <Segmented value={props.value} options={props.options} onChange={props.onChange} class="min-w-0 flex-1" />
      {props.trailing}
    </View>
  )
}

/** The window's drag handle on pages without a header bar. */
export function TitleStrip(props: { class?: string; children?: JSX.Element }) {
  return (
    <View class={cn('h-[38px] shrink-0 flex-row items-center', props.class)} desktop={{ windowDrag: true }}>
      {props.children}
    </View>
  )
}
