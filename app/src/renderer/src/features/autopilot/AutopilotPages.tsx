import { ExternalLink, RotateCcw, Search } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import type { ActivityItem, AutopilotConfig, ContextUsage, SourceId } from '@shared/types'
import { isActivePhase } from '@shared/types'
import { Button, inputClass, Segmented, StatusDot } from '@/components/kit'
import { Switch } from '@/components/ui/switch'
import { api, messageOf } from '@/lib/api'
import { cx } from '@/lib/format'
import { mapping } from '@/lib/issues'
import { cn } from '@/lib/utils'
import { type AutopilotPage, useAutopilot } from '@/store/autopilot'
import { useIssues } from '@/store/issues'
import { ModelPicker } from '../issues/AgentPickers'
import { WorkerQueue } from '../issues/QueuePanel'
import {
  Card,
  ModeSelect,
  NumberInput,
  PageBody,
  PageHeader,
  Row,
  SourceDot,
  sourceName,
  sourceStateLabel,
  Spark,
  SwitchRow,
  TextArea,
} from './parts'
import { HomeComposer } from './HomeComposer'
import { Pipeline } from './Pipeline'
import { RouterChat } from './RouterChat'

/**
 * Autopilot's pages, kept to the bone: the four ideas — sources, router, workers, activity — each a
 * page of its controls. What a setting means is in its tooltip, not on the page.
 */
export function AutopilotMain() {
  const page = useAutopilot((s) => s.page)
  const config = useAutopilot((s) => s.config)
  const error = useAutopilot((s) => s.error)
  if (!config) return null
  const pages: Record<AutopilotPage, ReactNode> = {
    overview: <Overview config={config} />,
    teable: <TeablePage config={config} />,
    feishu: <FeishuPage config={config} />,
    github: <GitHubPage config={config} />,
    router: <RouterPage config={config} />,
    worker: <WorkerPage config={config} />,
    activity: <ActivityPage />,
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {pages[page]}
      {error && (
        <div className="absolute right-6 bottom-6 max-w-md rounded-lg border border-err/40 bg-panel px-3 py-2 text-[12px] text-err shadow-lg">
          {error}
        </div>
      )}
    </div>
  )
}

// MARK: - Home

/** The greeting of the hour, as a colleague says it. */
function greeting(name?: string): string {
  const hour = new Date().getHours()
  const word = hour < 5 ? t('夜深了') : hour < 12 ? t('早上好') : hour < 14 ? t('中午好') : hour < 18 ? t('下午好') : t('晚上好')
  return name ? t('{greeting}，{name}', { greeting: word, name }) : word
}

/**
 * Home: your conversation with the router, laid out like a chat app's. Before the first word, a
 * greeting and the composer in the middle with the recent feed under them; after it, the chat
 * above and the composer at the foot. A row of where things stand sits by the composer either way,
 * and the master switch in the title strip.
 */
