import { type JSX, Scroll, signal, Text, View, effect } from 'nsh'
import { Select, Switch } from 'nsh/base'
import { t } from '../../../shared/i18n'
import type { ChatMode, SourceStatus } from '../../../shared/types'
import { Icon } from '../../components/Icon'
import { inputClass, StatusDot, TextInput } from '../../components/kit'
import { cn } from '../../lib/utils'

/** The pieces autopilot's pages are built from: a header, cards of settings, rows inside them. */

/** The page's title in the display serif, with its controls on the right; the strip above it drags the window. */
export function PageHeader(props: { title: JSX.Element; subtitle?: JSX.Element; actions?: JSX.Element }) {
  return (
    <View class="shrink-0 flex-row items-end gap-4 px-8 pt-[46px] pb-3" desktop={{ windowDrag: true }}>
      <View class="min-w-0 flex-1">
        {typeof props.title === 'string' ? <Text class="font-display text-[24px] font-medium tracking-tight text-fg">{props.title}</Text> : props.title}
        <If when={props.subtitle}>{(subtitle) => (typeof subtitle() === 'string' ? <Text class="mt-1 max-w-2xl text-[12.5px] text-fg-2">{subtitle() as string}</Text> : subtitle())}</If>
      </View>
      <If when={props.actions}>
        <View class="shrink-0 flex-row items-center gap-2">{props.actions}</View>
      </If>
    </View>
  )
}

export function PageBody(props: { children: JSX.Element }) {
  return (
    <Scroll class="min-h-0 flex-1" contentClass="items-center px-8 py-5">
      <View class="w-full max-w-3xl gap-5">{props.children}</View>
    </Scroll>
  )
}

/** A flat card with a hairline border: a group of settings, or a list. */
export function Card(props: { title?: JSX.Element; hint?: JSX.Element; right?: JSX.Element; children: JSX.Element }) {
  return (
    <View class="overflow-hidden rounded-2xl border border-border bg-card">
      <If when={props.title || props.right}>
        <View class="flex-row items-start gap-3 border-b border-border/70 px-5 py-3.5">
          <View class="min-w-0 flex-1">
            <If when={props.title}>{(title) => (typeof title() === 'string' ? <Text class="text-[13.5px] font-semibold text-fg">{title() as string}</Text> : title())}</If>
            <If when={props.hint}>{(hint) => (typeof hint() === 'string' ? <Text class="mt-0.5 text-[11.5px] text-fg-2">{hint() as string}</Text> : hint())}</If>
          </View>
          {props.right}
        </View>
      </If>
      <View class="gap-px bg-border/60">{props.children}</View>
    </View>
  )
}

/** A setting: what it is on the left, the control on the right; or the control below for wide ones. */
export function Row(props: { label: JSX.Element; hint?: JSX.Element; children: JSX.Element; stacked?: boolean }) {
  return (
    <View class={cn('bg-card px-5 py-3.5', props.stacked ? 'gap-2' : 'flex-row items-center gap-4')}>
      <View class={cn('min-w-0', !props.stacked && 'flex-1')}>
        {typeof props.label === 'string' ? <Text class="text-[13px] text-fg">{props.label}</Text> : props.label}
        <If when={props.hint}>{(hint) => (typeof hint() === 'string' ? <Text class="mt-0.5 text-[11.5px] text-fg-2">{hint() as string}</Text> : hint())}</If>
      </View>
      <View class={cn(!props.stacked && 'shrink-0')}>{props.children}</View>
    </View>
  )
}

export function AppSwitch(props: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <Switch
      checked={props.checked}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.checked)}
      class="h-5 w-9 rounded-full bg-input p-0.5"
      checkedStyle={{}}
      trackClass="flex-1"
      thumbClass="size-4 rounded-full bg-white shadow-xs"
    />
  )
}

export function SwitchRow(props: { label: JSX.Element; hint?: JSX.Element; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <Row label={props.label} hint={props.hint}>
      <AppSwitch checked={props.checked} onChange={props.onChange} />
    </Row>
  )
}

