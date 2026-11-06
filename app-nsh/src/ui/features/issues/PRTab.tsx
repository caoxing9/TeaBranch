import { type JSX, Scroll, Text, View, resource, signal } from 'nsh'
import type { Issue, IssueRun, PRAction, PRDetails } from '../../../shared/types'
import { isActivePhase } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { confirmDialog } from '../../components/confirm'
import { Icon } from '../../components/Icon'
import { Button, IconButton, MenuButton } from '../../components/kit'
import { Markdown } from '../../components/Markdown'
import { api, messageOf } from '../../lib/api'
import { cn } from '../../lib/utils'
import { issues } from '../../store/issues'
import { ChecksList } from './CIStatus'

/**
 * The PR the way MonoCode's inbox shows one: where it stands, the buttons you'd go to GitHub for,
 * its checks — failures one press from the agent — and the description the agent wrote.
 */
export function PRTab(props: { issue: Issue; run: IssueRun }) {
  const busy = () => isActivePhase(props.run.phase)
  const error = signal<string | null>(null)
  // Again whenever the background poll brings new checks: a push or a merge changes the rest too.
  const pr = resource(
    () => `${props.issue.id}:${props.run.ci?.sha ?? ''}:${props.run.ci?.state ?? ''}`,
    async () => {
      try {
        const details = await api.prDetails(props.issue.id)
        error.set(null)
        return details
      } catch (err) {
        error.set(messageOf(err))
        return null
      }
    },
  )
  const act = async (action: PRAction, confirmText?: string) => {
    if (confirmText && !(await confirmDialog(confirmText))) return
    void issues.perform(async () => {
      await api.prAction(props.issue.id, action)
      pr.refetch()
    })
  }
  const open = () => pr()?.state === 'OPEN'
  const current = () => pr() ?? null
  return (
    <Scroll class="flex-1">
      <View class="gap-2 border-b border-border px-3 py-3">
        <View class="flex-row items-start gap-2">
          <StateBadge pr={current()} />
          <Text class="min-w-0 flex-1 text-[12.5px] leading-snug font-semibold text-fg">{current()?.title ?? `PR #${props.run.prURL?.split('/').pop()}`}</Text>
          <IconButton label={t('刷新')} onPress={() => pr.refetch()}>
            <Icon name="refresh-cw" size={14} tint="fg-2" />
          </IconButton>
        </View>
        <If when={current()}>
          {(details) => (
            <View class="flex-row flex-wrap items-center gap-x-2 gap-y-1">
              <Text class="font-mono text-[11.5px] text-fg-2">#{details().number}</Text>
              <Text class="font-mono text-[11.5px] text-fg-2">
                {details().baseRefName} ← {details().headRefName}
              </Text>
              <Text class="text-[11.5px] text-fg-2">
                <Text class="font-mono text-ok">+{details().additions}</Text> <Text class="font-mono text-err">−{details().deletions}</Text> {t('{n} 个文件', { n: details().changedFiles })}
              </Text>
              <If when={open()}>
                <MergeHint pr={details()} />
              </If>
            </View>
          )}
        </If>
        <If when={error()}>
          <View class="rounded-md bg-err-soft px-2 py-1.5">
            <Text class="text-[12px] text-err">{error()}</Text>
          </View>
        </If>
        <View class="flex-row flex-wrap items-center gap-1.5">
          <If when={open() ? current() : undefined}>
            {(details) => (
              <>
                <View class="flex-row">
                  <Button
                    tone="accent"
                    class="h-7 rounded-r-none px-2.5"
                    icon={<Icon name="git-merge" size={14} tint="#ffffff" />}
                    disabled={details().isDraft}
                    title={details().isDraft ? t('草稿不能合并，先标记为可以 review') : undefined}
                    onPress={() => void act('squash', t('Squash 合并 PR #{n}？', { n: details().number }))}
                  >
                    {t('Squash 合并')}
                  </Button>
                  <MenuButton
                    label={t('其他合并方式')}
                    class="h-7 w-6 rounded-l-none bg-primary hover:bg-primary/90"
                    entries={() => [
                      { label: t('普通合并（merge commit）'), disabled: details().isDraft, onSelect: () => void act('merge', t('合并 PR #{n}？', { n: details().number })) },
                      { label: t('Rebase 合并'), disabled: details().isDraft, onSelect: () => void act('rebase', t('Rebase 合并 PR #{n}？', { n: details().number })) },
                    ]}
                  >
                    <Icon name="chevron-down" size={14} tint="#ffffff" />
                  </MenuButton>
                </View>
                <If when={details().isDraft} else={<Button class="h-7 px-2.5" onPress={() => void act('draft')}>{t('转为草稿')}</Button>}>
                  <Button class="h-7 px-2.5" onPress={() => void act('ready')}>
                    {t('标记为可以 review')}
                  </Button>
                </If>
                <Button class="h-7 px-2.5" onPress={() => void act('close', t('关闭 PR #{n}？分支会保留。', { n: details().number }))}>
                  {t('关闭')}
                </Button>
              </>
            )}
          </If>
          <If when={props.run.prURL}>
            <Button class="h-7 px-2.5" icon={<Icon name="external-link" size={12} tint="fg-2" />} onPress={() => void api.openExternal(props.run.prURL as string)}>
              GitHub
            </Button>
          </If>
        </View>
      </View>
      <Section title={t('检查')}>
        <ChecksList issue={props.issue} run={props.run} busy={busy()} />
      </Section>
      <If when={current()}>
        {(details) => (
          <Section title={t('描述')}>
            <View class="px-3 pb-3">
              <If when={details().body.trim()} else={<Text class="text-[12.5px] text-fg-3">{t('没有描述')}</Text>}>
                <Markdown text={details().body} class="text-[12.5px] text-fg" />
              </If>
            </View>
          </Section>
        )}
      </If>
    </Scroll>
  )
}

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <View class="border-b border-border">
      <Text class="px-3 pt-3 pb-1 text-[10.5px] font-semibold tracking-wide text-fg-2 uppercase">{props.title}</Text>
      {props.children}
    </View>
  )
}