function Overview({ config }: { config: AutopilotConfig }) {
  const update = useAutopilot((s) => s.update)
  const status = useAutopilot((s) => s.status)
  const activity = useAutopilot((s) => s.activity)
  const chat = useAutopilot((s) => s.chat)
  const show = useAutopilot((s) => s.show)
  const runs = useIssues((s) => s.runs)
  const queue = useIssues((s) => s.queue)
  const user = useIssues((s) => s.user)
  const sources = status?.sources ?? []
  const working = Object.values(runs).filter((run) => isActivePhase(run.phase) && run.phase !== 'queued').length
  const today = activity.filter((item) => item.at > Date.now() - 86_400_000 && item.source !== 'router')
  const passed = today.filter((item) => item.outcome !== 'ignored').length
  const problems = [
    ...sources.filter((source) => source.state === 'error').map((source) => `${sourceName(source.id)} · ${source.error ?? ''}`),
    status?.router === 'error' ? `Router · ${status.routerError ?? ''}` : '',
  ].filter(Boolean)
  const router = status?.router ?? 'off'
  const routerLabel = router === 'thinking' ? t('处理中') : router === 'error' ? t('出错') : router === 'idle' ? t('空闲') : t('已关闭')
  const thinking = router === 'thinking' || (status?.pending ?? 0) > 0

  const strip = (
    <div className="drag flex h-[46px] shrink-0 items-center justify-end px-5">
      <label className="no-drag flex items-center gap-2.5 text-[12px] text-fg-2">
        {config.enabled ? t('托管运行中') : t('托管已关闭')}
        <Switch checked={config.enabled} onCheckedChange={(enabled) => void update({ enabled: !!enabled })} />
      </label>
    </div>
  )
  const alerts = problems.length > 0 && (
    <div className="flex flex-col gap-1.5">
      {problems.map((problem) => (
        <div key={problem} className="truncate rounded-xl bg-err-soft px-3 py-2 text-[12px] text-err" title={problem}>
          {problem}
        </div>
      ))}
    </div>
  )
  const pills = (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <Pill label={t('数据源')} onClick={() => void show('teable')}>
        <span className="flex items-center gap-1">
          {sources.map((source) => (
            <span key={source.id} title={`${sourceName(source.id)} · ${sourceStateLabel()[source.state]}`}>
              <SourceDot state={source.state} />
            </span>
          ))}
        </span>
      </Pill>
      <Pill label="Router" hot={router === 'thinking'} onClick={() => void show('router')}>
        {routerLabel}
        {status?.pending ? ` · ${status.pending}` : ''}
      </Pill>
      <Pill label="Worker" hot={working > 0} onClick={() => void show('worker')}>
        {working}/{queue.concurrency}
      </Pill>
      <Pill label={t('今天')} onClick={() => void show('activity')}>
        {passed}
      </Pill>
    </div>
  )

  if (!chat.length)
    return (
      <>
        {strip}
        <div className="selectable-area min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[720px] flex-col px-8 pb-10">
            {/* The greeting and the composer sit in the middle of the window, a touch above
                centre; the feed's head peeks in under them and scrolls up. */}
            <div className="flex min-h-[calc(100dvh-46px-140px)] flex-col justify-center pb-6">
              <h1 className="font-display flex items-center justify-center gap-3 text-[30px] leading-tight font-medium tracking-tight">
                <Spark className="size-7 shrink-0 text-brand" />
                <span>{greeting(user?.name)}</span>
              </h1>
              <div className="mt-7">
                <HomeComposer />
              </div>
              {alerts && <div className="mt-4">{alerts}</div>}
              <div className="mt-5">{pills}</div>
            </div>
            <section>
              <header className="mb-2 flex items-center justify-between px-1">
                <h2 className="text-[13px] font-medium text-fg-2">{t('最近动态')}</h2>
                <button type="button" onClick={() => void show('activity')} className="text-[12px] text-fg-2 hover:text-fg">
                  {t('查看全部')}
                </button>
              </header>
              <Card>
                <Pipeline activity={activity} limit={8} showFiltered={false} />
              </Card>
            </section>
          </div>
        </div>
      </>
    )
  return (
    <>
      {strip}
      <div className="selectable-area min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-8 pt-2 pb-6">
          <RouterChat items={chat} thinking={thinking} />
        </div>
      </div>
      <div className="shrink-0 pb-3">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3 px-8">
          {alerts}
          <HomeComposer />
          {pills}
        </div>
      </div>
    </>
  )
}

/** A small round chip of state that opens its page. */
function Pill({ label, hot, onClick, children }: { label: string; hot?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-[12px] text-fg-2 hover:border-border-strong hover:text-fg"
    >
      {hot && <StatusDot color="bg-brand" pulse />}
      <span>{label}</span>
      <span className="font-medium text-fg tabular-nums">{children}</span>
    </button>
  )
}

/** A source's dot and what it's doing, then its own switch — in its page header; the error on hover. */
function SourceBadge({ id }: { id: SourceId }) {
  const source = useAutopilot((s) => s.status?.sources?.find((candidate) => candidate.id === id))
  const config = useAutopilot((s) => s.config)
  const update = useAutopilot((s) => s.update)
  const state = source?.state ?? 'off'
  const on = !!config?.sources[id]
  return (
    <span className="flex items-center gap-3">
      <span className={cx('flex items-center gap-1.5 text-[12px]', state === 'error' ? 'text-err' : 'text-fg-2')} title={source?.error}>
        <SourceDot state={state} />
        {on && !config?.enabled ? t('托管已关闭') : source?.detail || sourceStateLabel()[state]}
      </span>
      <Switch checked={on} onCheckedChange={(value) => config && void update({ sources: { ...config.sources, [id]: !!value } })} />
    </span>
  )
}

// MARK: - Teable

