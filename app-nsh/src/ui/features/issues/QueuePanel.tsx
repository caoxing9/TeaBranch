import { type JSX, Text, View, signal } from 'nsh'
import type { IssueRun } from '../../../shared/types'
import { isActivePhase } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { Icon, type IconName } from '../../components/Icon'
import { Button, StatusDot } from '../../components/kit'
import { api } from '../../lib/api'
import { cn } from '../../lib/utils'
import { app } from '../../store/app'
import { autopilot } from '../../store/autopilot'
import { issues } from '../../store/issues'
import { PhaseBadge } from './phase'

const inFlight = (run: IssueRun): boolean => (isActivePhase(run.phase) && run.phase !== 'queued') || run.phase === 'paused'

/** In the issue sidebar's foot: where the queue stands, and the way to autopilot's workers. */
export function QueueBar() {
  const shown = () => Object.values(issues.runs()).some(inFlight) || issues.queue().waiting.length > 0
  return (
    <If when={shown()}>
      <View class="h-9 shrink-0 flex-row items-center gap-2 border-t border-border bg-fill px-3">
        <QueueStatus />
        <View class="size-6 shrink-0 items-center justify-center rounded-md hover:bg-fill-hover" tooltip={t('打开任务队列')} onPress={() => void autopilot.show('worker')}>
          <Icon name="chevron-right" size={14} tint="fg-2" />
        </View>
      </View>
    </If>
  )
}

/** Paused, or how many run of how many may — with the button that resumes a paused queue. */
function QueueStatus() {
  const pausedCount = () => Object.values(issues.runs()).filter((run) => run.phase === 'paused').length
  return (
    <If
      when={issues.queue().paused}
      else={
        <>
          <If when={issues.queue().running.length > 0}>
            <StatusDot color="bg-agent" pulse />
            <Text class="text-[11.5px] font-medium text-fg-2" style={{ numberOfLines: 1 }}>
              {t('运行 {n}/{max}', { n: issues.queue().running.length, max: issues.queue().concurrency })}
            </Text>
          </If>
          <If when={pausedCount() > 0}>
            <Text class="shrink-0 text-[11.5px] font-medium text-warn">{t('{n} 个已暂停', { n: pausedCount() })}</Text>
          </If>
          <View class="flex-1" />
          <If when={issues.queue().waiting.length > 0}>
            <Text class="shrink-0 text-[11.5px] font-medium text-fg-2">{t('排队 {n}', { n: issues.queue().waiting.length })}</Text>
          </If>
        </>
      }
    >
      <Icon name="pause" size={14} tint="warn" />
      <Text class="flex-1 text-[11.5px] font-medium text-fg-2" style={{ numberOfLines: 1 }}>
        {t('队列已暂停')}
      </Text>
      <Button tone="accent" class="h-6 px-2" icon={<Icon name="play" size={12} tint="#ffffff" />} onPress={() => void issues.perform(() => api.resumeQueue())}>
        {t('全部继续')}
      </Button>
    </If>
  )
}

/**
 * The workers as a download manager: every running, paused and waiting issue — pause or stop each,
 * or all, and move the waiting ones into order. Opening one goes to its conversation in Issues.
 */
export function WorkerQueue() {
  const running = () =>
    Object.values(issues.runs())
      .filter(inFlight)
      .sort((a, b) => a.createdAt - b.createdAt)
  const empty = () => !running().length && !issues.queue().waiting.length
  return (
    <If when={!empty()} else={<EmptyQueue />}>
      <QueueList running={running()} />
    </If>
  )
}

function EmptyQueue() {
  return (
    <View class="items-center bg-card px-6 py-8">
      <Text class="text-[12.5px] font-medium text-fg">{t('队列是空的')}</Text>
      <Text class="mt-1 text-center text-[12.5px] text-fg-3">{t('在 Issues 里点“自动修复”，或勾选多个后“批量修复”')}</Text>
    </View>
  )
}

