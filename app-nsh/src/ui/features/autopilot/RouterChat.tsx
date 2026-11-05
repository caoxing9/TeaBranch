import { Text, View } from 'nsh'
import { t } from '../../../shared/i18n'
import type { ActivityItem } from '../../../shared/types'
import { Icon } from '../../components/Icon'
import { Markdown } from '../../components/Markdown'
import { app } from '../../store/app'
import { issues } from '../../store/issues'
import { WithAttachments } from '../issues/Attachments'
import { Spark } from './parts'

/**
 * The conversation with the router, from the activity on the app's thread: your messages on the
 * right, its replies on the left under its mark, and what it did in between as chips that open the
 * task. Worker reports and watchdog notes stay out — the router relays what matters, in words.
 */
export function RouterChat(props: { items: ActivityItem[]; thinking: boolean }) {
  return (
    <View class="gap-5">
      <Each of={props.items} key={(item) => item.id}>
        {(item) => <Line item={item()} />}
      </Each>
      <If when={props.thinking}>
        <View class="flex-row items-center gap-3">
          <Spark size={16} />
          <Text class="text-[13px] text-fg-2">{t('Router 正在看…')}</Text>
        </View>
      </If>
    </View>
  )
}

/** What the router did, as the chip says it. */
function actionLabel(item: ActivityItem): string {
  const detail = item.detail ?? ''
  const label =
    detail === 'investigate'
      ? t('开始探查')
      : detail === 'create_task'
        ? t('建了任务')
        : detail.startsWith('send_to_task')
          ? t('转给了任务')
          : detail === 'fix_issue'
            ? t('开始修复')
            : detail
  return `${label} ${item.text}`.trim()
}

function Line(props: { item: ActivityItem }) {
  const item = () => props.item
  return (
    <>
      <If when={item().source === 'me'}>
        <View class="items-end gap-1.5 pl-16">
          <View class="max-w-[85%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5">
            <If when={item().files?.length} else={<Text class="text-[13.5px] leading-relaxed text-fg" style={{ userSelect: 'text' }}>{item().text}</Text>}>
              <WithAttachments text={item().text} attachments={item().files ?? []} />
            </If>
          </View>
          <If when={item().outcome === 'action'}>
            <ActionChip label={item().detail ?? ''} recordId={item().recordId} />
          </If>
        </View>
      </If>
      <If when={item().source === 'router' && item().outcome === 'replied'}>
        <View class="flex-row gap-3 pr-10">
          <Spark size={16} class="mt-1" />
          <View class="min-w-0 flex-1">
            <Markdown text={item().text} />
          </View>
        </View>
      </If>
      <If when={item().source === 'router' && item().outcome === 'action'}>
        <View class="pl-7">
          <ActionChip label={actionLabel(item())} recordId={item().recordId} />
        </View>
      </If>
      <If when={item().source === 'router' && item().outcome === 'error'}>
        <Text class="pl-7 text-[12.5px] text-err">{t('Router 这一轮没跑完：{error}', { error: item().detail ?? '' })}</Text>
      </If>
    </>
  )
}

/** A thing the router did; with a task behind it, a click opens that task's conversation. */
function ActionChip(props: { label: string; recordId?: string }) {
  const open = () => {
    if (!props.recordId) return
    app.go({ section: 'issues' })
    issues.select(new Set([props.recordId]))
  }
  return (
    <View
      class="max-w-full flex-row items-center gap-1.5 self-start rounded-full border border-border bg-card px-3 py-1 hover:border-border-strong"
      role="button"
      disabled={!props.recordId}
      onPress={open}
    >
      <Text class="text-[12px] text-fg-2" style={{ numberOfLines: 1 }}>
        {props.label}
      </Text>
      <If when={props.recordId}>
        <Icon name="arrow-up-right" size={12} tint="fg-2" />
      </If>
    </View>
  )
}