function TeablePage({ config }: { config: AutopilotConfig }) {
  const update = useAutopilot((s) => s.update)
  const issueConfig = useIssues((s) => s.config)
  const fields = useIssues((s) => s.fields)
  const updateIssueConfig = useIssues((s) => s.updateConfig)
  const statusField = issueConfig ? fields.find((field) => field.name === mapping(issueConfig, fields).status) : undefined
  const choices = statusField?.choices ?? []

  return (
    <>
      <PageHeader
        title="Teable"
        actions={
          <>
            <SourceBadge id="teable" />
            <Button onClick={() => useIssues.setState({ showSettings: true })}>{t('Issue 设置…')}</Button>
          </>
        }
      />
      <PageBody>
        <Card title={t('规则')}>
          <SwitchRow
            label={t('状态符合时自动修复')}
            hint={t('代码直接处理，不经过 Router')}
            checked={!!issueConfig?.autoFix}
            onChange={(autoFix) => void updateIssueConfig({ autoFix })}
          />
          <Row label={t('修复这些状态')} stacked>
            <StatusChips
              choices={choices}
              selected={issueConfig?.fixStatuses ?? []}
              onChange={(fixStatuses) => void updateIssueConfig({ fixStatuses })}
            />
          </Row>
        </Card>
        <Card title={t('完成后清理')}>
          <SwitchRow
            label={t('issue 完成后删除 worktree 和分支')}
            hint={t('PR 还开着、有没推送的提交或没提交的改动时不删，会在 issue 里说明原因')}
            checked={config.teableCleanup}
            onChange={(teableCleanup) => void update({ teableCleanup })}
          />
          <Row
            label={t('算作完成的状态')}
            hint={
              issueConfig?.doneStatus && config.teableDoneStatuses.includes(issueConfig.doneStatus) ? (
                <span className="text-warn">
                  {t('“{status}”也是提 PR 后回写的状态：PR 一开就会尝试清理', { status: issueConfig.doneStatus })}
                </span>
              ) : issueConfig?.fixStatuses.some((status) => config.teableDoneStatuses.includes(status)) ? (
                <span className="text-warn">{t('同一个状态既算“修复”又算“完成”：先修复，修完再清理会互相打架')}</span>
              ) : undefined
            }
            stacked
          >
            <StatusChips
              choices={choices}
              selected={config.teableDoneStatuses}
              onChange={(teableDoneStatuses) => void update({ teableDoneStatuses })}
            />
          </Row>
        </Card>
        <Card title="Router">
          <Row label={t('规则没覆盖的新 issue')}>
            <Segmented<AutopilotConfig['teableNewIssues']>
              className="w-44"
              value={config.teableNewIssues}
              onChange={(teableNewIssues) => void update({ teableNewIssues })}
              options={[
                { value: 'router', label: t('交给 Router') },
                { value: 'ignore', label: t('不处理') },
              ]}
            />
          </Row>
          <SwitchRow
            label={t('在 issue 评论里回复')}
            checked={config.teableReplies}
            onChange={(teableReplies) => void update({ teableReplies })}
          />
          <Row label={t('读表间隔')}>
            <NumberInput value={config.pollMinutes} min={1} suffix={t('分钟')} onSave={(pollMinutes) => void update({ pollMinutes })} />
          </Row>
        </Card>
      </PageBody>
    </>
  )
}

/** The status field's choices as toggles. */
function StatusChips({ choices, selected, onChange }: { choices: string[]; selected: string[]; onChange: (next: string[]) => void }) {
  if (!choices.length) return <span className="text-[12px] text-fg-3">{t('没找到状态字段，在 Issue 设置里指定')}</span>
  return (
    <div className="flex flex-wrap gap-1.5">
      {choices.map((choice) => (
        <button
          key={choice}
          type="button"
          onClick={() => onChange(selected.includes(choice) ? selected.filter((status) => status !== choice) : [...selected, choice])}
          className={cx(
            'rounded-full border px-2.5 py-0.5 text-[12px]',
            selected.includes(choice) ? 'border-brand bg-brand-soft text-brand' : 'border-border text-fg-2 hover:bg-fill',
          )}
        >
          {choice}
        </button>
      ))}
    </div>
  )
}

// MARK: - Feishu

