import {
  BadgeCheck,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock,
  FileText,
  GitBranch,
  GitPullRequest,
  Globe,
  MoreHorizontal,
  PanelRight,
  Play,
  RotateCw,
  Square,
  Terminal,
  Wand2,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ConversationEntry, Issue, IssueRun } from '@shared/types'
import { isActivePhase, triageLabel } from '@shared/types'
import { Button, IconButton, MenuButton, Toggle } from '@/components/kit'
import { AccessPicker, ModelPicker } from './AgentPickers'
import { Composer } from './Composer'
import { ActivityGroup, buildTurns, type Item, TurnView } from './Transcript'
import { useTranscriptLayout } from '@/store/tabs'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { cx } from '@/lib/format'
import { isApproved } from '@/lib/issues'
import { useApp } from '@/store/app'
import { useIssues } from '@/store/issues'
import { PhaseBadge, shelfMenu } from './IssueSidebar'
import { Attachments, AttachmentsLabel, Comments } from './IssueExtras'
import { IssuePanel, RunControl } from './IssuePanel'
import { Markdown } from './Markdown'
import { AgentAvatar, PeopleStack, PersonAvatar } from '@/components/person'
import { peopleByField } from '@/lib/people'

/**
 * One issue's whole story as a single conversation, the way agent apps read: your messages on the
 * right, the agent's prose full width, its tool calls folded one line per stretch of work, and the
 * reviewer's verdict as a card in the flow.
 */
