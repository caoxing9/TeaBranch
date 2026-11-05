import { Text, View } from 'nsh'
import { Popover } from 'nsh/base'
import { getLocale, t } from '../../../shared/i18n'
import type { TeableField } from '../../../shared/types'
import { Icon } from '../../components/Icon'
import { TextInput } from '../../components/kit'
import { cn } from '../../lib/utils'
import { type FilterCondition, type FilterOperator, type IssueFilterSet, isComplete, issues, matchesFilter, newConditionId } from '../../store/issues'
import { Choice } from '../autopilot/parts'

/**
 * Teable's view filter — "当 [字段] [条件] [值]" rows joined by 且/或 — reshaped for a Mac sidebar:
 * a popover off the funnel button, 12px controls, the app's own pop-ups for every choice.
 */

const operatorLabel = (operator: FilterOperator): string =>
  ({
    is: t('是'),
    isNot: t('不是'),
    contains: t('包含'),
    doesNotContain: t('不包含'),
    isEmpty: t('为空'),
    isNotEmpty: t('不为空'),
  })[operator]

const hasChoices = (field?: TeableField): boolean => !!field && field.choices.length > 0

function operatorsFor(field?: TeableField): FilterOperator[] {
  return hasChoices(field) ? ['is', 'isNot', 'isEmpty', 'isNotEmpty'] : ['contains', 'doesNotContain', 'is', 'isNot', 'isEmpty', 'isNotEmpty']
}

const needsValue = (operator: FilterOperator): boolean => operator !== 'isEmpty' && operator !== 'isNotEmpty'

/** Short summary for the funnel's tooltip: "状态 是 待修复" or "2 个筛选条件". */
export function filterSummary(filter: IssueFilterSet): string | null {
  const active = filter.conditions.filter(isComplete)
  if (!active.length) return null
  if (active.length > 1) return t('{n} 个筛选条件', { n: active.length })
  const [condition] = active
  const value = needsValue(condition.operator) ? ` ${condition.value.filter(Boolean).join(getLocale() === 'en' ? ', ' : '、')}` : ''
  return `${condition.field} ${operatorLabel(condition.operator)}${value}`
}

/** How many loaded issues the conditions hide — 0 means they're set but change nothing right now. */
const hiddenCount = (): number => issues.issues().filter((issue) => !matchesFilter(issue, issues.issueFilter())).length

export function IssueFilterButton() {
  const filter = () => issues.issueFilter()
  const count = () => filter().conditions.filter(isComplete).length
  const biting = () => count() > 0 && hiddenCount() > 0
  const title = () => {
    const summary = filterSummary(filter())
    return summary ? `${summary}\n${hiddenCount() ? t('隐藏了 {n} 个 issue', { n: hiddenCount() }) : t('没有隐藏任何 issue')}` : t('筛选')
  }
  return (
    <Popover
      placement="bottom"
      align="start"
      offset={6}
      popupClass="w-[440px] rounded-lg border border-border bg-popover shadow-lg"
      trigger={
        <View
          class={cn('relative size-[26px] shrink-0 items-center justify-center rounded-md', biting() ? 'bg-brand-soft' : 'hover:bg-fill-hover')}
          role="button"
          tooltip={title()}
          accessibilityLabel={t('筛选')}
        >
          <Icon name="filter" size={14} tint={count() ? 'brand' : 'fg-2'} />
          <If when={count() > 0}>
            <View class={cn('absolute -top-0.5 -right-0.5 h-3.5 min-w-3.5 items-center justify-center rounded-full px-1', biting() ? 'bg-brand' : 'bg-fg-3')}>
              <Text class="text-[9px] font-semibold text-white tabular-nums">{count()}</Text>
            </View>
          </If>
        </View>
      }
    >
      <FilterEditor />
    </Popover>
  )
}