function FeishuPage({ config }: { config: AutopilotConfig }) {
  const update = useAutopilot((s) => s.update)
  const asUser = config.feishuIdentity === 'user'
  return (
    <>
      <PageHeader
        title={t('飞书')}
        actions={
          <>
            <SourceBadge id="feishu" />
            <Segmented<AutopilotConfig['feishuIdentity']>
              className="w-36"
              value={config.feishuIdentity}
              onChange={(feishuIdentity) => void update({ feishuIdentity })}
              options={[
                { value: 'bot', label: t('机器人') },
                { value: 'user', label: t('我自己') },
              ]}
            />
          </>
        }
      />
      <PageBody>
        <Credentials config={config} />
        <Card title={asUser ? t('我自己') : t('机器人')}>
          {asUser && <UserAuthorization />}
          {asUser ? (
            <Row label={t('私聊')}>
              <ModeSelect
                value={config.userDirectMode}
                onChange={(userDirectMode) => void update({ userDirectMode })}
                labels={{ ignore: t('不读'), candidate: t('只处理 bug'), mention: t('全部交给 AI') }}
              />
            </Row>
          ) : (
            <SwitchRow label={t('私聊')} checked={config.directMessages} onChange={(directMessages) => void update({ directMessages })} />
          )}
          <Row label={t('新群默认')}>
            <ModeSelect value={config.unknownChatMode} onChange={(unknownChatMode) => void update({ unknownChatMode })} />
          </Row>
          {asUser && (
            <Row label={t('读取间隔')}>
              <NumberInput value={config.pollSeconds} min={5} suffix={t('秒')} onSave={(pollSeconds) => void update({ pollSeconds })} />
            </Row>
          )}
          <AllowedUsers config={config} />
        </Card>
        <ChatList config={config} />
      </PageBody>
    </>
  )
}

/** App ID and secret, folded away once both are saved. */
function Credentials({ config }: { config: AutopilotConfig }) {
  const update = useAutopilot((s) => s.update)
  const hasSecret = useAutopilot((s) => s.hasSecret)
  const setSecret = useAutopilot((s) => s.setSecret)
  const [open, setOpen] = useState(!config.feishuAppId || !hasSecret)
  const [appId, setAppId] = useState(config.feishuAppId)
  const [secret, setSecretText] = useState('')
  useEffect(() => setAppId(config.feishuAppId), [config.feishuAppId])
  const appIdDirty = appId.trim() !== config.feishuAppId
  const saveAppId = () => void update({ feishuAppId: appId.trim() })
  const saveSecret = () => {
    void setSecret(secret)
    setSecretText('')
  }
  const devConsole = config.feishuDomain === 'lark' ? 'https://open.larksuite.com/app' : 'https://open.feishu.cn/app'

  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 self-start text-[12px] text-fg-2 hover:text-fg"
      >
        <span className="font-mono">{config.feishuAppId}</span>
        <span>·</span>
        {t('修改应用')}
      </button>
    )
  return (
    <Card
      title={t('应用')}
      right={
        <Button tone="ghost" onClick={() => void api.openExternal(devConsole)}>
          {t('开放平台')}
          <ExternalLink className="size-3" />
        </Button>
      }
    >
      <Row label={t('平台')}>
        <Segmented<AutopilotConfig['feishuDomain']>
          className="w-36"
          value={config.feishuDomain}
          onChange={(feishuDomain) => void update({ feishuDomain })}
          options={[
            { value: 'feishu', label: t('飞书') },
            { value: 'lark', label: 'Lark' },
          ]}
        />
      </Row>
      <Row label="App ID">
        <span className="flex gap-2">
          <input
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && appIdDirty && saveAppId()}
            placeholder="cli_..."
            className={cn(inputClass, 'w-56 font-mono')}
          />
          <Button tone={appIdDirty ? 'accent' : 'plain'} disabled={!appIdDirty} onClick={saveAppId}>
            {t('保存')}
          </Button>
        </span>
      </Row>
      <Row label="App Secret" hint={hasSecret ? t('已保存在钥匙串里。填新的会替换它。') : undefined}>
        <span className="flex gap-2">
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecretText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && secret.trim() && saveSecret()}
            placeholder={hasSecret ? '••••••••' : 'App Secret'}
            className={cn(inputClass, 'w-56 font-mono')}
          />
          <Button tone={secret.trim() ? 'accent' : 'plain'} disabled={!secret.trim()} onClick={saveSecret}>
            {t('保存')}
          </Button>
        </span>
      </Row>
    </Card>
  )
}

