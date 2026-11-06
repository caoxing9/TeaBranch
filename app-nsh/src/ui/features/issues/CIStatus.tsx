import { type JSX, Scroll, Text, View, signal } from 'nsh'
import { Popover } from 'nsh/base'
import type { CheckBucket, Issue, IssueRun, PRChecks } from '../../../shared/types'
import { ciFailures, ciPending } from '../../../shared/ci'
import { t } from '../../../shared/i18n'
import { Icon, type IconName } from '../../components/Icon'
import { Button } from '../../components/kit'
import { api } from '../../lib/api'
import { cn } from '../../lib/utils'
import { issues } from '../../store/issues'
import type { ColorName } from '../../theme'

/**
 * The PR's CI where you already are: a mark by the PR that says pass / fail / running, opening into
 * every check with its link — and the failures handed to the agent without a trip to GitHub.
 */
type Overall = 'fail' | 'pending' | 'pass'
const overall = (ci: PRChecks): Overall => (ciFailures(ci).length ? 'fail' : ciPending(ci) ? 'pending' : 'pass')

const bucketIcon: Record<CheckBucket, { name: IconName; tint: ColorName }> = {
  fail: { name: 'circle-x', tint: 'err' },
  pending: { name: 'circle-dashed', tint: 'warn' },
  pass: { name: 'circle-check', tint: 'ok' },
  skip: { name: 'circle-minus', tint: 'fg-3' },
}

const BucketIcon = (props: { bucket: CheckBucket }) => <Icon name={bucketIcon[props.bucket].name} size={12} tint={bucketIcon[props.bucket].tint} />

const order: CheckBucket[] = ['fail', 'pending', 'pass', 'skip']

/** Just the mark, for a sidebar row: nothing until there's something to say. */
export function CIDot(props: { run: IssueRun }) {
  const ci = () => props.run.ci
  const shown = () => !!ci() && ci()?.state === 'OPEN' && (ci()?.checks.length ?? 0) > 0
  const state = () => (ci() ? overall(ci() as PRChecks) : 'pass')
  const title = () => (state() === 'fail' ? t('CI 失败 {n} 项', { n: ciFailures(ci() as PRChecks).length }) : state() === 'pending' ? t('CI 运行中') : t('CI 通过'))
  return (
    <If when={shown()}>
      <View tooltip={title()}>
        <BucketIcon bucket={state()} />
      </View>
    </If>
  )
}

export function CIStatus(props: { issue: Issue; run: IssueRun; busy: boolean }) {
  const refreshing = signal(false)
  const open = signal(false)
  const ci = () => props.run.ci
  const state = () => (ci() && ci()!.checks.length ? overall(ci()!) : undefined)
  const failures = () => (ci() ? ciFailures(ci()!) : [])
  const counts = () => (ci() ? order.map((bucket) => [bucket, ci()!.checks.filter((check) => check.bucket === bucket).length] as const) : [])
  const label = () =>
    !ci()
      ? t('CI …')
      : ci()!.state !== 'OPEN'
        ? ci()!.state === 'MERGED'
          ? t('已合并')
          : t('已关闭')
        : state() === 'fail'
          ? t('CI 失败 {n}', { n: failures().length })
          : state() === 'pending'
            ? t('CI 运行中')
            : state() === 'pass'
              ? t('CI 通过')
              : t('无 CI')
  const tone = () => (state() === 'fail' ? 'text-err' : state() === 'pending' ? 'text-warn' : state() === 'pass' ? 'text-ok' : 'text-fg-3')
  return (
    <If when={props.run.prURL}>
      <Popover
        open={open()}
        placement="bottom"
        align="start"
        offset={6}
        closeOnEscape
        closeOnPressOutside
        popupClass="w-[380px] rounded-xl border border-border bg-popover shadow-lg"
        onOpenChange={(e) => open.set(e.open)}
        trigger={
          <View class="flex-row items-center gap-1 rounded px-1 hover:bg-fill-hover" role="button" onPress={() => open.set(!open())}>
            <If when={state() && ci()?.state === 'OPEN'}>
              <BucketIcon bucket={state() ?? 'pass'} />
            </If>
            <Text class={cn('text-[11px]', tone())}>{label()}</Text>
          </View>
        }
      >
        <View class="h-8 flex-row items-center gap-2 border-b border-border/70 px-3">
          <Text class="text-[12px] font-semibold text-fg">CI</Text>
          <Text class="flex-1 text-[12px] text-fg-3" style={{ numberOfLines: 1 }}>
            {counts()
              .filter(([, n]) => n > 0)
              .map(([bucket, n]) => `${n} ${bucketLabel(bucket)}`)
              .join(' · ')}
          </Text>
          <View
            class="size-6 items-center justify-center rounded-md hover:bg-fill-hover"
            role="button"
            tooltip={t('现在刷新')}
            disabled={refreshing()}
            onPress={async () => {
              refreshing.set(true)
              await issues.perform(() => api.refreshChecks(props.run.recordId))
              refreshing.set(false)
            }}
          >
            <Icon name="refresh-cw" size={12} tint="fg-2" />
          </View>
        </View>
        <Scroll class="max-h-72">
          <ChecksList issue={props.issue} run={props.run} busy={props.busy} />
        </Scroll>
      </Popover>
    </If>
  )
}