function QueueList(props: { running: IssueRun[] }) {
  const select = (ids: Set<string>) => {
    app.go({ section: 'issues' })
    issues.select(ids)
  }
  const confirmCancel = signal(false)
  let confirmTimer: ReturnType<typeof setTimeout> | undefined
  const askCancel = () => {
    // "全部取消" asks once: a second click within a few seconds.
    if (!confirmCancel()) {
      confirmCancel.set(true)
      if (confirmTimer) clearTimeout(confirmTimer)
      confirmTimer = setTimeout(() => confirmCancel.set(false), 3000)
      return
    }
    confirmCancel.set(false)
    void issues.perform(() => api.cancelQueue())
  }
  const canPause = () => props.running.some((run) => run.phase !== 'paused')
  const waiting = () => issues.queue().waiting
  const moveTo = (id: string, index: number) => {
    const rest = waiting().filter((candidate) => candidate !== id)
    rest.splice(Math.min(index, rest.length), 0, id)
    void issues.perform(() => api.reorderQueue(rest))
  }
  const concurrency = () => issues.queue().concurrency
  return (
    <View class="bg-card pb-2">
      <View class="border-b border-border/70 px-3 pt-1 pb-1.5">
        <View class="h-8 flex-row items-center gap-1">
          <Text class="text-[12px] font-semibold text-fg">{t('任务队列')}</Text>
          <View class="flex-1" />
          <If
            when={issues.queue().paused}
            else={
              <PanelAction icon="pause" disabled={!canPause() && !waiting().length} title={t('暂停正在跑的，并且不再从队列里取新的')} onPress={() => void issues.perform(() => api.pauseQueue())}>
                {t('全部暂停')}
              </PanelAction>
            }
          >
            <PanelAction primary icon="play" onPress={() => void issues.perform(() => api.resumeQueue())}>
              {t('全部继续')}
            </PanelAction>
          </If>
          <PanelAction icon="x" danger title={t('停止正在跑的，清空排队')} onPress={askCancel}>
            {confirmCancel() ? t('再点一次确认') : t('全部取消')}
          </PanelAction>
        </View>
        <View class="flex-row items-center gap-1.5">
          <If
            when={issues.queue().paused}
            else={
              <>
                <If when={issues.queue().running.length > 0}>
                  <StatusDot color="bg-agent" pulse />
                </If>
                <Text class="text-[11.5px] text-fg-2" style={{ numberOfLines: 1 }}>
                  {t('运行 {n}/{max}，空出来就补上排队的下一个', { n: issues.queue().running.length, max: concurrency() })}
                </Text>
              </>
            }
          >
            <Icon name="pause" size={12} tint="warn" />
            <Text class="text-[11.5px] text-fg-2" style={{ numberOfLines: 1 }}>
              {t('已暂停：正在跑的停下了，排队的不会开始')}
            </Text>
          </If>
          <View class="flex-1" />
          <View class="shrink-0 flex-row items-center gap-0.5" tooltip={t('最多同时跑几个')}>
            <RowButton label={t('少跑一个')} disabled={concurrency() <= 1} onPress={() => void issues.updateConfig({ batchSize: concurrency() - 1 })}>
              <Icon name="minus" size={12} tint="fg-3" />
            </RowButton>
            <Text class="w-4 text-center text-[11.5px] text-fg-2 tabular-nums">{concurrency()}</Text>
            <RowButton label={t('多跑一个')} disabled={concurrency() >= 10} onPress={() => void issues.updateConfig({ batchSize: concurrency() + 1 })}>
              <Icon name="plus" size={12} tint="fg-3" />
            </RowButton>
          </View>
        </View>
      </View>
      <SectionTitle title={t('进行中 {n}', { n: props.running.length })} />
      <If when={props.running.length === 0}>
        <Text class="px-3 py-1 text-[12px] text-fg-3">{t('没有在跑的任务')}</Text>
      </If>
      <Each of={props.running} key={(run) => run.recordId}>
        {(run) => (
          <QueueRow run={run()} onOpen={() => select(new Set([run().recordId]))}>
            <PhaseBadge phase={run().phase} />
            <If
              when={run().phase === 'paused'}
              else={
                <RowButton label={t('暂停')} onPress={() => void issues.perform(() => api.pauseIssue(run().recordId))}>
                  <Icon name="pause" size={12} tint="fg-3" />
                </RowButton>
              }
            >
              <RowButton label={t('继续')} onPress={() => void issues.perform(() => api.resumeIssue(run().recordId))}>
                <Icon name="play" size={12} tint="fg-3" />
              </RowButton>
            </If>
            <RowButton label={t('停止')} danger onPress={() => void issues.perform(() => api.cancelIssue(run().recordId))}>
              <Icon name="x" size={12} tint="fg-3" />
            </RowButton>
          </QueueRow>
        )}
      </Each>
      <If when={waiting().length > 0}>
        <SectionTitle title={t('排队 {n}', { n: waiting().length })} />
        <Each of={waiting()} key={(id) => id}>
          {(id, index) => (
            <If when={issues.runs()[id()]}>
              {(run) => (
                <QueueRow
                  run={run()}
                  onOpen={() => select(new Set([id()]))}
                  lead={
                    <View class="w-7 shrink-0 flex-row items-center gap-0.5">
                      <Icon name="grip-vertical" size={12} tint="fg-3" />
                      <Text class="text-[12px] text-fg-3 tabular-nums">{index() + 1}</Text>
                    </View>
                  }
                >
                  <RowButton
                    label={t('立即开始')}
                    disabled={!issues.issues().some((issue) => issue.id === id())}
                    onPress={() => {
                      const issue = issues.issues().find((candidate) => candidate.id === id())
                      if (issue) void issues.perform(() => api.fixNow(issue))
                    }}
                  >
                    <Icon name="play" size={12} tint="fg-3" />
                  </RowButton>
                  <RowButton label={t('上移')} disabled={index() === 0} onPress={() => moveTo(id(), index() - 1)}>
                    <Icon name="chevron-up" size={12} tint="fg-3" />
                  </RowButton>
                  <RowButton label={t('下移')} disabled={index() >= waiting().length - 1} onPress={() => moveTo(id(), index() + 1)}>
                    <Icon name="chevron-down" size={12} tint="fg-3" />
                  </RowButton>
                  <RowButton label={t('移到最前')} disabled={index() === 0} onPress={() => moveTo(id(), 0)}>
                    <Icon name="arrow-up-to-line" size={12} tint="fg-3" />
                  </RowButton>
                  <RowButton label={t('移出队列')} danger onPress={() => void issues.perform(() => api.cancelIssue(id()))}>
                    <Icon name="x" size={12} tint="fg-3" />
                  </RowButton>
                </QueueRow>
              )}
            </If>
          )}
        </Each>
      </If>
    </View>
  )
}