/** Speaking as you: who authorized; what the app needs for it, on hover. */
function UserAuthorization() {
  const status = useAutopilot((s) => s.status)
  const [info, setInfo] = useState<{ name?: string; redirectURL: string; scopes: string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = () => void api.feishuUserInfo().then(setInfo)
  useEffect(refresh, [status?.feishu])
  if (!info) return null
  const authorize = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.authorizeFeishuUser()
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(false)
      refresh()
    }
  }
  const needs = `${t('重定向 URL')}: ${info.redirectURL}\n${t('用户身份权限')}: ${info.scopes.join(' ')}`
  return (
    <Row
      label={info.name ? t('已授权：{name}', { name: info.name }) : t('还没授权')}
      hint={error ? <span className="text-err">{error}</span> : undefined}
    >
      <span className="flex gap-2" title={needs}>
        <Button tone={info.name ? 'plain' : 'accent'} disabled={busy} onClick={() => void authorize()}>
          {busy ? t('等待浏览器里确认…') : info.name ? t('重新授权') : t('用飞书账号授权')}
        </Button>
        {info.name && <Button onClick={() => void api.signOutFeishuUser().then(refresh)}>{t('取消授权')}</Button>}
      </span>
    </Row>
  )
}

function AllowedUsers({ config }: { config: AutopilotConfig }) {
  const update = useAutopilot((s) => s.update)
  const [users, setUsers] = useState(config.allowedUsers.join(' '))
  return (
    <Row label={t('允许的人')} hint={t('open_id，留空不限')}>
      <input
        value={users}
        onChange={(e) => setUsers(e.target.value)}
        onBlur={() => {
          const allowedUsers = users
            .split(/[\s,]+/)
            .map((id) => id.trim())
            .filter(Boolean)
          if (allowedUsers.join(' ') !== config.allowedUsers.join(' ')) void update({ allowedUsers })
        }}
        placeholder={t('所有人')}
        className={cn(inputClass, 'w-56 font-mono')}
      />
    </Row>
  )
}

/** Every chat it knows, listened ones first, searchable: there may be dozens. */
function ChatList({ config }: { config: AutopilotConfig }) {
  const update = useAutopilot((s) => s.update)
  const [query, setQuery] = useState('')
  const all = Object.values(config.chats)
  const chats = all
    .filter((chat) => !query.trim() || chat.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => Number(b.mode !== 'ignore') - Number(a.mode !== 'ignore') || b.seenAt - a.seenAt || a.name.localeCompare(b.name))
  const listening = all.filter((chat) => chat.mode !== 'ignore').length
  return (
    <Card
      title={t('群')}
      right={
        <span className="flex items-center gap-3">
          {all.length > 6 && (
            <label className="flex items-center gap-1.5">
              <Search className="size-3.5 text-fg-3" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('搜索群')}
                className={cn(inputClass, 'h-7 w-40')}
              />
            </label>
          )}
          <span className="text-[12px] text-fg-2 tabular-nums">
            {listening}/{all.length}
          </span>
        </span>
      }
    >
      {!all.length && <div className="px-4 py-3 text-[12px] text-fg-3">{t('机器人在群里收到第一条消息后，群会出现在这里。')}</div>}
      <div className="max-h-96 overflow-y-auto">
        {chats.map((chat) => (
          <div key={chat.id} className="flex items-center gap-3 border-t border-border/60 px-4 py-1.5 first:border-t-0">
            <StatusDot color={chat.mode === 'ignore' ? 'bg-fg-3' : chat.mode === 'candidate' ? 'bg-agent' : 'bg-ok'} />
            <span className={cx('min-w-0 flex-1 truncate text-[13px]', chat.mode === 'ignore' && 'text-fg-2')} title={chat.id}>
              {chat.name}
            </span>
            <ModeSelect
              small
              value={chat.mode}
              onChange={(mode) => void update({ chats: { ...config.chats, [chat.id]: { ...chat, mode } } })}
            />
          </div>
        ))}
      </div>
    </Card>
  )
}

// MARK: - GitHub