export function IssueDetail({ issue }: { issue: Issue }) {
  const run = useIssues((s) => s.runs[issue.id])
  const entries = useIssues((s) => s.transcripts[issue.id]) ?? []
  const loadTranscript = useIssues((s) => s.loadTranscript)
  const busy = !!run && isActivePhase(run.phase)
  // Waiting its turn in the fix queue: nothing is running yet.
  const queued = run?.phase === 'queued'
  const perform = useIssues((s) => s.perform)

  const loadComments = useIssues((s) => s.loadComments)
  useEffect(() => void loadTranscript(issue.id), [issue.id, loadTranscript])
  useEffect(() => void loadComments(issue.id), [issue.id, loadComments])

  const [panel, setPanel] = useState(() => localStorage.getItem('teabranch.issuePanel') !== 'closed')
  const togglePanel = () => {
    localStorage.setItem('teabranch.issuePanel', panel ? 'closed' : 'open')
    setPanel(!panel)
  }

  return (
    <div className="flex h-full flex-col">
      <Header issue={issue} run={run} busy={busy} panel={panel} onTogglePanel={togglePanel} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Conversation issue={issue} run={run} entries={entries} live={busy && !queued} />
          {run && (
            <Composer
              uploadKey={issue.id}
              busy={busy}
              waiting={queued}
              queued={run.queued}
              canSteer={run.phase === 'triaging' || run.phase === 'fixing'}
              contextUsage={run.context}
              placeholder={t('给 {key} 的 agent 发消息，可粘贴或拖入截图', { key: issue.key })}
              context={
                <>
                  <GitBranch className="size-3" />
                  <span className="truncate">{run.branch}</span>
                  {run.prURL && <span>· PR #{run.prURL.split('/').pop()}</span>}
                </>
              }
              pickers={
                <>
                  <ModelPicker model={run.model} onChange={(model) => void perform(() => api.setIssueModel(issue.id, model))} />
                  <AccessPicker access={run.access} onChange={(access) => void perform(() => api.setIssueAccess(issue.id, access))} />
                </>
              }
              onSend={(message, attachments, steer) => void perform(() => api.sendToAgent(issue, message, attachments, steer))}
              onSteer={(queuedId) => void perform(() => api.steerIssueMessage(issue, queuedId))}
              onUnqueue={(queuedId) => void perform(() => api.unqueueIssueMessage(issue.id, queuedId))}
              onCancel={() => void perform(() => api.cancelIssue(issue.id))}
            />
          )}
        </div>
        {panel && (
          <div className="w-[380px] shrink-0 border-l bg-sidebar/50">
            <IssuePanel key={issue.id} issue={issue} run={run} />
          </div>
        )}
      </div>
    </div>
  )
}

// MARK: - Header

function Header({
  issue,
  run,
  busy,
  panel,
  onTogglePanel,
}: {
  issue: Issue
  run?: IssueRun
  busy: boolean
  panel: boolean
  onTogglePanel: () => void
}) {
  const perform = useIssues((s) => s.perform)
  const setApp = useApp((s) => s.set)
  const prNumber = run?.prURL?.split('/').pop()
  const queue = useIssues((s) => s.queue)

  return (
    <header className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 font-mono text-[11.5px] text-fg-3">{issue.key}</span>
          <h1 className="truncate text-[14px] font-semibold" title={issue.title}>
            {issue.title}
          </h1>
        </div>
        <div className="mt-px flex items-center gap-2 text-[11px] text-fg-2">
          {run ? (
            <>
              <PhaseBadge phase={run.phase} />
              <Chip
                icon={<GitBranch className="size-3" />}
                title={t('在分支页打开：dev server、预览')}
                onClick={() => setApp({ section: 'branches', selectedBranch: run.branch })}
              >
                {run.branch}
              </Chip>
              {run.prURL && (
                <Chip icon={<GitPullRequest className="size-3" />} title={run.prURL} onClick={() => void api.openExternal(run.prURL!)}>
                  PR #{prNumber}
                </Chip>
              )}
              {run.costUSD > 0 && (
                <span className="text-fg-3 tabular-nums" title={t('Claude 报告的累计花费')}>
                  ${run.costUSD.toFixed(2)}
                </span>
              )}
              {run.phase === 'failed' && run.lastError && <span className="truncate text-err">{run.lastError}</span>}
              {run.triage && (
                <span
                  className={cx('truncate', run.triage.verdict === 'bug' ? 'text-fg-3' : 'text-warn')}
                  title={t('修复前验证的结论；理由在对话里')}
                >
                  {t('验证：{verdict}', { verdict: triageLabel[run.triage.verdict] })}
                </span>
              )}
            </>
          ) : (
            issue.status && <span>{issue.status}</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1">
        {busy ? (
          <Button tone="danger" icon={<Square className="size-3" />} onClick={() => void perform(() => api.cancelIssue(issue.id))}>
            {t('停止')}
          </Button>
        ) : (
          <>
            {(run?.phase === 'failed' || run?.phase === 'cancelled') && (
              <Button tone="accent" icon={<RotateCw className="size-3.5" />} onClick={() => void perform(() => api.enqueueFix([issue]))}>
                {t('重试')}
              </Button>
            )}
            {run?.phase === 'triaged' && (
              <Button
                tone="accent"
                icon={<Wand2 className="size-3.5" />}
                title={t('验证认为不用修；看过理由后仍要修，就在同一个会话里接着修')}
                onClick={() => void perform(() => api.fixAnyway(issue))}
              >
                {t('仍然修复')}
              </Button>
            )}
          </>
        )}
        {run && (
          <>
            <span className="mr-1 border-r pr-2">
              <RunControl branch={run.branch} />
            </span>
            <IconButton label={t('Review 当前分支')} disabled={busy} onClick={() => void perform(() => api.review(issue))}>
              <BadgeCheck className="size-4" />
            </IconButton>
            <IconButton
              label={t('在终端里继续这个会话（claude --resume）')}
              disabled={busy}
              onClick={() => void perform(() => api.resumeInTerminal(issue.id))}
            >
              <Terminal className="size-4" />
            </IconButton>
          </>
        )}
        {peopleByField(issue).length > 0 && (
          <span className="mr-1 flex items-center gap-2 border-r pr-2.5">
            {peopleByField(issue).map(([field, people]) => (
              <span key={field} className="flex items-center gap-1 text-[11px] text-fg-2" title={field}>
                <PeopleStack people={people} max={2} />
              </span>
            ))}
          </span>
        )}
        <IconButton label={t('在 Teable 打开')} onClick={() => void perform(() => openRecord(issue))}>
          <Globe className="size-4" />
        </IconButton>
        <IconButton label={t('运行、改动和详情')} onClick={onTogglePanel} className={panel ? 'bg-accent text-foreground' : undefined}>
          <PanelRight className="size-4" />
        </IconButton>
        <MenuButton
          label={t('更多')}
          entries={() => [
            { label: t('Issue 设置…'), onSelect: () => useIssues.setState({ showSettings: true }) },
            {
              label: t('对话布局'),
              items: (['document', 'chat'] as const).map((value) => ({
                label: value === 'document' ? t('文档（MonoCode 默认）') : t('聊天气泡'),
                checked: useTranscriptLayout.getState().layout === value,
                onSelect: () => useTranscriptLayout.getState().setLayout(value),
              })),
            },
            ...shelfMenu(run, queue.waiting.includes(issue.id)),
            ...(run
              ? [
                  {
                    label: t('复制会话恢复命令'),
                    onSelect: () => void navigator.clipboard.writeText(`claude --resume ${run.sessionId}`),
                  },
                  'separator' as const,
                  {
                    label: t('重置会话记录'),
                    danger: true,
                    disabled: busy,
                    onSelect: () => void perform(() => api.resetIssue(issue.id)),
                  },
                ]
              : []),
          ]}
        >
          <MoreHorizontal className="size-4" />
        </MenuButton>
      </div>
    </header>
  )
}

async function openRecord(issue: Issue): Promise<void> {
  const config = await api.teableConfig()
  const view = config.viewId ? `/${config.viewId}` : ''
  await api.openExternal(`${config.baseURL.replace(/\/+$/, '')}/base/${config.baseId}/table/${config.tableId}${view}?recordId=${issue.id}`)
}

function Chip({
  icon,
  children,
  title,
  onClick,
}: {
  icon: React.ReactNode
  children: React.ReactNode
  title?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="inline-flex max-w-56 items-center gap-1 rounded px-1 font-mono hover:bg-fill-hover hover:text-fg"
    >
      {icon}
      <span className="truncate">{children}</span>
    </button>
  )
}

// MARK: - Conversation

function Conversation({ issue, run, entries, live }: { issue: Issue; run?: IssueRun; entries: ConversationEntry[]; live: boolean }) {
  const turns = useMemo(() => buildTurns(entries, live), [entries, live])
  const layout = useTranscriptLayout((s) => s.layout)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  // Stay at the bottom while the user is there; leave them alone once they scroll up to read.
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  }, [entries.length])

  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex max-w-[760px] flex-col gap-5 px-6 py-6">
        <IssueCard issue={issue} startOpen={!run} />
        <IssueComments recordId={issue.id} />
        {!run && <StartPrompt issue={issue} />}
        {run?.phase === 'queued' && <QueuedNote recordId={issue.id} />}
        {turns.map((turn) => (
          <TurnView
            key={turn.id}
            turn={turn}
            layout={layout}
            renderItem={(item) => <ItemView item={item} hasPR={!!run?.prURL} issue={issue} busy={live} />}
          />
        ))}
      </div>
    </div>
  )
}