function SectionTitle(props: { title: string; hint?: string }) {
  return (
    <View class="flex-row items-center px-3 pt-2 pb-0.5">
      <Text class="text-[10.5px] font-semibold tracking-wide text-fg-3">{props.title}</Text>
      <View class="flex-1" />
      <If when={props.hint}>
        <Text class="text-[10.5px] text-fg-3">{props.hint}</Text>
      </If>
    </View>
  )
}

function QueueRow(props: { run: IssueRun; onOpen: () => void; lead?: JSX.Element; children: JSX.Element }) {
  return (
    <View class="mx-1 h-7 flex-row items-center gap-1.5 rounded-md px-2 hover:bg-fill">
      {props.lead}
      <View class="min-w-0 flex-1 flex-row items-center gap-1.5" onPress={props.onOpen} tooltip={props.run.title}>
        <Text class="shrink-0 font-mono text-[11px] text-fg-3">{props.run.issueKey}</Text>
        <Text class="flex-1 text-[12px] text-fg" style={{ numberOfLines: 1 }}>
          {props.run.title}
        </Text>
      </View>
      <View class="shrink-0 flex-row items-center gap-0.5">{props.children}</View>
    </View>
  )
}

function RowButton(props: { label: string; danger?: boolean; disabled?: boolean; children: JSX.Element; onPress: () => void }) {
  return (
    <View
      class={cn('size-5 items-center justify-center rounded', props.disabled ? 'opacity-30' : 'hover:bg-fill-hover')}
      tooltip={props.label}
      accessibilityLabel={props.label}
      role="button"
      disabled={props.disabled}
      onPress={() => !props.disabled && props.onPress()}
    >
      {props.children}
    </View>
  )
}

function PanelAction(props: { icon: IconName; danger?: boolean; primary?: boolean; disabled?: boolean; title?: string; children: string; onPress: () => void }) {
  return (
    <View
      class={cn('h-6 flex-row items-center gap-1 rounded-md px-1.5', props.primary ? 'hover:bg-brand-soft' : 'hover:bg-fill-hover', props.disabled && 'opacity-40')}
      tooltip={props.title}
      role="button"
      disabled={props.disabled}
      onPress={() => !props.disabled && props.onPress()}
    >
      <Icon name={props.icon} size={12} tint={props.primary ? 'brand' : props.danger ? 'err' : 'fg-2'} />
      <Text class={cn('text-[11.5px]', props.primary ? 'font-medium text-brand' : props.danger ? 'text-err' : 'text-fg-2')}>{props.children}</Text>
    </View>
  )
}