function StateBadge(props: { pr: PRDetails | null }) {
  const badge = () => {
    const pr = props.pr
    if (!pr) return null
    return pr.state === 'MERGED'
      ? { label: t('已合并'), box: 'bg-agent-soft', text: 'text-agent' }
      : pr.state === 'CLOSED'
        ? { label: t('已关闭'), box: 'bg-err-soft', text: 'text-err' }
        : pr.isDraft
          ? { label: t('草稿'), box: 'bg-fill', text: 'text-fg-2' }
          : { label: t('开启'), box: 'bg-ok/15', text: 'text-ok' }
  }
  return (
    <If when={badge()} else={<Icon name="git-pull-request" size={16} tint="fg-3" class="mt-0.5" />}>
      {(b) => (
        <View class={cn('mt-px shrink-0 rounded-full px-2 py-0.5', b().box)}>
          <Text class={cn('text-[11px] font-medium', b().text)}>{b().label}</Text>
        </View>
      )}
    </If>
  )
}

/** Why it can or can't merge, in the words you'd act on. */
function MergeHint(props: { pr: PRDetails }) {
  const review = () =>
    props.pr.reviewDecision === 'APPROVED'
      ? { text: t('已批准'), tone: 'text-ok' }
      : props.pr.reviewDecision === 'CHANGES_REQUESTED'
        ? { text: t('要求修改'), tone: 'text-err' }
        : props.pr.reviewDecision === 'REVIEW_REQUIRED'
          ? { text: t('需要 review'), tone: 'text-warn' }
          : null
  const merge = () =>
    props.pr.mergeStateStatus === 'DIRTY'
      ? { text: t('有冲突'), tone: 'text-err' }
      : props.pr.mergeStateStatus === 'BEHIND'
        ? { text: t('落后于 {base}', { base: props.pr.baseRefName }), tone: 'text-warn' }
        : props.pr.mergeStateStatus === 'CLEAN'
          ? { text: t('可以合并'), tone: 'text-ok' }
          : null
  return (
    <>
      <If when={review()}>{(r) => <Text class={cn('text-[11.5px]', r().tone)}>· {r().text}</Text>}</If>
      <If when={merge()}>{(m) => <Text class={cn('text-[11.5px]', m().tone)}>· {m().text}</Text>}</If>
    </>
  )
}