/** Where a queued issue stands: its place in line, and whether the line waits on you. */
function QueuedNote({ recordId }: { recordId: string }) {
  const queue = useIssues((s) => s.queue)
  const perform = useIssues((s) => s.perform)
  const position = queue.waiting.indexOf(recordId) + 1
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-[12.5px] text-muted-foreground">
      <Clock className="size-3.5 shrink-0" />
      <span className="flex-1">
        {position ? t('在修复队列里排第 {n}', { n: position }) : t('在修复队列里')}
        {queue.awaitingNextBatch && t('；上一批跑完了，等你审查后点“开始下一批”')}
      </span>
      {queue.awaitingNextBatch && (
        <Button
          tone="accent"
          className="h-6 px-2 text-[11px]"
          icon={<Play className="size-3" />}
          onClick={() => void perform(() => api.startNextBatch())}
        >
          {t('开始下一批')}
        </Button>
      )}
    </div>
  )
}

function IssueComments({ recordId }: { recordId: string }) {
  const comments = useIssues((s) => s.comments[recordId])
  return comments ? <Comments comments={comments} /> : null
}

function StartPrompt({ issue }: { issue: Issue }) {
  const perform = useIssues((s) => s.perform)
  const triage = useIssues((s) => s.config?.triage ?? true)
  const updateConfig = useIssues((s) => s.updateConfig)
  // The pipeline as a row of short steps; the detail lives in tooltips, not a paragraph.
  const steps = [
    { label: t('验证'), hint: t('查是否已被修复、本地复现、判断是不是 bug；确认是 bug 才往下修'), off: !triage },
    { label: t('修复'), hint: t('在 {key} 的 worktree 里定位根因并修复', { key: issue.key }) },
    { label: t('提 PR'), hint: t('PR 标题带 {key}', { key: issue.key }) },
    { label: 'Review', hint: t('自动 review，结论回到这里') },
  ].filter((step) => !step.off)
  return (
    <div className="flex flex-col items-center gap-4 py-10">
      <div className="flex items-center gap-1.5 text-[12px] text-fg-3">
        {steps.map((step, index) => (
          <span key={step.label} className="flex items-center gap-1.5">
            {index > 0 && <span className="h-px w-4 bg-border" />}
            <span title={step.hint} className="cursor-default rounded-full border px-2 py-0.5">
              {step.label}
            </span>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-4">
        <Button
          tone="accent"
          className="h-8 px-4"
          icon={<Wand2 className="size-4" />}
          onClick={() => void perform(() => api.enqueueFix([issue]))}
        >
          {t('自动修复')}
        </Button>
        <span title={t('查是否已被修复、本地复现、判断是不是 bug；不是 bug 就停下等你决定')} className="text-fg-2">
          <Toggle checked={triage} onChange={(value) => void updateConfig({ triage: value })} label={t('先验证')} />
        </span>
      </div>
    </div>
  )
}

function ItemView({ item, hasPR, issue, busy }: { item: Item; hasPR: boolean; issue: Issue; busy: boolean }) {
  switch (item.kind) {
    case 'user':
      return (
        // Your own messages: a bubble on the right, like any chat app; the agent's reply is the page.
        <div className="flex justify-end pl-16">
          <div className="selectable max-w-[80%] rounded-2xl rounded-br-md bg-muted px-3.5 py-2 text-[13.5px] leading-relaxed break-words whitespace-pre-wrap">
            {item.entry.text}
          </div>
        </div>
      )
    case 'assistant':
      return (
        <div className="min-w-0 text-[14px]">
          <Markdown text={item.entry.text} />
        </div>
      )
    case 'review':
      return <ReviewCard text={item.entry.text} hasPR={hasPR} issue={issue} busy={busy} />
    case 'error':
      return (
        <div className="selectable flex items-start gap-2 rounded-lg bg-err-soft px-3 py-2 text-[12px] text-err">
          <CircleAlert className="mt-px size-3.5 shrink-0" />
          <span className="whitespace-pre-wrap">{item.entry.text}</span>
        </div>
      )
    case 'result':
      return (
        <div className={cx('flex items-center gap-1.5 text-[11px] tabular-nums', item.entry.isError ? 'text-err' : 'text-fg-3')}>
          {item.entry.isError ? <CircleAlert className="size-3" /> : <CircleCheck className="size-3" />}
          {item.entry.text}
        </div>
      )
    case 'work':
      return <ActivityGroup steps={item.steps} live={item.live} review={item.channel === 'review'} />
  }
}

function ReviewCard({ text, hasPR, issue, busy }: { text: string; hasPR: boolean; issue: Issue; busy: boolean }) {
  const perform = useIssues((s) => s.perform)
  const approved = isApproved(text)
  return (
    <div className="rounded-xl border bg-card p-4 shadow-xs">
      <div className="mb-2 flex items-center gap-2">
        <AgentAvatar review />
        <span className="text-[13px] font-semibold">Code review</span>
        <span className={cx('rounded-full px-2 py-px text-[11px] font-semibold', approved ? 'bg-ok/15 text-ok' : 'bg-warn/15 text-warn')}>
          {approved ? t('通过') : t('需要修改')}
        </span>
      </div>
      <div className="text-[13px]">
        <Markdown text={text} />
      </div>
      {(!approved || hasPR) && (
        <div className="mt-3 flex gap-2">
          {!approved && (
            <Button disabled={busy} onClick={() => void perform(() => api.sendLatestReview(issue))}>
              {t('发给 agent 修改')}
            </Button>
          )}
          {hasPR && <Button onClick={() => void perform(() => api.postLatestReview(issue.id))}>{t('发布到 PR')}</Button>}
        </div>
      )}
    </div>
  )
}

/** The issue itself, at the head of its conversation — folded once work has started. */
function IssueCard({ issue, startOpen }: { issue: Issue; startOpen: boolean }) {
  const fields = useIssues((s) => s.fields)
  const [open, setOpen] = useState(startOpen)
  const attachments = Object.values(issue.record.attachments ?? {}).flat()
  const extra = fields.filter((field) => {
    const value = issue.record.fields[field.name]
    // Attachments render as thumbnails below; their text form is "name (token)" noise.
    return value && value !== issue.body && value !== issue.title && !issue.record.attachments?.[field.name]
  })
  return (
    <div className="rounded-xl border bg-card px-4 py-3 shadow-xs">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-left text-[12px] text-fg-2">
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <FileText className="size-3.5 shrink-0" />
        <span className="shrink-0 font-semibold whitespace-nowrap">{t('Issue 描述')}</span>
        {!open && issue.body && <span className="min-w-0 truncate text-fg-3">{issue.body.replace(/\n/g, ' ').replace(/[#*`>]/g, '')}</span>}
        {!open && attachments.length > 0 && (
          <span className="ml-auto shrink-0">
            <AttachmentsLabel count={attachments.length} />
          </span>
        )}
      </button>
      {open && (
        <div className="mt-2.5 pl-5.5">
          {issue.body && (
            <div className="text-[13px]">
              <Markdown text={issue.body} />
            </div>
          )}
          {attachments.length > 0 && (
            <div className="mt-3">
              <Attachments attachments={attachments} />
            </div>
          )}
          {extra.length > 0 && (
            <div className="selectable mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
              {extra.map((field) => (
                <div key={field.id} className="contents">
                  <span className="text-fg-3">{field.name}</span>
                  {issue.record.people?.[field.name] ? (
                    <span className="flex flex-wrap items-center gap-2">
                      {issue.record.people[field.name].map((person) => (
                        <span key={person.name} className="inline-flex items-center gap-1.5">
                          <PersonAvatar person={person} tooltip={false} />
                          {person.name}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="line-clamp-3 break-all">{issue.record.fields[field.name]}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