function FilterEditor() {
  const filter = () => issues.issueFilter()
  const fields = () => issues.fields()
  const active = () => filter().conditions.some(isComplete)
  const usable = () => fields().filter((field) => field.type !== 'attachment' && field.type !== 'button')

  const update = (id: string, patch: Partial<FilterCondition>) =>
    issues.setIssueFilter({ ...filter(), conditions: filter().conditions.map((c) => (c.id === id ? { ...c, ...patch } : c)) })
  const remove = (id: string) => issues.setIssueFilter({ ...filter(), conditions: filter().conditions.filter((c) => c.id !== id) })
  const add = () => {
    // Start on the first select column — what people filter issues by (状态, 类型, 优先级).
    const field = usable().find(hasChoices) ?? usable()[0]
    if (!field) return
    const condition: FilterCondition = { id: newConditionId(), field: field.name, operator: operatorsFor(field)[0], value: [] }
    issues.setIssueFilter({ ...filter(), conditions: [...filter().conditions, condition] })
  }
  const fieldOf = (condition: FilterCondition) => fields().find((candidate) => candidate.name === condition.field)
  const fieldOptions = (condition: FilterCondition) => [
    ...usable().map((option) => ({ value: option.name, label: option.name })),
    ...(fieldOf(condition) ? [] : [{ value: condition.field, label: t('{field}（已不存在）', { field: condition.field }) }]),
  ]

  return (
    <View>
      <View class="h-8 flex-row items-center gap-2 border-b border-border/70 px-3">
        <Text class="text-[12px] font-semibold text-fg">{t('筛选')}</Text>
        <Text class="min-w-0 flex-1 text-[12px] text-fg-3" style={{ numberOfLines: 1 }}>
          {active() ? (hiddenCount() ? t('隐藏了 {n} 个 issue', { n: hiddenCount() }) : t('没有隐藏任何 issue')) : t('按 Teable 字段筛选已加载的 issue')}
        </Text>
        <If when={filter().conditions.length > 0}>
          <View class="rounded px-1.5 py-0.5 hover:bg-fill-hover" role="button" onPress={() => issues.setIssueFilter({ ...filter(), conditions: [] })}>
            <Text class="text-[12px] text-fg-2">{t('清除')}</Text>
          </View>
        </If>
      </View>

      <View class="gap-1 p-2">
        <If when={filter().conditions.length === 0}>
          <Text class="px-1 py-2 text-[12px] text-fg-3">{t('还没有筛选条件')}</Text>
        </If>
        <Each of={filter().conditions} key={(condition) => condition.id}>
          {(condition, index) => (
            <View class="flex-row items-center gap-1">
              <View class="w-12 shrink-0 items-end pr-1">
                <If
                  when={index() === 1}
                  else={<Text class="text-[12px] text-fg-2">{index() === 0 ? t('当') : filter().conjunction === 'and' ? t('且') : t('或')}</Text>}
                >
                  <Choice
                    small
                    class="h-6 min-w-0 w-11 px-1.5 text-[12px]"
                    value={filter().conjunction}
                    options={[
                      { value: 'and', label: t('且') },
                      { value: 'or', label: t('或') },
                    ]}
                    onChange={(conjunction) => issues.setIssueFilter({ ...filter(), conjunction })}
                  />
                </If>
              </View>
              <Choice
                small
                class="h-6 min-w-0 w-28 shrink-0 px-2 text-[12px]"
                value={condition().field}
                options={fieldOptions(condition())}
                onChange={(name) => {
                  const next = fields().find((candidate) => candidate.name === name)
                  const operators = operatorsFor(next)
                  update(condition().id, { field: name, operator: operators.includes(condition().operator) ? condition().operator : operators[0], value: [] })
                }}
              />
              <Choice
                small
                class="h-6 min-w-0 w-[76px] shrink-0 px-2 text-[12px]"
                value={condition().operator}
                options={operatorsFor(fieldOf(condition())).map((operator) => ({ value: operator, label: operatorLabel(operator) }))}
                onChange={(operator) => update(condition().id, { operator })}
              />
              <View class="min-w-0 flex-1">
                <If when={needsValue(condition().operator)}>
                  <If
                    when={hasChoices(fieldOf(condition())) ? fieldOf(condition()) : undefined}
                    else={
                      <TextInput
                        value={condition().value[0] ?? ''}
                        autoFocus={!condition().value.length}
                        onChange={(e) => update(condition().id, { value: [e.value] })}
                        onSubmit={add}
                        placeholder={t('输入值')}
                        class="h-6 border-0 bg-fill px-2 text-[12px] shadow-none"
                      />
                    }
                  >
                    {(field) => <ChoiceValue field={field()} value={condition().value} onChange={(value) => update(condition().id, { value })} />}
                  </If>
                </If>
              </View>
              <View class="size-6 shrink-0 items-center justify-center rounded-md hover:bg-fill-hover" role="button" tooltip={t('删除条件')} accessibilityLabel={t('删除条件')} onPress={() => remove(condition().id)}>
                <Icon name="trash-2" size={14} tint="fg-3" />
              </View>
            </View>
          )}
        </Each>
      </View>

      <View class="h-8 flex-row items-center border-t border-border/70 px-2">
        <View class={cn('h-6 flex-row items-center gap-1 rounded-md px-1.5 hover:bg-fill-hover', !usable().length && 'opacity-40')} role="button" disabled={!usable().length} onPress={add}>
          <Icon name="plus" size={14} tint="fg-2" />
          <Text class="text-[12px] text-fg-2">{t('添加条件')}</Text>
        </View>
        <View class="flex-1" />
        <Text class="pr-1 text-[11px] text-fg-3">{t('⏎ 添加 · Esc 关闭')}</Text>
      </View>
    </View>
  )
}

/** "是任一" for select fields: picked choices as chips, the rest in a pop-up to add from. */
function ChoiceValue(props: { field: TeableField; value: string[]; onChange: (value: string[]) => void }) {
  const remaining = () => props.field.choices.filter((choice) => !props.value.includes(choice))
  const ADD = '__add__'
  return (
    <View class="min-h-6 flex-row flex-wrap items-center gap-1 rounded-md bg-fill px-1 py-0.5">
      <Each of={props.value} key={(choice) => choice}>
        {(choice) => (
          <View class="h-5 flex-row items-center gap-0.5 rounded border border-border bg-bg pr-0.5 pl-1.5 shadow-xs">
            <Text class="max-w-24 text-[11.5px] text-fg" style={{ numberOfLines: 1 }}>
              {choice()}
            </Text>
            <View class="size-3.5 items-center justify-center rounded-sm hover:bg-fill-hover" role="button" accessibilityLabel={t('移除 {choice}', { choice: choice() })} onPress={() => props.onChange(props.value.filter((v) => v !== choice()))}>
              <Icon name="x" size={10} tint="fg-3" />
            </View>
          </View>
        )}
      </Each>
      <If when={remaining().length > 0}>
        <Choice
          small
          class="h-5 min-w-0 flex-1 border-0 bg-transparent px-1 text-[12px] shadow-none"
          value={ADD}
          options={[{ value: ADD, label: props.value.length ? '+' : t('选择值…') }, ...remaining().map((choice) => ({ value: choice, label: choice }))]}
          onChange={(choice) => choice !== ADD && props.onChange([...props.value, choice])}
        />
      </If>
    </View>
  )
}