function GitHubPage({ config }: { config: AutopilotConfig }) {
  const update = useAutopilot((s) => s.update)
  const review = (patch: Partial<AutopilotConfig['prReview']>): void => void update({ prReview: { ...config.prReview, ...patch } })
  return (
    <>
      <PageHeader title="GitHub" actions={<SourceBadge id="github" />} />
      <PageBody>
        <p className="text-[12.5px] text-fg-2">
          {t('PR 评论和 review 直达 agent')} · {t('自己和机器人的评论会被过滤')}
        </p>
        <Card title="PR review" hint={t('有人 @ 它并发来 PR 链接时：检出代码 review，把意见发到 GitHub，在原话题里回复结论。')}>
          <SwitchRow label={t('Review 群里发来的 PR')} checked={config.prReview.enabled} onChange={(enabled) => review({ enabled })} />
          <SwitchRow label={t('没有问题时 approve')} checked={config.prReview.approve} onChange={(approve) => review({ approve })} />
          <SwitchRow
            label={t('有问题时 request changes')}
            hint={t('关掉则只评论')}
            checked={config.prReview.requestChanges}
            onChange={(requestChanges) => review({ requestChanges })}
          />
        </Card>
      </PageBody>
    </>
  )
}

// MARK: - Router

/** What the router runs on when you pick "default": quick enough to read and route, no code to write. */
const ROUTER_DEFAULT = { provider: 'claude' as const, model: 'sonnet' }

function RouterPage({ config }: { config: AutopilotConfig }) {
  const update = useAutopilot((s) => s.update)
  const status = useAutopilot((s) => s.status)
  const [prefix, setPrefix] = useState(config.replyPrefix)
  useEffect(() => setPrefix(config.replyPrefix), [config.replyPrefix])
  const notify = (key: keyof AutopilotConfig['notify'], value: boolean) => void update({ notify: { ...config.notify, [key]: value } })
  const state = status?.router ?? 'off'
  const stateLabel = state === 'thinking' ? t('处理中') : state === 'error' ? t('出错') : state === 'idle' ? t('空闲') : t('已关闭')

  return (
    <>
      <PageHeader
        title="Router"
        actions={
          <>
            <span
              className={cx('flex items-center gap-1.5 text-[12px]', state === 'error' ? 'text-err' : 'text-fg-2')}
              title={status?.routerError}
            >
              <StatusDot
                color={state === 'error' ? 'bg-err' : state === 'thinking' ? 'bg-brand' : state === 'idle' ? 'bg-ok' : 'bg-fg-3'}
                pulse={state === 'thinking'}
              />
              {stateLabel}
              {status?.pending ? ` · ${status.pending}` : ''}
            </span>
            <ContextShare usage={status?.routerContext} />
            <ModelPicker
              placement="down"
              model={config.routerModel}
              onChange={(model) => void update({ routerModel: model ?? ROUTER_DEFAULT })}
            />
            <Button tone="ghost" title={t('整理记忆并重开会话')} onClick={() => void api.resetRouter()}>
              <RotateCcw className="size-3.5" />
            </Button>
          </>
        }
      />
      <PageBody>
        <MemoryCard />
        <Card title={t('什么时候说话')}>
          <SwitchRow label={t('接到任务')} checked={config.notify.accepted} onChange={(value) => notify('accepted', value)} />
          <SwitchRow label={t('提了 PR')} checked={config.notify.pr} onChange={(value) => notify('pr', value)} />
          <SwitchRow label={t('需要人回答')} checked={config.notify.question} onChange={(value) => notify('question', value)} />
          <SwitchRow label={t('review 通过')} checked={config.notify.approved} onChange={(value) => notify('approved', value)} />
          <SwitchRow label={t('失败')} checked={config.notify.failed} onChange={(value) => notify('failed', value)} />
        </Card>
        <Card title={t('怎么说')}>
          <Row label={t('字数上限')}>
            <NumberInput value={config.chatReplyLimit} min={20} onSave={(chatReplyLimit) => void update({ chatReplyLimit })} />
          </Row>
          <Row label={t('前缀')}>
            <input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              onBlur={() => prefix !== config.replyPrefix && void update({ replyPrefix: prefix })}
              className={cn(inputClass, 'w-20')}
            />
          </Row>
          <Row label={t('回复规则')} stacked>
            <TextArea
              value={config.replyRules}
              rows={3}
              placeholder={t('称呼对方名字；结论放第一句；不承诺上线时间。')}
              onSave={(replyRules) => void update({ replyRules })}
            />
          </Row>
          <Row label={t('主动发现策略')} stacked>
            <TextArea
              value={config.candidatePolicy}
              rows={3}
              placeholder={t('只管表格、导出、权限相关的 bug；有人说“我来看”就不插手。')}
              onSave={(candidatePolicy) => void update({ candidatePolicy })}
            />
          </Row>
        </Card>
      </PageBody>
    </>
  )
}

