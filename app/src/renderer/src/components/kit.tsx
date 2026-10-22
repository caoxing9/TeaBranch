import { Loader2 } from 'lucide-react'
import { type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Button as UIButton } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Dialog as UIDialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * The app's small vocabulary of controls, built on shadcn/ui (Base UI primitives). Screens use
 * these rather than `components/ui` directly, so the look changes in one place.
 */

type Tone = 'plain' | 'accent' | 'danger' | 'ghost'

const variantOf: Record<Tone, 'outline' | 'default' | 'destructive' | 'ghost'> = {
  plain: 'outline',
  accent: 'default',
  danger: 'destructive',
  ghost: 'ghost',
}

export function Button({
  tone = 'plain',
  icon,
  children,
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; icon?: ReactNode }) {
  return (
    <UIButton type={type} variant={variantOf[tone]} size="sm" className={className} {...props}>
      {icon}
      {children}
    </UIButton>
  )
}

/** Icon-only button. `label` is required: it is the tooltip and what VoiceOver reads. */
export function IconButton({
  label,
  tone = 'ghost',
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tone?: Tone }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <UIButton
            type="button"
            variant={variantOf[tone]}
            size="icon-sm"
            aria-label={label}
            className={cn('text-muted-foreground hover:text-foreground', className)}
            {...props}
          >
            {children}
          </UIButton>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (value: T) => void
  className?: string
}) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as T)} className={className}>
      <TabsList className="w-full">
        {options.map((option) => (
          <TabsTrigger key={option.value} value={option.value}>
            {option.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}

export const Spinner = ({ className }: { className?: string }) => <Loader2 className={cn('size-3.5 animate-spin', className)} />

export function StatusDot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span className="relative inline-flex size-2 shrink-0">
      {pulse && <span className={cn('absolute inset-0 animate-ping rounded-full opacity-50', color)} />}
      <span className={cn('relative inline-flex size-2 rounded-full', color)} />
    </span>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the checkbox is the control
    <label className="flex cursor-pointer items-center gap-2 text-[13px]">
      <Checkbox checked={checked} onCheckedChange={(value) => onChange(!!value)} />
      {label}
    </label>
  )
}

// MARK: - Menus

export interface MenuItem {
  label: ReactNode
  onSelect?: () => void
  danger?: boolean
  disabled?: boolean
  checked?: boolean
  /** A nested list, shown as a submenu. */
  items?: MenuItem[]
}
export type MenuEntry = MenuItem | 'separator'

function DropdownEntries({ entries }: { entries: MenuEntry[] }) {
  return entries.map((entry, index) => {
    if (entry === 'separator') return <DropdownMenuSeparator key={`sep-${index}`} />
    if (entry.items) {
      return (
        <DropdownMenuSub key={index}>
          <DropdownMenuSubTrigger disabled={entry.disabled}>{entry.label}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-80 min-w-44">
            <DropdownEntries entries={entry.items} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )
    }
    if (entry.checked !== undefined) {
      return (
        <DropdownMenuCheckboxItem key={index} checked={entry.checked} disabled={entry.disabled} onClick={entry.onSelect}>
          {entry.label}
        </DropdownMenuCheckboxItem>
      )
    }
    return (
      <DropdownMenuItem key={index} disabled={entry.disabled} variant={entry.danger ? 'destructive' : 'default'} onClick={entry.onSelect}>
        {entry.label}
      </DropdownMenuItem>
    )
  })
}

function ContextEntries({ entries }: { entries: MenuEntry[] }) {
  return entries.map((entry, index) => {
    if (entry === 'separator') return <ContextMenuSeparator key={`sep-${index}`} />
    if (entry.items) {
      return (
        <ContextMenuSub key={index}>
          <ContextMenuSubTrigger disabled={entry.disabled}>{entry.label}</ContextMenuSubTrigger>
          <ContextMenuSubContent className="max-h-80 min-w-44">
            <ContextEntries entries={entry.items} />
          </ContextMenuSubContent>
        </ContextMenuSub>
      )
    }
    if (entry.checked !== undefined) {
      return (
        <ContextMenuCheckboxItem key={index} checked={entry.checked} disabled={entry.disabled} onClick={entry.onSelect}>
          {entry.label}
        </ContextMenuCheckboxItem>
      )
    }
    return (
      <ContextMenuItem key={index} disabled={entry.disabled} variant={entry.danger ? 'destructive' : 'default'} onClick={entry.onSelect}>
        {entry.label}
      </ContextMenuItem>
    )
  })
}

/** An icon button that opens a menu. `entries` is evaluated on open, so it sees fresh state. */
export function MenuButton({
  entries,
  children,
  label,
  className,
}: {
  entries: () => MenuEntry[]
  children: ReactNode
  label: string
  className?: string
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <UIButton
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            title={label}
            className={cn('text-muted-foreground hover:text-foreground', className)}
          >
            {children}
          </UIButton>
        }
      />
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownEntries entries={entries()} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Right-click anywhere in `children` for the menu. */
export function ContextMenuArea({ entries, children }: { entries: () => MenuEntry[]; children: ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div />}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        <ContextEntries entries={entries()} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

// MARK: - Dialog

export function Dialog({
  title,
  onClose,
  children,
  width = 520,
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  width?: number
}) {
  return (
    <UIDialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent style={{ maxWidth: width, width }} className="flex max-h-[84vh] flex-col gap-0 p-0">
        <DialogHeader className="border-b px-5 py-3.5">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </DialogContent>
    </UIDialog>
  )
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-3.5">
      <div className="mb-1.5 text-[12.5px] font-medium">{label}</div>
      {children}
      {hint && <div className="mt-1.5 text-[11.5px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

/** shadcn's input look, for native inputs and selects. */
export const inputClass =
  'selectable h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 text-[13px] shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 dark:bg-input/30'

export function EmptyState({ icon, title, detail }: { icon: ReactNode; title: ReactNode; detail?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="mb-1 flex size-12 items-center justify-center rounded-xl border bg-card text-muted-foreground shadow-xs">{icon}</div>
      <div className="text-[14px] font-medium">{title}</div>
      {detail && <div className="max-w-sm text-[13px] text-muted-foreground">{detail}</div>}
    </div>
  )
}

/** Full-width tabs under the title bar — the section switcher. */
export function TabBar<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="px-2">
      <Segmented value={value} options={options} onChange={onChange} />
    </div>
  )
}

/**
 * The window's drag handle on pages without a header bar. In normal flow on purpose: Electron
 * merges drag regions in paint order, so an absolutely positioned strip lands *after* the buttons'
 * no-drag regions and turns them back into window drags.
 */
export function TitleStrip() {
  return <div className="drag h-[38px] shrink-0" />
}
