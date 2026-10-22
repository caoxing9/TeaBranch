import { ChevronsUpDown, Filter, Plus, Trash2, X } from 'lucide-react'
import type { ReactNode, SelectHTMLAttributes } from 'react'
import type { TeableField } from '@shared/types'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cx } from '@/lib/format'
import { type FilterCondition, type FilterOperator, type IssueFilterSet, isComplete, newConditionId, useIssues } from '@/store/issues'

/**
 * Teable's view filter — "当 [字段] [条件] [值]" rows joined by 且/或 — reshaped for a Mac sidebar:
 * a popover off the funnel button, 12px controls, native pop-up menus for every choice.
 */

const operatorLabel: Record<FilterOperator, string> = {
  is: '是',
  isNot: '不是',
  contains: '包含',
  doesNotContain: '不包含',
  isEmpty: '为空',
  isNotEmpty: '不为空',
}

const hasChoices = (field?: TeableField): boolean => !!field && field.choices.length > 0

function operatorsFor(field?: TeableField): FilterOperator[] {
  return hasChoices(field)
    ? ['is', 'isNot', 'isEmpty', 'isNotEmpty']
    : ['contains', 'doesNotContain', 'is', 'isNot', 'isEmpty', 'isNotEmpty']
}

const needsValue = (operator: FilterOperator): boolean => operator !== 'isEmpty' && operator !== 'isNotEmpty'

/** A native pop-up button: the system menu on click, styled to sit flat in the popover. */
function PopUp({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <span className={cx('relative inline-flex min-w-0', className)}>
      <select
        {...props}
        className="h-6 w-full min-w-0 cursor-default appearance-none truncate rounded-md bg-fill pr-5 pl-2 text-[12px] text-fg outline-none hover:bg-foreground/[0.09] focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {children}
      </select>
      <ChevronsUpDown className="pointer-events-none absolute top-1/2 right-1 size-3 -translate-y-1/2 text-fg-3" />
    </span>
  )
}

/** Short summary for the sidebar chip: "状态 是 待修复" or "2 个筛选条件". */
export function filterSummary(filter: IssueFilterSet): string | null {
  const active = filter.conditions.filter(isComplete)
  if (!active.length) return null
  if (active.length > 1) return `${active.length} 个筛选条件`
  const [condition] = active
  const value = needsValue(condition.operator) ? ` ${condition.value.filter(Boolean).join('、')}` : ''
  return `${condition.field} ${operatorLabel[condition.operator]}${value}`
}

export function IssueFilterButton() {
  const filter = useIssues((s) => s.issueFilter)
  const count = filter.conditions.filter(isComplete).length
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            title="筛选"
            aria-label="筛选"
            className={cx(
              'relative flex size-[26px] shrink-0 items-center justify-center rounded-md transition-colors',
              count ? 'bg-brand-soft text-brand' : 'text-fg-2 hover:bg-foreground/[0.07] hover:text-fg',
              'data-popup-open:bg-foreground/[0.09]',
            )}
          >
            <Filter className="size-3.5" fill={count ? 'currentColor' : 'none'} />
            {count > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-brand px-1 text-[9px] font-semibold text-white tabular-nums">
                {count}
              </span>
            )}
          </button>
        }
      />
      <PopoverContent align="start" sideOffset={6} className="w-[440px] p-0">
        <FilterEditor />
      </PopoverContent>
    </Popover>
  )
}

