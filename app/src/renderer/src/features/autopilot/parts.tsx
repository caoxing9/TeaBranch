import { useEffect, useState, type ReactNode } from 'react'
import { t } from '@shared/i18n'
import type { ChatMode, SourceStatus } from '@shared/types'
import { inputClass, StatusDot } from '@/components/kit'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cx } from '@/lib/format'
import { cn } from '@/lib/utils'

/** The pieces autopilot's pages are built from: a header, cards of settings, rows inside them. */

/** The page's title in the display serif, with its controls on the right; the strip above it drags the window. */
export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="drag flex shrink-0 items-end gap-4 px-8 pt-[46px] pb-3">
      <div className="min-w-0 flex-1">
        <h1 className="font-display text-[24px] font-medium tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-[12.5px] text-fg-2">{subtitle}</p>}
      </div>
      {actions && <div className="no-drag flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

export function PageBody({ children }: { children: ReactNode }) {
  return (
    <div className="selectable-area min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-8 py-5">{children}</div>
    </div>
  )
}

/** A flat card with a hairline border: a group of settings, or a list. */
export function Card({ title, hint, right, children }: { title?: ReactNode; hint?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      {(title || right) && (
        <header className="flex items-start gap-3 border-b border-border/70 px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <h2 className="text-[13.5px] font-semibold">{title}</h2>
            {hint && <p className="mt-0.5 text-[11.5px] text-fg-2">{hint}</p>}
          </div>
          {right}
        </header>
      )}
      <div className="divide-y divide-border/60">{children}</div>
    </section>
  )
}

/** A setting: what it is on the left, the control on the right; or the control below for wide ones. */
export function Row({ label, hint, children, stacked }: { label: ReactNode; hint?: ReactNode; children: ReactNode; stacked?: boolean }) {
  return (
    <div className={cx('px-5 py-3.5', stacked ? 'space-y-2' : 'flex items-center gap-4')}>
      <div className={cx('min-w-0', !stacked && 'flex-1')}>
        <div className="text-[13px]">{label}</div>
        {hint && <div className="mt-0.5 text-[11.5px] text-fg-2">{hint}</div>}
      </div>
      <div className={cx(!stacked && 'shrink-0')}>{children}</div>
    </div>
  )
}

export function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: ReactNode
  hint?: ReactNode
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <Row label={label} hint={hint}>
      <Switch checked={checked} onCheckedChange={(value) => onChange(!!value)} />
    </Row>
  )
}

/** A number saved when you leave the box. */
export function NumberInput({
  value,
  onSave,
  min = 0,
  suffix,
}: {
  value: number
  onSave: (value: number) => void
  min?: number
  suffix?: string
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        type="number"
        min={min}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const next = Number(text)
          if (Number.isFinite(next) && next >= min && next !== value) onSave(next)
          else setText(String(value))
        }}
        className={cn(inputClass, 'w-20 text-right tabular-nums')}
      />
      {suffix && <span className="text-[12px] text-fg-2">{suffix}</span>}
    </span>
  )
}

/** Free text saved when you leave the box — a rule is written in sentences, not keystrokes. */
export function TextArea({
  value,
  placeholder,
  onSave,
  rows = 4,
}: {
  value: string
  placeholder?: string
  onSave: (value: string) => void
  rows?: number
}) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== value && onSave(text)}
        placeholder={placeholder}
        rows={rows}
        className={cn(inputClass, 'h-auto py-1.5 leading-relaxed')}
      />
      {text !== value && <div className="mt-1 text-[11.5px] text-warn">{t('离开输入框时保存')}</div>}
    </div>
  )
}

export const chatModeLabels = (): Record<ChatMode, string> => ({
  mention: t('只响应 @'),
  candidate: t('主动发现问题'),
  ignore: t('不监听'),
})

/** A dropdown in the app's own look — never the system's, which sits oddly in a card. */
export function Choice<T extends string>({
  value,
  options,
  onChange,
  small,
  className,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  small?: boolean
  className?: string
}) {
  return (
    <Select value={value} onValueChange={(next) => next && onChange(next as T)} items={options}>
      <SelectTrigger size={small ? 'sm' : 'default'} className={cn('min-w-32 text-[13px]', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} className="text-[13px]">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function ModeSelect({
  value,
  onChange,
  labels = chatModeLabels(),
  small,
}: {
  value: ChatMode
  onChange: (mode: ChatMode) => void
  labels?: Record<ChatMode, string>
  small?: boolean
}) {
  const modes: ChatMode[] = ['mention', 'candidate', 'ignore']
  return <Choice value={value} small={small} onChange={onChange} options={modes.map((mode) => ({ value: mode, label: labels[mode] }))} />
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

export function SourceDot({ state }: { state: SourceStatus['state'] }) {
  return <StatusDot color={sourceStateColor[state]} pulse={state === 'connecting'} />
}

/** An eight-ray spark in the brand colour: the router's mark, beside the greeting and its replies. */
export function Spark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <polygon
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        points="12,1 13.3,8.86 19.78,4.22 15.14,10.7 23,12 15.14,13.3 19.78,19.78 13.3,15.14 12,23 10.7,15.14 4.22,19.78 8.86,13.3 1,12 8.86,10.7 4.22,4.22 10.7,8.86"
      />
    </svg>
  )
}

export const sourceName = (id: string): string =>
  ({ teable: 'Teable', feishu: t('飞书'), github: 'GitHub', worker: 'Agent', watchdog: 'Watchdog', router: 'Router' })[id] ?? id
