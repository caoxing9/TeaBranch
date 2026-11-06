import { type JSX, Text, View, signal } from 'nsh'
import { t } from '../../../shared/i18n'
import type { ActivityItem } from '../../../shared/types'
import { Icon } from '../../components/Icon'
import { cn } from '../../lib/utils'
import { app } from '../../store/app'
import { issues } from '../../store/issues'
import { sourceName } from './parts'

/**
 * The feed as a pipeline: each event with where it went — filtered, straight to an agent, settled by a
 * rule, or to the router — and what came of it. Opened, it shows the full text, the router's own
 * account of its decision, and everything it did in answer.
 */

/** What an event went through, as the chip after the arrow says it. */
const routeLabel = (): Record<ActivityItem['outcome'], string> => ({
  ignored: t('过滤'),
  delivered: t('直达 agent'),
  routed: 'Router',
  action: t('规则处理'),
  replied: t('回复'),
  error: t('出错'),
})

const routeTone: Record<ActivityItem['outcome'], { box: string; text: string }> = {
  ignored: { box: 'bg-fill', text: 'text-fg-3' },
  delivered: { box: 'bg-agent-soft', text: 'text-agent' },
  routed: { box: 'bg-brand-soft', text: 'text-brand' },
  action: { box: 'bg-fill', text: 'text-fg' },
  replied: { box: 'bg-fill', text: 'text-fg' },
  error: { box: 'bg-err-soft', text: 'text-err' },
}

interface Entry {
  item: ActivityItem
  /** What the router did because of it. */
  actions: ActivityItem[]
}

/** Router actions sit under the event they answered; everything else is a line of its own. Newest first. */
function group(activity: ActivityItem[]): Entry[] {
  const byId = new Map<string, Entry>()
  const entries: Entry[] = []
  for (const item of activity) {
    const cause = item.source === 'router' ? item.causes?.find((id) => byId.has(id)) : undefined
    if (cause) {
      byId.get(cause)?.actions.push(item)
      continue
    }
    const entry = { item, actions: [] }
    byId.set(item.id, entry)
    entries.push(entry)
  }
  return entries.toReversed()
}

export function Pipeline(props: { activity: ActivityItem[]; limit?: number; showFiltered?: boolean }) {
  const entries = () => {
    const grouped = group(props.activity).filter((entry) => (props.showFiltered ?? true) || entry.item.outcome !== 'ignored')
    return props.limit ? grouped.slice(0, props.limit) : grouped
  }
  return (
    <If
      when={entries().length > 0}
      else={<Text class="bg-card px-4 py-10 text-center text-[12.5px] text-fg-2">{t('还没有动静。开启后，收到的消息和做过的事都会出现在这里。')}</Text>}
    >
      <View class="gap-px bg-border/60">
        <Each of={entries()} key={(entry) => entry.item.id}>
          {(entry) => <PipelineRow entry={entry()} />}
        </Each>
      </View>
    </If>
  )
}