/** How full the router's session is; it hands over to a fresh one past two thirds. */
function ContextShare({ usage }: { usage?: ContextUsage }) {
  if (!usage?.window) return null
  const share = Math.round((100 * usage.used) / usage.window)
  return (
    <span className={cx('text-[12px] tabular-nums', share > 60 ? 'text-warn' : 'text-fg-2')} title={t('上下文用量')}>
      {share}%
    </span>
  )
}

/**
 * The router's notes to its next session: written by it before a session ends, read again at the
 * start of the next. Yours to edit, so a standing instruction or a correction goes in here too.
 */
function MemoryCard() {
  const memoryAt = useAutopilot((s) => s.status?.routerMemoryAt)
  const [memory, setMemory] = useState<string | null>(null)
  useEffect(() => {
    void api.routerMemory().then(setMemory)
  }, [memoryAt])
  if (memory === null) return null
  return (
    <Card title={t('记忆')} hint={t('会话快满时它自己整理，重开会话时带上；你也可以直接改')}>
      <Row label={memoryAt ? t('上次整理：{time}', { time: new Date(memoryAt).toLocaleString() }) : t('还没有整理过')} stacked>
        <TextArea
          value={memory}
          rows={8}
          placeholder={t('它会写下在跑的任务、答应过谁什么、你的习惯…')}
          onSave={(text) => void api.setRouterMemory(text).then(() => setMemory(text))}
        />
      </Row>
    </Card>
  )
}

// MARK: - Worker

function WorkerPage({ config }: { config: AutopilotConfig }) {
  const update = useAutopilot((s) => s.update)
  return (
    <>
      <PageHeader title="Worker" actions={<Button onClick={() => useIssues.setState({ showSettings: true })}>{t('Issue 设置…')}</Button>} />
      <PageBody>
        <Card>
          <WorkerQueue />
        </Card>
        <Card title="Watchdog">
          <Row label={t('卡住判定')}>
            <NumberInput value={config.stallMinutes} min={5} suffix={t('分钟')} onSave={(stallMinutes) => void update({ stallMinutes })} />
          </Row>
          <Row label={t('自动重试次数')}>
            <NumberInput value={config.maxRetries} onSave={(maxRetries) => void update({ maxRetries })} />
          </Row>
          <Row label={t('进展检查')} hint={t('每隔这么久让模型看一眼它是不是在原地打转；0 关掉')}>
            <NumberInput
              value={config.progressCheckMinutes}
              suffix={t('分钟')}
              onSave={(progressCheckMinutes) => void update({ progressCheckMinutes })}
            />
          </Row>
          <SwitchRow label={t('阻止 Mac 休眠')} checked={config.keepAwake} onChange={(keepAwake) => void update({ keepAwake })} />
          <SwitchRow label={t('登录时启动')} checked={config.openAtLogin} onChange={(openAtLogin) => void update({ openAtLogin })} />
        </Card>
      </PageBody>
    </>
  )
}

// MARK: - Activity

type Filter = 'all' | ActivityItem['source']

function ActivityPage() {
  const activity = useAutopilot((s) => s.activity)
  const [filter, setFilter] = useState<Filter>('all')
  const [showFiltered, setShowFiltered] = useState(false)
  const shown = filter === 'all' ? activity : activity.filter((item) => item.source === filter || item.source === 'router')
  return (
    <>
      <PageHeader
        title={t('动态')}
        actions={
          <label className="flex items-center gap-2 text-[12px] text-fg-2">
            {t('显示被过滤的')}
            <Switch checked={showFiltered} onCheckedChange={(value) => setShowFiltered(!!value)} />
          </label>
        }
      />
      <PageBody>
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('全部') },
            { value: 'teable', label: 'Teable' },
            { value: 'feishu', label: t('飞书') },
            { value: 'github', label: 'GitHub' },
            { value: 'worker', label: 'Agent' },
            { value: 'watchdog', label: 'Watchdog' },
          ]}
        />
        <Card>
          <Pipeline activity={shown} showFiltered={showFiltered} />
        </Card>
      </PageBody>
    </>
  )
}