/** A number saved when you leave the box. */
export function NumberInput(props: { value: number; onSave: (value: number) => void; min?: number; suffix?: string }) {
  const text = signal(String(props.value))
  effect(() => text.set(String(props.value)))
  const min = () => props.min ?? 0
  const commit = () => {
    const next = Number(text())
    if (Number.isFinite(next) && next >= min() && next !== props.value) props.onSave(next)
    else text.set(String(props.value))
  }
  return (
    <View class="flex-row items-center gap-1.5">
      <TextInput value={text()} onChange={(e) => text.set(e.value)} onBlur={commit} onSubmit={commit} keyboardType="numeric" class="w-20 text-right tabular-nums" />
      <If when={props.suffix}>
        <Text class="text-[12px] text-fg-2">{props.suffix}</Text>
      </If>
    </View>
  )
}

/** Free text saved when you leave the box — a rule is written in sentences, not keystrokes. */
export function TextArea(props: { value: string; placeholder?: string; onSave: (value: string) => void; rows?: number }) {
  const text = signal(props.value)
  effect(() => text.set(props.value))
  const dirty = () => text() !== props.value
  return (
    <View>
      <TextInput
        multiline
        value={text()}
        onChange={(e) => text.set(e.value)}
        onBlur={() => dirty() && props.onSave(text())}
        placeholder={props.placeholder}
        class="leading-relaxed"
        style={{ minHeight: 22 * (props.rows ?? 4) + 12 }}
      />
      <If when={dirty()}>
        <Text class="mt-1 text-[11.5px] text-warn">{t('离开输入框时保存')}</Text>
      </If>
    </View>
  )
}

export const chatModeLabels = (): Record<ChatMode, string> => ({
  mention: t('只响应 @'),
  candidate: t('主动发现问题'),
  ignore: t('不监听'),
})

/** A dropdown in the app's own look — never the system's, which sits oddly in a card. */
/** A drop-down of named options. `Select` looks like nothing on its own: the trigger here is the box, naming the chosen option. */
export function Choice<T extends string>(props: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; small?: boolean; class?: string }) {
  const title = () => props.options.find((option) => option.value === props.value)?.label ?? ''
  return (
    <Select
      value={props.value}
      items={props.options.map((option) => ({ value: option.value, title: option.label }))}
      onChange={(e) => e.value && props.onChange(e.value as T)}
      trigger={
        <View class={cn(inputClass, 'min-w-32 flex-row items-center justify-between gap-2', props.small ? 'h-7' : 'h-8', props.class)}>
          <Text class={cn('min-w-0 flex-1', props.small ? 'text-[12px] text-fg' : 'text-[13px] text-fg')} style={{ numberOfLines: 1 }}>
            {title()}
          </Text>
          <Icon name="chevron-down" size={14} tint="fg-2" />
        </View>
      }
      popupClass="rounded-lg border border-border bg-popover p-1 shadow-lg"
      itemClass="rounded-md px-2 py-1.5 text-[13px] text-fg hover:bg-fill selected:bg-fill"
    />
  )
}

export function ModeSelect(props: { value: ChatMode; onChange: (mode: ChatMode) => void; labels?: Record<ChatMode, string>; small?: boolean }) {
  const modes: ChatMode[] = ['mention', 'candidate', 'ignore']
  const labels = () => props.labels ?? chatModeLabels()
  return <Choice value={props.value} small={props.small} onChange={props.onChange} options={modes.map((mode) => ({ value: mode, label: labels()[mode] }))} />
}

export const sourceStateColor: Record<SourceStatus['state'], string> = {
  off: 'bg-fg-3',
  setup: 'bg-warn',
  connecting: 'bg-warn',
  online: 'bg-ok',
  error: 'bg-err',
}

export const sourceStateLabel = (): Record<SourceStatus['state'], string> => ({
  off: t('已关闭'),
  setup: t('待配置'),
  connecting: t('连接中'),
  online: t('在线'),
  error: t('出错'),
})

export function SourceDot(props: { state: SourceStatus['state'] }) {
  return <StatusDot color={sourceStateColor[props.state]} pulse={props.state === 'connecting'} />
}

/** An eight-ray spark in the brand colour: the router's mark, beside the greeting and its replies. */
export function Spark(props: { size?: number; class?: string }) {
  return <Icon name="spark" size={props.size ?? 16} tint="brand" class={props.class} />
}

export const sourceName = (id: string): string =>
  ({ teable: 'Teable', feishu: t('飞书'), github: 'GitHub', worker: 'Agent', watchdog: 'Watchdog', router: 'Router' })[id] ?? id
