import {
  ArrowUp,
  BadgeCheck,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Cpu,
  FileText,
  GitBranch,
  GitPullRequest,
  Globe,
  MoreHorizontal,
  Plus,
  PanelRight,
  Pencil,
  RotateCw,
  Search,
  Settings2,
  Square,
  Terminal,
  Users,
  Wand2,
  Wrench,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ConversationEntry, EntryChannel, Issue, IssueRun } from '@shared/types'
import { agentModelLabel, isActivePhase } from '@shared/types'
import type { AgentModel } from '@shared/types'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button, IconButton, MenuButton, Spinner } from '@/components/kit'
import { api } from '@/lib/api'
import { cx } from '@/lib/format'
import { isApproved } from '@/lib/issues'
import { useApp } from '@/store/app'
import { useIssues } from '@/store/issues'
import { PhaseBadge } from './IssueSidebar'
import { Attachments, AttachmentsLabel, Comments } from './IssueExtras'
import { IssuePanel } from './IssuePanel'
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
          <Conversation issue={issue} run={run} entries={entries} live={busy} />
          {run && <Composer issue={issue} run={run} busy={busy} />}
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
                title="在分支页打开：dev server、预览"
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
                <span className="text-fg-3 tabular-nums" title="Claude 报告的累计花费">
                  ${run.costUSD.toFixed(2)}
                </span>
              )}
              {run.phase === 'failed' && run.lastError && <span className="truncate text-err">{run.lastError}</span>}
            </>
          ) : (
            issue.status && <span>{issue.status}</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1">
        {busy ? (
          <Button tone="danger" icon={<Square className="size-3" />} onClick={() => void perform(() => api.cancelIssue(issue.id))}>
            停止
          </Button>
        ) : (
          (run?.phase === 'failed' || run?.phase === 'cancelled') && (
            <Button tone="accent" icon={<RotateCw className="size-3.5" />} onClick={() => void perform(() => api.enqueueFix([issue]))}>
              重试
            </Button>
          )
        )}
        {run && (
          <>
            <IconButton label="Review 当前分支" disabled={busy} onClick={() => void perform(() => api.review(issue))}>
              <BadgeCheck className="size-4" />
            </IconButton>
            <IconButton
              label="在终端里继续这个会话（claude --resume）"
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
        <IconButton label="在 Teable 打开" onClick={() => void perform(() => openRecord(issue))}>
          <Globe className="size-4" />
        </IconButton>
        <IconButton label="运行、改动和详情" onClick={onTogglePanel} className={panel ? 'bg-accent text-foreground' : undefined}>
          <PanelRight className="size-4" />
        </IconButton>
        <MenuButton
          label="更多"
          entries={() => [
            { label: 'Issue 设置…', onSelect: () => useIssues.setState({ showSettings: true }) },
            ...(run
              ? [
                  'separator' as const,
                  {
                    label: '重置会话记录',
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
  await api.openExternal(
    `${config.baseURL.replace(/\/+$/, '')}/base/${config.baseId}/table/${config.tableId}${view}?recordId=${issue.id}`,
  )
}

function Chip({ icon, children, title, onClick }: { icon: React.ReactNode; children: React.ReactNode; title?: string; onClick: () => void }) {
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

type Item =
  | { kind: 'user' | 'assistant' | 'review' | 'error' | 'result'; entry: ConversationEntry }
  | { kind: 'work'; id: string; steps: ConversationEntry[]; live: boolean; channel: EntryChannel }

const itemId = (item: Item): string => (item.kind === 'work' ? item.id : item.entry.id)

/** Fold every run of tool calls, tool output and progress lines into one `work` item. */
function buildItems(entries: ConversationEntry[], live: boolean): Item[] {
  const items: Item[] = []
  let pending: ConversationEntry[] = []
  const flush = () => {
    if (pending.length) items.push({ kind: 'work', id: pending[0].id, steps: pending, live: false, channel: pending[0].channel })
    pending = []
  }
  for (const entry of entries) {
    if (entry.kind === 'tool' || entry.kind === 'toolResult' || entry.kind === 'system') {
      // The fixer's work and the reviewer's are different stories even when adjacent.
      if (pending.length && pending[pending.length - 1].channel !== entry.channel) flush()
      pending.push(entry)
    } else {
      flush()
      items.push({ kind: entry.kind, entry })
    }
  }
  flush()
  const last = items[items.length - 1]
  if (live && last?.kind === 'work') last.live = true
  return items
}

function Conversation({ issue, run, entries, live }: { issue: Issue; run?: IssueRun; entries: ConversationEntry[]; live: boolean }) {
  const items = useMemo(() => buildItems(entries, live), [entries, live])
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
        {items.map((item) => (
          <ItemView key={itemId(item)} item={item} hasPR={!!run?.prURL} issue={issue} busy={live} />
        ))}
      </div>
    </div>
  )
}

function IssueComments({ recordId }: { recordId: string }) {
  const comments = useIssues((s) => s.comments[recordId])
  return comments ? <Comments comments={comments} /> : null
}

function StartPrompt({ issue }: { issue: Issue }) {
  const perform = useIssues((s) => s.perform)
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <Wand2 className="size-7 text-brand" strokeWidth={1.5} />
      <div className="text-[15px] font-semibold">让 agent 来修这个 issue</div>
      <p className="max-w-md text-[13px] text-fg-2">
        建 worktree → 定位根因并修复 → 提 PR（带 {issue.key}）→ 自动 review。整个过程会显示在这里，随时可以插话。
      </p>
      <Button tone="accent" className="h-8 px-4" icon={<Wand2 className="size-4" />} onClick={() => void perform(() => api.enqueueFix([issue]))}>
        自动修复
      </Button>
    </div>
  )
}

function ItemView({ item, hasPR, issue, busy }: { item: Item; hasPR: boolean; issue: Issue; busy: boolean }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex gap-3">
          <Me />
          <div className="selectable min-w-0 flex-1 rounded-xl rounded-tl-sm border bg-card px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap shadow-xs">
            {item.entry.text}
          </div>
        </div>
      )
    case 'assistant':
      return (
        <div className="flex gap-3">
          <AgentAvatar />
          <div className="min-w-0 flex-1 pt-0.5 text-[14px]">
            <Markdown text={item.entry.text} />
          </div>
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
        <div className={cx('flex items-center gap-1.5 pl-9 text-[11px] tabular-nums', item.entry.isError ? 'text-err' : 'text-fg-3')}>
          {item.entry.isError ? <CircleAlert className="size-3" /> : <CircleCheck className="size-3" />}
          {item.entry.text}
        </div>
      )
    case 'work':
      return (
        <div className="pl-9">
          <WorkFold steps={item.steps} live={item.live} review={item.channel === 'review'} />
        </div>
      )
  }
}

type WorkKind = 'read' | 'edit' | 'run' | 'agent' | 'setup' | 'other'

const workKindOf = (entry: ConversationEntry): WorkKind => {
  if (entry.kind !== 'tool') return 'setup'
  const name = entry.text.split(' ')[0]
  if (['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead'].includes(name)) return 'read'
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name)) return 'edit'
  if (['Bash', 'BashOutput', 'KillShell'].includes(name)) return 'run'
  if (['Task', 'Agent'].includes(name)) return 'agent'
  return 'other'
}

const workLabel: Record<WorkKind, string> = { read: '查看', edit: '编辑', run: '运行', agent: '子 agent', setup: '步骤', other: '工具' }
const WorkIcon = ({ kind, className }: { kind: WorkKind; className?: string }) => {
  const Icon = { read: Search, edit: Pencil, run: Terminal, agent: Users, setup: Settings2, other: Wrench }[kind]
  return <Icon className={className ?? 'size-3.5'} />
}

/** One line for a stretch of tool calls — "查看 5 · 编辑 2 · 运行 3" — that opens into the steps. */
function WorkFold({ steps, live, review }: { steps: ConversationEntry[]; live: boolean; review: boolean }) {
  const [open, setOpen] = useState(false)
  const tools = steps.filter((step) => step.kind === 'tool')
  const counts = new Map<WorkKind, number>()
  for (const tool of tools) counts.set(workKindOf(tool), (counts.get(workKindOf(tool)) ?? 0) + 1)
  const dominant = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'setup'
  const summary = counts.size
    ? [...counts].map(([kind, n]) => `${workLabel[kind]} ${n}`).join(' · ')
    : (steps[steps.length - 1]?.text ?? '')
  const latest = [...steps].reverse().find((step) => step.kind !== 'toolResult')
  const failed = steps.some((step) => step.isError)

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="group flex w-full items-center gap-2 text-left text-[12px] text-fg-2 hover:text-fg"
      >
        <span className="flex size-4 items-center justify-center">
          {open ? (
            <ChevronDown className="size-3.5" />
          ) : live ? (
            <Spinner className="size-3 text-agent" />
          ) : (
            <>
              <span className="group-hover:hidden">{review ? <BadgeCheck className="size-3.5" /> : <WorkIcon kind={dominant} />}</span>
              <ChevronRight className="hidden size-3.5 group-hover:block" />
            </>
          )}
        </span>
        <span className="shrink-0">{review ? `Reviewer · ${summary}` : summary}</span>
        {live && latest && <span className="truncate text-fg-3">{latest.text}</span>}
        {failed && !live && <CircleAlert className="size-3 shrink-0 text-err" />}
      </button>
      {open && (
        <div className="mt-1.5 ml-[7px] space-y-1 border-l border-border py-1 pl-4">
          {steps.map((step) => (
            <Step key={step.id} entry={step} />
          ))}
        </div>
      )}
    </div>
  )
}

function Step({ entry }: { entry: ConversationEntry }) {
  if (entry.kind === 'tool') {
    return (
      <div className="flex items-start gap-1.5 text-[12px] text-fg-2">
        <WorkIcon kind={workKindOf(entry)} className="mt-0.5 size-3 shrink-0" />
        <span className="selectable line-clamp-2 font-mono break-all">{entry.text}</span>
      </div>
    )
  }
  return (
    <div
      className={cx(
        'selectable line-clamp-4 font-mono text-[11px] break-all whitespace-pre-wrap',
        entry.kind === 'toolResult' && 'pl-4.5',
        entry.isError ? 'text-err' : 'text-fg-3',
      )}
    >
      {entry.text}
    </div>
  )
}

/** Your face on your own messages. */
function Me() {
  const user = useIssues((s) => s.user)
  return user ? (
    <PersonAvatar person={{ name: user.name, email: user.email, avatar: user.avatar }} className="size-6" tooltip={false} />
  ) : (
    <span className="size-6 shrink-0 rounded-full bg-muted" />
  )
}

function ReviewCard({ text, hasPR, issue, busy }: { text: string; hasPR: boolean; issue: Issue; busy: boolean }) {
  const perform = useIssues((s) => s.perform)
  const approved = isApproved(text)
  return (
    <div className="rounded-xl border bg-card p-4 shadow-xs">
      <div className="mb-2 flex items-center gap-2">
        <AgentAvatar review />
        <span className="text-[13px] font-semibold">Code review</span>
        <span
          className={cx(
            'rounded-full px-2 py-px text-[11px] font-semibold',
            approved ? 'bg-ok/15 text-ok' : 'bg-warn/15 text-warn',
          )}
        >
          {approved ? '通过' : '需要修改'}
        </span>
      </div>
      <div className="text-[13px]">
        <Markdown text={text} />
      </div>
      {(!approved || hasPR) && (
        <div className="mt-3 flex gap-2">
          {!approved && (
            <Button disabled={busy} onClick={() => void perform(() => api.sendLatestReview(issue))}>
              发给 agent 修改
            </Button>
          )}
          {hasPR && <Button onClick={() => void perform(() => api.postLatestReview(issue.id))}>发布到 PR</Button>}
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
        <span className="shrink-0 font-semibold whitespace-nowrap">Issue 描述</span>
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

// MARK: - Composer

/**
 * One rounded box that grows with its text, send inside it at the bottom right, quiet details on a
 * line underneath. Return sends, Shift-Return breaks the line, and a Return that commits an input
 * method's candidate is left to the IME — sending half-typed pinyin is the classic bug here.
 */
interface Pending {
  path: string
  name: string
  /** A data URL for images pasted or dropped, so the chip can show what it is. */
  preview?: string
}

const readAsBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

function Composer({ issue, run, busy }: { issue: Issue; run: IssueRun; busy: boolean }) {
  const [text, setText] = useState('')
  const [pending, setPending] = useState<Pending[]>([])
  const [dragging, setDragging] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const perform = useIssues((s) => s.perform)
  const canSend = !busy && (text.trim().length > 0 || pending.length > 0)

  useLayoutEffect(() => {
    const element = field.current
    if (!element) return
    element.style.height = '0px'
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`
  }, [text])

  const addFiles = async (files: File[]) => {
    for (const file of files) {
      try {
        const base64 = await readAsBase64(file)
        const path = await api.saveUpload(issue.id, file.name || 'pasted.png', base64)
        const preview = file.type.startsWith('image/') ? `data:${file.type};base64,${base64}` : undefined
        setPending((current) => [...current, { path, name: file.name || 'pasted.png', preview }])
      } catch (error) {
        useIssues.setState({ error: String((error as Error).message) })
      }
    }
  }

  const send = () => {
    if (!canSend) return
    const message = text.trim() || '看一下附件。'
    const attachments = pending.map((file) => file.path)
    setText('')
    setPending([])
    void perform(() => api.sendToAgent(issue, message, attachments))
  }

  return (
    <div className="shrink-0 px-6 pb-4">
      <div
        className={cx(
          'mx-auto max-w-[760px] rounded-xl border bg-card shadow-xs transition-colors focus-within:border-ring',
          dragging && 'border-brand bg-brand-soft',
        )}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          void addFiles([...event.dataTransfer.files])
        }}
      >
        <div className="flex items-center gap-1.5 px-3 pt-2.5 font-mono text-[11px] text-muted-foreground">
          <GitBranch className="size-3" />
          <span className="truncate">{run.branch}</span>
          {run.prURL && <span>· PR #{run.prURL.split('/').pop()}</span>}
        </div>
        {pending.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-2">
            {pending.map((file) => (
              <span key={file.path} className="group relative flex h-12 items-center gap-2 rounded-lg border bg-muted/50 pr-2 text-[11.5px]">
                {file.preview ? (
                  <img src={file.preview} alt="" className="h-full w-14 rounded-l-lg object-cover" />
                ) : (
                  <FileText className="ml-2 size-4 text-muted-foreground" />
                )}
                <span className="max-w-36 truncate">{file.name}</span>
                <button
                  type="button"
                  title="移除"
                  onClick={() => setPending((current) => current.filter((candidate) => candidate.path !== file.path))}
                  className="absolute -top-1.5 -right-1.5 hidden size-4 items-center justify-center rounded-full bg-foreground text-[10px] text-background group-hover:flex"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={field}
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onPaste={(event) => {
            const files = [...event.clipboardData.files]
            if (!files.length) return
            event.preventDefault()
            void addFiles(files)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return
            event.preventDefault()
            send()
          }}
          placeholder={busy ? 'Agent 正在工作，可以先写下一条…' : `给 ${issue.key} 的 agent 发消息，可粘贴或拖入截图`}
          className="selectable block max-h-40 min-h-[22px] w-full resize-none bg-transparent px-3 py-2 text-[13.5px] leading-[20px] outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <IconButton
            label="附加文件"
            className="size-6"
            onClick={async () => {
              const paths = await api.pickUploads(issue.id)
              setPending((current) => [...current, ...paths.map((path) => ({ path, name: path.split('/').pop()?.replace(/^\d{14}-/, '') ?? path }))])
            }}
          >
            <Plus className="size-4" />
          </IconButton>
          <ModelPicker recordId={issue.id} model={run.model} />
          <span
            className="selectable inline-flex h-6 items-center rounded-md px-1.5 font-mono text-[11px] text-muted-foreground"
            title={`claude --resume ${run.sessionId}`}
          >
            {run.sessionId.slice(0, 8)}
          </span>
          <div className="flex-1" />
          <span className="mr-1 text-[11px] text-muted-foreground">{busy ? '运行中' : '⏎ 发送'}</span>
          {busy ? (
            <button
              type="button"
              title="停止 agent"
              onClick={() => void perform(() => api.cancelIssue(issue.id))}
              className="flex size-7 items-center justify-center rounded-lg bg-foreground text-background hover:bg-destructive"
            >
              <Square className="size-2.5" fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              title="发送"
              disabled={!canSend}
              onClick={send}
              className={cx(
                'flex size-7 items-center justify-center rounded-lg transition-colors',
                canSend ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground',
              )}
            >
              <ArrowUp className="size-4" strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The model this issue's agent runs on — Claude's own aliases, or anything the Magpie gateway
 * routes (including local models it fronts). Picked per issue; takes effect on the next message.
 */
function ModelPicker({ recordId, model }: { recordId: string; model?: AgentModel }) {
  const fixModel = useIssues((s) => s.config?.fixModel)
  const magpie = useIssues((s) => s.magpieModels)
  const magpieError = useIssues((s) => s.magpieError)
  const loadMagpieModels = useIssues((s) => s.loadMagpieModels)
  const perform = useIssues((s) => s.perform)
  const current = model ?? fixModel ?? { provider: 'claude' as const }
  const same = (a: AgentModel, b: AgentModel) => a.provider === b.provider && (a.model ?? '') === (b.model ?? '')
  const choose = (next: AgentModel | null) => void perform(() => api.setIssueModel(recordId, next))

  return (
    <DropdownMenu onOpenChange={(open) => open && !magpie.length && void loadMagpieModels()}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Cpu className="size-3" />
            {agentModelLabel(current)}
            <ChevronDown className="size-3" />
          </button>
        }
      />
      <DropdownMenuContent align="start" className="max-h-80 min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Claude</DropdownMenuLabel>
          {[undefined, 'opus', 'sonnet', 'haiku'].map((alias) => {
            const option: AgentModel = { provider: 'claude', model: alias }
            return (
              <DropdownMenuCheckboxItem key={alias ?? 'default'} checked={same(current, option)} onClick={() => choose(option)}>
                {alias ?? '默认'}
              </DropdownMenuCheckboxItem>
            )
          })}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Magpie {magpieError ? '（未连接）' : ''}</DropdownMenuLabel>
          {magpie.length === 0 && <DropdownMenuItem disabled>{magpieError ? '打开 Magpie 后重试' : '加载中…'}</DropdownMenuItem>}
          {magpie.map((name) => {
            const option: AgentModel = { provider: 'magpie', model: name }
            return (
              <DropdownMenuCheckboxItem key={name} checked={same(current, option)} onClick={() => choose(option)}>
                {name}
              </DropdownMenuCheckboxItem>
            )
          })}
        </DropdownMenuGroup>
        {model && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => choose(null)}>恢复默认（{agentModelLabel(fixModel ?? { provider: 'claude' })}）</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
