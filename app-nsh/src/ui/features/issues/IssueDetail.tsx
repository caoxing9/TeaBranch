import { Clipboard, type JSX, Text, View, computed, signal } from 'nsh'
import { t } from '../../../shared/i18n'
import { isApproved } from '../../../shared/issues'
import type { Issue, IssueRun } from '../../../shared/types'
import { isActivePhase, triageLabel } from '../../../shared/types'
import { Icon, type IconName } from '../../components/Icon'
import { Button, IconButton, MenuButton, TitleStrip, Toggle } from '../../components/kit'
import { Markdown } from '../../components/Markdown'
import { AgentAvatar, PeopleStack, PersonAvatar } from '../../components/person'
import { api } from '../../lib/api'
import { peopleByField } from '../../lib/people'
import { cn } from '../../lib/utils'
import { pref, setPref } from '../../prefs'
import { app } from '../../store/app'
import { issues } from '../../store/issues'
import { transcriptLayout } from '../../store/tabs'
import { AccessPicker, ModelPicker } from './AgentPickers'
import { CIStatus } from './CIStatus'
import { Composer } from './Composer'
import { Attachments, AttachmentsLabel, Comments } from './IssueExtras'
import { IssuePanel, RunControl, showBrowserTab } from './IssuePanel'
import { shelfMenu } from './IssueSidebar'
import { PhaseBadge } from './phase'
import { ActivityGroup, BackgroundActivity, type Item, TranscriptScroll, TurnView, buildTurns } from './Transcript'

const PANEL_KEY = 'teabranch.issuePanel'

/**
 * One issue's whole story as a single conversation, the way agent apps read: your messages on the
 * right, the agent's prose full width, its tool calls folded one line per stretch of work, and the
 * reviewer's verdict as a card in the flow.
 */
export function IssueDetail(props: { issue: Issue }) {
  // Another issue is another view: its own scroll position, folds and drafts.
  return (
    <Each of={[props.issue]} key={(issue) => issue.id}>
      {(issue) => <IssueBody issue={issue()} />}
    </Each>
  )
}