function PipelineRow(props: { entry: Entry }) {
  const open = signal(false)
  const item = () => props.entry.item
  const actions = () => props.entry.actions
  const task = () => (item().recordId ? issues.runs()[item().recordId as string] : undefined)
  const created = () => actions().find((action) => action.recordId)
  const taskKey = () => task()?.issueKey ?? (created()?.recordId ? issues.runs()[created()?.recordId as string]?.issueKey : undefined)
  const replied = () => actions().some((action) => action.outcome === 'replied')
  const outcome = () => item().decision ?? (taskKey() ? taskKey() : replied() ? t('已回复') : item().detail)
  const time = () => new Date(item().at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return (
    <View class={cn('bg-card', item().outcome === 'ignored' && 'opacity-60')}>
      <View class="flex-row items-center gap-3 px-4 py-2.5 hover:bg-fill" role="button" onPress={() => open.set(!open())}>
        <Text class="w-11 shrink-0 text-[11.5px] text-fg-3 tabular-nums">{time()}</Text>
        <Text class="w-28 shrink-0 text-[12.5px] text-fg-2" style={{ numberOfLines: 1 }}>
          <Text class="font-medium text-fg">{sourceName(item().source)}</Text>
          {item().author ? ` · ${item().author}` : ''}
        </Text>
        <Text class="min-w-0 flex-1 text-[12.5px] text-fg" style={{ numberOfLines: 1 }}>
          {item().text.replace(/\s+/g, ' ')}
        </Text>
        <Icon name="arrow-right" size={12} tint="fg-3" />
        <View class={cn('shrink-0 rounded px-1.5 py-0.5', routeTone[item().outcome].box)}>
          <Text class={cn('text-[11px] font-medium', routeTone[item().outcome].text)}>{routeLabel()[item().outcome]}</Text>
        </View>
        <If when={outcome()}>
          <Text class="max-w-48 shrink-0 text-[11.5px] text-fg-2" style={{ numberOfLines: 1 }}>
            {outcome()}
          </Text>
        </If>
        <Icon name={open() ? 'chevron-down' : 'chevron-right'} size={14} tint="fg-3" />
      </View>
      <If when={open()}>
        <PipelineDetail entry={props.entry} />
      </If>
    </View>
  )
}

function PipelineDetail(props: { entry: Entry }) {
  const item = () => props.entry.item
  const actions = () => props.entry.actions
  const recordIds = () => [...new Set([item().recordId, ...actions().map((action) => action.recordId)].filter((id): id is string => !!id))]
  return (
    <View class="mx-4 mb-3 ml-[4.25rem] gap-2 border-l-2 border-border pl-3">
      <DetailLine label={t('原文')}>
        <Text class="text-[12.5px] text-fg" style={{ userSelect: 'text' }}>
          {item().text}
        </Text>
      </DetailLine>
      <If when={item().thread}>
        <DetailLine label={t('会话')}>
          <Text class="font-mono text-[11.5px] text-fg-2" style={{ userSelect: 'text' }}>
            {item().thread}
          </Text>
        </DetailLine>
      </If>
      <If when={item().detail}>
        <DetailLine label={t('说明')}>
          <Text class="text-[12.5px] text-fg">{item().detail}</Text>
        </DetailLine>
      </If>
      <If when={item().decision}>
        <DetailLine label={t('Router 判断')}>
          <Text class="text-[12.5px] text-fg">{item().decision}</Text>
        </DetailLine>
      </If>
      <Each of={actions()} key={(action) => action.id}>
        {(action) => (
          <DetailLine label={action().outcome === 'replied' ? t('回复') : (action().detail ?? t('动作'))}>
            <Text class="text-[12.5px] text-fg" style={{ userSelect: 'text' }}>
              {action().text}
            </Text>
          </DetailLine>
        )}
      </Each>
      <If when={recordIds().length > 0}>
        <View class="flex-row flex-wrap gap-2 pt-1">
          <Each of={recordIds()} key={(id) => id}>
            {(id) => <OpenIssue recordId={id()} />}
          </Each>
        </View>
      </If>
    </View>
  )
}

function DetailLine(props: { label: string; children: JSX.Element }) {
  return (
    <View class="flex-row gap-3">
      <Text class="w-20 shrink-0 text-[12.5px] text-fg-3">{props.label}</Text>
      <View class="min-w-0 flex-1">{props.children}</View>
    </View>
  )
}

/** Jump to the issue in the Issues section, with its conversation open. */
export function OpenIssue(props: { recordId: string }) {
  const run = () => issues.runs()[props.recordId]
  return (
    <View
      class="flex-row items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-fill"
      role="button"
      onPress={() => {
        app.go({ section: 'issues' })
        issues.select(new Set([props.recordId]))
      }}
    >
      <Icon name="external-link" size={12} tint="fg-2" />
      <Text class="text-[11.5px] text-fg">{t('打开 {key}', { key: run()?.issueKey ?? props.recordId })}</Text>
    </View>
  )
}