/** Every check, failures first, each opening its link — and the failures handed to the agent. */
export function ChecksList(props: { issue: Issue; run: IssueRun; busy: boolean; children?: JSX.Element }) {
  const maxRounds = () => issues.config()?.maxCIRounds ?? 2
  const autoFix = () => issues.config()?.autoFixCI ?? true
  const ci = () => props.run.ci
  const failures = () => (ci() ? ciFailures(ci()!) : [])
  const sorted = () => [...(ci()?.checks ?? [])].sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket))
  const note = () =>
    props.run.ciSentFor === ci()?.sha
      ? t('这次的失败已经发给 agent')
      : ciPending(ci()!)
        ? t('等其余的跑完会自动发给 agent')
        : !autoFix()
          ? t('自动发送已关闭')
          : (props.run.ciRounds ?? 0) >= maxRounds()
            ? t('已到自动发送上限（{n} 轮）', { n: maxRounds() })
            : t('agent 空闲时会自动发')
  return (
    <>
      <View class="py-1">
        <If when={!ci()}>
          <Text class="px-3 py-2 text-[12px] text-fg-3">{t('还没查过，稍等或点刷新')}</Text>
        </If>
        <If when={ci()?.checks.length === 0}>
          <Text class="px-3 py-2 text-[12px] text-fg-3">{t('这个 PR 没有 CI')}</Text>
        </If>
        <Each of={sorted()} key={(check, index) => `${check.name}-${index}`}>
          {(check) => (
            <View
              class="flex-row items-center gap-2 px-3 py-1 hover:bg-fill"
              role="button"
              disabled={!check().link}
              tooltip={check().link}
              onPress={() => check().link && void api.openExternal(check().link as string)}
            >
              <BucketIcon bucket={check().bucket} />
              <Text class="shrink-0 text-[12px] font-medium text-fg">{check().name}</Text>
              <If when={check().description}>
                <Text class="text-[12px] text-fg-3" style={{ numberOfLines: 1 }}>
                  {check().description}
                </Text>
              </If>
            </View>
          )}
        </Each>
      </View>
      <If when={failures().length > 0 && ci()?.state === 'OPEN'}>
        <View class="flex-row items-center gap-2 border-t border-border/70 px-3 py-2">
          <Text class="flex-1 text-[11.5px] text-fg-3">{note()}</Text>
          <Button
            tone="accent"
            class="h-6 px-2"
            icon={<Icon name="send" size={12} tint="#ffffff" />}
            disabled={props.busy}
            title={props.busy ? t('Agent 正在运行，等它结束') : undefined}
            onPress={() => void issues.perform(() => api.sendCIFailures(props.issue))}
          >
            {t('发给 agent 修')}
          </Button>
        </View>
      </If>
    </>
  )
}

const bucketLabel = (bucket: CheckBucket): string => ({ fail: t('失败'), pending: t('运行中'), pass: t('通过'), skip: t('跳过') })[bucket]