function IssueBody(props: { issue: Issue }) {
  const run = (): IssueRun | undefined => issues.runs()[props.issue.id]
  const busy = () => {
    const current = run()
    return !!current && isActivePhase(current.phase)
  }
  // Waiting its turn in the fix queue: nothing is running yet.
  const queued = () => run()?.phase === 'queued'
  const perform = (work: () => Promise<unknown>) => void issues.perform(work)
  void issues.loadTranscript(props.issue.id)
  void issues.loadComments(props.issue.id)

  const panel = signal(pref<string>(PANEL_KEY, 'open') !== 'closed')
  const togglePanel = () => {
    setPref(PANEL_KEY, panel() ? 'closed' : 'open')
    panel.set(!panel())
  }
  const wide = signal(false)
  const sent = signal(0)

  return (
    <View class="flex-1">
      <Header issue={props.issue} run={run()} busy={busy()} panel={panel()} onTogglePanel={togglePanel} />
      <View class="min-h-0 flex-1 flex-row">
        <View class="min-w-0 flex-1">
          <Conversation issue={props.issue} run={run()} live={busy() && !queued()} sent={sent()} />
          <If when={run()}>
            {(current) => (
              <Composer
                uploadKey={props.issue.id}
                busy={busy()}
                waiting={queued()}
                queued={current().queued}
                canSteer={current().phase === 'triaging' || current().phase === 'fixing'}
                contextUsage={current().context}
                placeholder={t('给 {key} 的 agent 发消息，可粘贴或拖入截图', { key: props.issue.key })}
                context={
                  <>
                    <Icon name="git-branch" size={12} tint="fg-2" />
                    <Text class="font-mono text-[11px] text-fg-2" style={{ numberOfLines: 1 }}>
                      {current().branch}
                    </Text>
                    <If when={current().prURL}>{(url) => <Text class="font-mono text-[11px] text-fg-2">· PR #{url().split('/').pop()}</Text>}</If>
                  </>
                }
                pickers={
                  <>
                    <ModelPicker model={current().model} onChange={(model) => perform(() => api.setIssueModel(props.issue.id, model))} />
                    <AccessPicker access={current().access} onChange={(access) => perform(() => api.setIssueAccess(props.issue.id, access))} />
                  </>
                }
                onSend={(message, attachments, steer) => {
                  sent.set(sent() + 1)
                  perform(() => api.sendToAgent(props.issue, message, attachments, steer))
                }}
                onSteer={(queuedId) => perform(() => api.steerIssueMessage(props.issue, queuedId))}
                onUnqueue={(queuedId) => perform(() => api.unqueueIssueMessage(props.issue.id, queuedId))}
                onCancel={() => perform(() => api.cancelIssue(props.issue.id))}
              />
            )}
          </If>
        </View>
        <If when={panel()}>
          <View class="shrink-0 border-l border-border bg-sidebar/50" style={{ width: wide() ? '60%' : 380 }}>
            <IssuePanel issue={props.issue} run={run()} onWide={(value) => wide.set(value)} />
          </View>
        </If>
      </View>
    </View>
  )
}

// MARK: - Header

function Header(props: { issue: Issue; run?: IssueRun; busy: boolean; panel: boolean; onTogglePanel: () => void }) {
  const perform = (work: () => Promise<unknown>) => void issues.perform(work)
  const prNumber = () => props.run?.prURL?.split('/').pop()
  const people = () => peopleByField(props.issue)
  const phase = () => props.run?.phase
  return (
    <TitleStrip class="h-[52px] gap-3 border-b border-border px-4">
      <View class="min-w-0 flex-1">
        <View class="flex-row items-baseline gap-2">
          <Text class="shrink-0 font-mono text-[11.5px] text-fg-3">{props.issue.key}</Text>
          <Text class="min-w-0 flex-1 text-[14px] font-semibold text-fg" style={{ numberOfLines: 1 }} tooltip={props.issue.title}>
            {props.issue.title}
          </Text>
        </View>
        <View class="mt-px flex-row items-center gap-2">
          <If
            when={props.run}
            else={
              <If when={props.issue.status}>
                <Text class="text-[11px] text-fg-2">{props.issue.status}</Text>
              </If>
            }
          >
            {(run) => (
              <>
                <PhaseBadge phase={run().phase} recordId={run().recordId} />
                <Chip
                  icon="git-branch"
                  title={t('在分支页打开：dev server、预览')}
                  onPress={() => app.go({ section: 'branches', selectedBranch: run().branch })}
                >
                  {run().branch}
                </Chip>
                <If when={run().prURL}>
                  {(url) => (
                    <Chip icon="git-pull-request" title={url()} onPress={() => void api.openExternal(url())}>
                      {`PR #${prNumber()}`}
                    </Chip>
                  )}
                </If>
                <If when={run().prURL}>
                  <CIStatus issue={props.issue} run={run()} busy={props.busy} />
                </If>
                <If when={run().costUSD > 0}>
                  <Text class="text-[11px] text-fg-3 tabular-nums" tooltip={t('Claude 报告的累计花费')}>
                    ${run().costUSD.toFixed(2)}
                  </Text>
                </If>
                <If when={run().phase === 'failed' ? run().lastError : undefined}>
                  {(error) => (
                    <Text class="min-w-0 shrink text-[11px] text-err" style={{ numberOfLines: 1 }}>
                      {error()}
                    </Text>
                  )}
                </If>
                <If when={run().triage}>
                  {(triage) => (
                    <Text
                      class={cn('min-w-0 shrink text-[11px]', triage().verdict === 'bug' ? 'text-fg-3' : 'text-warn')}
                      style={{ numberOfLines: 1 }}
                      tooltip={t('修复前验证的结论；理由在对话里')}
                    >
                      {t('验证：{verdict}', { verdict: triageLabel[triage().verdict] })}
                    </Text>
                  )}
                </If>
              </>
            )}
          </If>
        </View>
      </View>

      <View class="flex-row items-center gap-1">
        <If
          when={props.busy || phase() === 'paused'}
          else={
            <>
              <If when={phase() === 'failed' || phase() === 'cancelled'}>
                <Button tone="accent" icon={<Icon name="rotate-cw" size={14} tint="#ffffff" />} onPress={() => perform(() => api.fixNow(props.issue))}>
                  {t('重试')}
                </Button>
              </If>
              <If when={phase() === 'triaged'}>
                <Button
                  tone="accent"
                  icon={<Icon name="wand-2" size={14} tint="#ffffff" />}
                  title={t('验证认为不用修；看过理由后仍要修，就在同一个会话里接着修')}
                  onPress={() => perform(() => api.fixAnyway(props.issue))}
                >
                  {t('仍然修复')}
                </Button>
              </If>
            </>
          }
        >
          <If
            when={phase() === 'paused'}
            else={
              <If when={phase() !== 'queued'}>
                <Button
                  icon={<Icon name="pause" size={12} tint="fg" />}
                  title={t('停下这一步，保留会话和位置，之后可以继续')}
                  onPress={() => perform(() => api.pauseIssue(props.issue.id))}
                >
                  {t('暂停')}
                </Button>
              </If>
            }
          >
            <Button
              tone="accent"
              icon={<Icon name="play" size={12} tint="#ffffff" />}
              title={t('从暂停的那一步接着跑，沿用同一个会话')}
              onPress={() => perform(() => api.resumeIssue(props.issue.id))}
            >
              {t('继续')}
            </Button>
          </If>
          <Button tone="danger" icon={<Icon name="square" size={12} tint="#ffffff" />} onPress={() => perform(() => api.cancelIssue(props.issue.id))}>
            {t('停止')}
          </Button>
        </If>
        <If when={props.run}>
          {(run) => (
            <>
              <View class="mr-1 border-r border-border pr-2">
                <RunControl
                  branch={run().branch}
                  onPreview={() => {
                    showBrowserTab()
                    if (!props.panel) props.onTogglePanel()
                  }}
                />
              </View>
              <IconButton label={t('Review 当前分支')} disabled={props.busy} onPress={() => perform(() => api.review(props.issue))}>
                <Icon name="badge-check" size={16} tint="fg-2" />
              </IconButton>
              <IconButton
                label={t('在终端里继续这个会话（claude --resume）')}
                disabled={props.busy}
                onPress={() => perform(() => api.resumeInTerminal(props.issue.id))}
              >
                <Icon name="terminal" size={16} tint="fg-2" />
              </IconButton>
            </>
          )}
        </If>
        <If when={people().length > 0}>
          <View class="mr-1 flex-row items-center gap-2 border-r border-border pr-2.5">
            <Each of={people()} key={(entry) => entry[0]}>
              {(entry) => (
                <View class="flex-row items-center gap-1" tooltip={entry()[0]}>
                  <PeopleStack people={entry()[1]} max={2} />
                </View>
              )}
            </Each>
          </View>
        </If>
        <IconButton label={t('在 Teable 打开')} onPress={() => perform(() => openRecord(props.issue))}>
          <Icon name="globe" size={16} tint="fg-2" />
        </IconButton>
        <IconButton label={t('运行、改动和详情')} class={props.panel ? 'bg-accent' : undefined} onPress={props.onTogglePanel}>
          <Icon name="panel-right" size={16} tint={props.panel ? 'fg' : 'fg-2'} />
        </IconButton>
        <MenuButton
          label={t('更多')}
          entries={() => [
            { label: t('Issue 设置…'), onSelect: () => app.openSettings('issueTeable') },
            {
              label: t('对话布局'),
              items: (['document', 'chat'] as const).map((value) => ({
                label: value === 'document' ? t('文档（MonoCode 默认）') : t('聊天气泡'),
                checked: transcriptLayout.layout() === value,
                onSelect: () => transcriptLayout.setLayout(value),
              })),
            },
            ...shelfMenu(props.run, issues.queue().waiting.includes(props.issue.id)),
            ...(props.run
              ? [
                  { label: t('复制会话恢复命令'), onSelect: () => void Clipboard.writeText(`claude --resume ${props.run?.sessionId}`) },
                  'separator' as const,
                  { label: t('重置会话记录'), danger: true, disabled: props.busy, onSelect: () => perform(() => api.resetIssue(props.issue.id)) },
                ]
              : []),
          ]}
        >
          <Icon name="more-horizontal" size={16} tint="fg-2" />
        </MenuButton>
      </View>
    </TitleStrip>
  )
}

async function openRecord(issue: Issue): Promise<void> {
  const config = await api.teableConfig()
  const view = config.viewId ? `/${config.viewId}` : ''
  await api.openExternal(`${config.baseURL.replace(/\/+$/, '')}/base/${config.baseId}/table/${config.tableId}${view}?recordId=${issue.id}`)
}

function Chip(props: { icon: IconName; children: string; title?: string; onPress: () => void }) {
  return (
    <View class="max-w-56 flex-row items-center gap-1 rounded px-1 hover:bg-fill-hover" role="button" tooltip={props.title} onPress={props.onPress}>
      <Icon name={props.icon} size={12} tint="fg-2" />
      <Text class="min-w-0 font-mono text-[11px] text-fg-2" style={{ numberOfLines: 1 }}>
        {props.children}
      </Text>
    </View>
  )
}

// MARK: - Conversation

function Conversation(props: { issue: Issue; run?: IssueRun; live: boolean; sent: number }) {
  const entries = () => issues.transcripts()[props.issue.id] ?? []
  const turns = computed(() => buildTurns(entries(), props.live))
  const perform = (work: () => Promise<unknown>) => void issues.perform(work)
  const render = (item: Item): JSX.Element => <ItemView item={item} hasPR={!!props.run?.prURL} issue={props.issue} busy={props.live} />
  return (
    <TranscriptScroll change={`${entries().length}:${props.run?.background?.length ?? 0}`} sent={String(props.sent)}>
      <IssueCard issue={props.issue} startOpen={!props.run} />
      <If when={issues.comments()[props.issue.id]}>{(comments) => <Comments comments={comments()} />}</If>
      <If when={!props.run}>
        <StartPrompt issue={props.issue} />
      </If>
      <If when={props.run?.phase === 'queued'}>
        <QueuedNote issue={props.issue} />
      </If>
      <Each of={turns()} key={(turn) => turn.id}>
        {(turn) => <TurnView turn={turn()} layout={transcriptLayout.layout()} renderItem={render} />}
      </Each>
      <If when={props.run?.background}>
        {(tasks) => <BackgroundActivity tasks={tasks()} onStop={(taskId) => perform(() => api.stopIssueBackground(props.issue.id, taskId))} />}
      </If>
    </TranscriptScroll>
  )
}

/** Where a queued issue stands: its place in line, and whether the line waits on you. */
function QueuedNote(props: { issue: Issue }) {
  const position = () => issues.queue().waiting.indexOf(props.issue.id) + 1
  const held = () => issues.queue().paused
  return (
    <View class="flex-row items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2">
      <Icon name="clock" size={14} tint="fg-2" />
      <Text class="flex-1 text-[12.5px] text-fg-2">
        {position() ? t('在修复队列里排第 {n}', { n: position() }) : t('在修复队列里')}
        {held() ? t('；队列已暂停') : ''}
      </Text>
      <If when={position() > 0}>
        <Button
          tone={held() ? 'accent' : 'plain'}
          class="h-6 px-2"
          icon={<Icon name="play" size={12} tint={held() ? '#ffffff' : 'fg'} />}
          title={t('不等队列，现在就单独跑这一个')}
          onPress={() => void issues.perform(() => api.fixNow(props.issue))}
        >
          {t('立即开始')}
        </Button>
      </If>
    </View>
  )
}

function StartPrompt(props: { issue: Issue }) {
  const triage = () => issues.config()?.triage ?? true
  // The pipeline as a row of short steps; the detail lives in tooltips, not a paragraph.
  const steps = () =>
    [
      { label: t('验证'), hint: t('查是否已被修复、本地复现、判断是不是 bug；确认是 bug 才往下修'), off: !triage() },
      { label: t('修复'), hint: t('在 {key} 的 worktree 里定位根因并修复', { key: props.issue.key }) },
      { label: t('提 PR'), hint: t('PR 标题带 {key}', { key: props.issue.key }) },
      { label: 'Review', hint: t('自动 review，结论回到这里') },
    ].filter((step) => !step.off)
  return (
    <View class="items-center gap-4 py-10">
      <View class="flex-row items-center gap-1.5">
        <Each of={steps()} key={(step) => step.label}>
          {(step, index) => (
            <View class="flex-row items-center gap-1.5">
              <If when={index() > 0}>
                <View class="h-px w-4 bg-border" />
              </If>
              <View class="rounded-full border border-border px-2 py-0.5" tooltip={step().hint}>
                <Text class="text-[12px] text-fg-3">{step().label}</Text>
              </View>
            </View>
          )}
        </Each>
      </View>
      <View class="flex-row items-center gap-4">
        <Button
          tone="accent"
          class="h-8 px-4"
          icon={<Icon name="wand-2" size={16} tint="#ffffff" />}
          onPress={() => void issues.perform(() => api.fixNow(props.issue))}
        >
          {t('自动修复')}
        </Button>
        <View tooltip={t('查是否已被修复、本地复现、判断是不是 bug；不是 bug 就停下等你决定')}>
          <Toggle checked={triage()} onChange={(value) => void issues.updateConfig({ triage: value })} label={t('先验证')} />
        </View>
      </View>
    </View>
  )
}

/** One item of a turn. An item's kind never changes, so the branch is picked once. */
function ItemView(props: { item: Item; hasPR: boolean; issue: Issue; busy: boolean }) {
  const item = props.item
  switch (item.kind) {
    case 'user':
      // Your own messages: a bubble on the right, like any chat app; the agent's reply is the page.
      return (
        <View class="flex-row justify-end pl-16">
          <View class="max-w-[80%] rounded-2xl rounded-br-md bg-muted px-3.5 py-2">
            <Text class="text-[13.5px] leading-relaxed text-fg" style={{ userSelect: 'text' }}>
              {entryText(props)}
            </Text>
          </View>
        </View>
      )
    case 'assistant':
      return <Markdown text={entryText(props)} class="text-[14px] leading-[1.65] text-fg" />
    case 'review':
      return <ReviewCard text={entryText(props)} hasPR={props.hasPR} issue={props.issue} busy={props.busy} />
    case 'error':
      return (
        <View class="flex-row items-start gap-2 rounded-lg bg-err-soft px-3 py-2">
          <Icon name="circle-alert" size={14} tint="err" class="mt-px" />
          <Text class="flex-1 text-[12px] text-err" style={{ userSelect: 'text' }}>
            {entryText(props)}
          </Text>
        </View>
      )
    case 'result':
      return (
        <View class="flex-row items-center gap-1.5">
          <Icon name={item.entry.isError ? 'circle-alert' : 'circle-check'} size={12} tint={item.entry.isError ? 'err' : 'fg-3'} />
          <Text class={cn('text-[11px] tabular-nums', item.entry.isError ? 'text-err' : 'text-fg-3')}>{entryText(props)}</Text>
        </View>
      )
    case 'task':
      return <Text class="text-[12px] text-fg-2">{entryText(props)}</Text>
    case 'work':
      return (
        <ActivityGroup steps={workOf(props).steps} subagents={workOf(props).subagents} live={workOf(props).live} review={workOf(props).channel === 'review'} />
      )
  }
}

const entryText = (props: { item: Item }): string => (props.item.kind === 'work' ? '' : props.item.entry.text)
const workOf = (props: { item: Item }) => props.item as Extract<Item, { kind: 'work' }>

function ReviewCard(props: { text: string; hasPR: boolean; issue: Issue; busy: boolean }) {
  const approved = () => isApproved(props.text)
  return (
    <View class="rounded-xl border border-border bg-card p-4 shadow-xs">
      <View class="mb-2 flex-row items-center gap-2">
        <AgentAvatar review />
        <Text class="text-[13px] font-semibold text-fg">Code review</Text>
        <View class={cn('rounded-full px-2 py-px', approved() ? 'bg-ok/15' : 'bg-warn/15')}>
          <Text class={cn('text-[11px] font-semibold', approved() ? 'text-ok' : 'text-warn')}>{approved() ? t('通过') : t('需要修改')}</Text>
        </View>
      </View>
      <Markdown text={props.text} class="text-[13px] leading-[1.6] text-fg" />
      <If when={!approved() || props.hasPR}>
        <View class="mt-3 flex-row gap-2">
          <If when={!approved()}>
            <Button disabled={props.busy} onPress={() => void issues.perform(() => api.sendLatestReview(props.issue))}>
              {t('发给 agent 修改')}
            </Button>
          </If>
          <If when={props.hasPR}>
            <Button onPress={() => void issues.perform(() => api.postLatestReview(props.issue.id))}>{t('发布到 PR')}</Button>
          </If>
        </View>
      </If>
    </View>
  )
}

/** The issue itself, at the head of its conversation — folded once work has started. */
function IssueCard(props: { issue: Issue; startOpen: boolean }) {
  const open = signal(props.startOpen)
  const attachments = () => Object.values(props.issue.record.attachments ?? {}).flat()
  const extra = () =>
    issues.fields().filter((field) => {
      const value = props.issue.record.fields[field.name]
      // Attachments render as thumbnails below; their text form is "name (token)" noise.
      return value && value !== props.issue.body && value !== props.issue.title && !props.issue.record.attachments?.[field.name]
    })
  const summary = () => props.issue.body.replace(/\n/g, ' ').replace(/[#*`>]/g, '')
  return (
    <View class="rounded-xl border border-border bg-card px-4 py-3 shadow-xs">
      <View class="flex-row items-center gap-2" role="button" onPress={() => open.set(!open())}>
        <Icon name={open() ? 'chevron-down' : 'chevron-right'} size={14} tint="fg-2" />
        <Icon name="file-text" size={14} tint="fg-2" />
        <Text class="shrink-0 text-[12px] font-semibold text-fg-2">{t('Issue 描述')}</Text>
        <If when={!open() && props.issue.body}>
          <Text class="min-w-0 flex-1 text-[12px] text-fg-3" style={{ numberOfLines: 1 }}>
            {summary()}
          </Text>
        </If>
        <If when={!open() && attachments().length > 0}>
          <View class="ml-auto shrink-0">
            <AttachmentsLabel count={attachments().length} />
          </View>
        </If>
      </View>
      <If when={open()}>
        <View class="mt-2.5 pl-[22px]">
          <If when={props.issue.body}>
            <Markdown text={props.issue.body} class="text-[13px] leading-[1.6] text-fg" />
          </If>
          <If when={attachments().length > 0}>
            <View class="mt-3">
              <Attachments attachments={attachments()} />
            </View>
          </If>
          <If when={extra().length > 0}>
            <View class="mt-3 gap-1">
              <Each of={extra()} key={(field) => field.id}>
                {(field) => (
                  <View class="flex-row items-start gap-4">
                    <Text class="w-24 shrink-0 text-[12px] text-fg-3">{field().name}</Text>
                    <If
                      when={props.issue.record.people?.[field().name]}
                      else={
                        <Text class="min-w-0 flex-1 text-[12px] text-fg" style={{ numberOfLines: 3, userSelect: 'text' }}>
                          {props.issue.record.fields[field().name]}
                        </Text>
                      }
                    >
                      {(people) => (
                        <View class="min-w-0 flex-1 flex-row flex-wrap items-center gap-2">
                          <Each of={people()} key={(person) => person.name}>
                            {(person) => (
                              <View class="flex-row items-center gap-1.5">
                                <PersonAvatar person={person()} tooltip={false} />
                                <Text class="text-[12px] text-fg">{person().name}</Text>
                              </View>
                            )}
                          </Each>
                        </View>
                      )}
                    </If>
                  </View>
                )}
              </Each>
            </View>
          </If>
        </View>
      </If>
    </View>
  )
}