function FilterEditor() {
  const filter = useIssues((s) => s.issueFilter)
  const fields = useIssues((s) => s.fields)
  const setFilter = useIssues((s) => s.setIssueFilter)
  const usable = fields.filter((field) => field.type !== 'attachment' && field.type !== 'button')

  const update = (id: string, patch: Partial<FilterCondition>) =>
    setFilter({ ...filter, conditions: filter.conditions.map((c) => (c.id === id ? { ...c, ...patch } : c)) })
  const remove = (id: string) => setFilter({ ...filter, conditions: filter.conditions.filter((c) => c.id !== id) })
  const add = () => {
    // Start on the first select column — what people filter issues by (状态, 类型, 优先级).
    const field = usable.find(hasChoices) ?? usable[0]
    if (!field) return
    const condition: FilterCondition = {
      id: newConditionId(),
      field: field.name,
      operator: operatorsFor(field)[0],
      value: [],
    }
    setFilter({ ...filter, conditions: [...filter.conditions, condition] })
  }

  return (
    <div
      className="text-[12px]"
      onKeyDown={(event) => {
        // ⏎ adds a condition — except where Enter already means something.
        const target = event.target as HTMLElement
        if (event.key === 'Enter' && !['SELECT', 'BUTTON'].includes(target.tagName)) {
          event.preventDefault()
          add()
        }
      }}
    >
      <div className="flex h-8 items-center gap-2 border-b border-border/70 px-3">
        <span className="font-semibold text-fg">筛选</span>
        <span className="text-fg-3">只作用于已加载的 issue</span>
        <div className="flex-1" />
        {filter.conditions.length > 0 && (
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-fg-2 hover:bg-foreground/[0.07] hover:text-fg"
            onClick={() => setFilter({ ...filter, conditions: [] })}
          >
            清除
          </button>
        )}
      </div>

      <div className="space-y-1 p-2">
        {filter.conditions.length === 0 && <div className="px-1 py-2 text-fg-3">还没有筛选条件</div>}
        {filter.conditions.map((condition, index) => {
          const field = fields.find((candidate) => candidate.name === condition.field)
          return (
            <div key={condition.id} className="group flex items-center gap-1">
              <span className="flex w-11 shrink-0 justify-end pr-1 text-fg-2">
                {index === 0 ? (
                  '当'
                ) : index === 1 ? (
                  <PopUp
                    className="w-11"
                    value={filter.conjunction}
                    aria-label="条件之间的关系"
                    onChange={(event) => setFilter({ ...filter, conjunction: event.target.value as 'and' | 'or' })}
                  >
                    <option value="and">且</option>
                    <option value="or">或</option>
                  </PopUp>
                ) : filter.conjunction === 'and' ? (
                  '且'
                ) : (
                  '或'
                )}
              </span>
              <PopUp
                className="w-28 shrink-0"
                value={condition.field}
                aria-label="字段"
                onChange={(event) => {
                  const next = fields.find((candidate) => candidate.name === event.target.value)
                  const operators = operatorsFor(next)
                  update(condition.id, {
                    field: event.target.value,
                    operator: operators.includes(condition.operator) ? condition.operator : operators[0],
                    value: [],
                  })
                }}
              >
                {usable.map((option) => (
                  <option key={option.id} value={option.name}>
                    {option.name}
                  </option>
                ))}
                {!field && <option value={condition.field}>{condition.field}（已不存在）</option>}
              </PopUp>
              <PopUp
                className="w-[70px] shrink-0"
                value={condition.operator}
                aria-label="条件"
                onChange={(event) => update(condition.id, { operator: event.target.value as FilterOperator })}
              >
                {operatorsFor(field).map((operator) => (
                  <option key={operator} value={operator}>
                    {operatorLabel[operator]}
                  </option>
                ))}
              </PopUp>
              <div className="min-w-0 flex-1">
                {needsValue(condition.operator) &&
                  (hasChoices(field) && field ? (
                    <ChoiceValue field={field} value={condition.value} onChange={(value) => update(condition.id, { value })} />
                  ) : (
                    <input
                      // biome-ignore lint/a11y/noAutofocus: a fresh row is where you type next
                      autoFocus={!condition.value.length}
                      value={condition.value[0] ?? ''}
                      onChange={(event) => update(condition.id, { value: [event.target.value] })}
                      placeholder="输入值"
                      className="selectable h-6 w-full min-w-0 rounded-md bg-fill px-2 text-[12px] outline-none placeholder:text-fg-3 hover:bg-foreground/[0.09] focus:bg-background focus:ring-2 focus:ring-ring/40"
                    />
                  ))}
              </div>
              <button
                type="button"
                title="删除条件"
                aria-label="删除条件"
                onClick={() => remove(condition.id)}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-3 opacity-60 group-hover:opacity-100 hover:bg-foreground/[0.07] hover:text-err"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          )
        })}
      </div>

      <div className="flex h-8 items-center border-t border-border/70 px-2">
        <button
          type="button"
          onClick={add}
          disabled={!usable.length}
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-fg-2 hover:bg-foreground/[0.07] hover:text-fg disabled:opacity-40"
        >
          <Plus className="size-3.5" />
          添加条件
        </button>
        <div className="flex-1" />
        <span className="pr-1 text-[11px] text-fg-3">⏎ 添加 · Esc 关闭</span>
      </div>
    </div>
  )
}

/** "是任一" for select fields: picked choices as chips, the rest in a pop-up to add from. */
function ChoiceValue({ field, value, onChange }: { field: TeableField; value: string[]; onChange: (value: string[]) => void }) {
  const remaining = field.choices.filter((choice) => !value.includes(choice))
  return (
    <div className="flex min-h-6 flex-wrap items-center gap-1 rounded-md bg-fill px-1 py-0.5">
      {value.map((choice) => (
        <span
          key={choice}
          className="inline-flex h-5 items-center gap-0.5 rounded bg-background pr-0.5 pl-1.5 text-[11.5px] shadow-xs ring-1 ring-border"
        >
          <span className="max-w-24 truncate">{choice}</span>
          <button
            type="button"
            aria-label={`移除 ${choice}`}
            onClick={() => onChange(value.filter((v) => v !== choice))}
            className="flex size-3.5 items-center justify-center rounded-sm text-fg-3 hover:bg-foreground/10 hover:text-fg"
          >
            <X className="size-2.5" />
          </button>
        </span>
      ))}
      {remaining.length > 0 && (
        <select
          value=""
          aria-label="添加值"
          onChange={(event) => event.target.value && onChange([...value, event.target.value])}
          className="h-5 min-w-0 flex-1 cursor-default appearance-none bg-transparent px-1 text-[12px] text-fg-3 outline-none hover:text-fg"
        >
          <option value="">{value.length ? '+' : '选择值…'}</option>
          {remaining.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}
