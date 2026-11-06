import { type JSX, Scroll, Text, View, effect, resource, signal } from 'nsh'
import { t } from '../../../shared/i18n'
import type { ActivityItem, AutopilotConfig, ContextUsage, SourceId } from '../../../shared/types'
import { isActivePhase } from '../../../shared/types'
import { mapping } from '../../../shared/issues'
import { Icon } from '../../components/Icon'
import { Button, Segmented, StatusDot, TextInput } from '../../components/kit'
import { api, messageOf } from '../../lib/api'
import { cn } from '../../lib/utils'
import { app } from '../../store/app'
import { type AutopilotPage, autopilot } from '../../store/autopilot'
import { issues } from '../../store/issues'
import { ModelPicker } from '../issues/AgentPickers'
import { WorkerQueue } from '../issues/QueuePanel'
import {
  AppSwitch,
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
  StatusChips,
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
  const page = () => autopilot.page()
  return (
    <If when={autopilot.config()}>
      {(config) => (
        <View class="min-h-0 flex-1">
          {(() => {
            const pages: Record<AutopilotPage, () => JSX.Element> = {
              overview: () => <Overview config={config()} />,
              teable: () => <TeablePage config={config()} />,
              feishu: () => <FeishuPage config={config()} />,
              github: () => <GitHubPage config={config()} />,
              router: () => <RouterPage config={config()} />,
              worker: () => <WorkerPage config={config()} />,
              activity: () => <ActivityPage />,
            }
            return pages[page()]()
          })()}
          <If when={autopilot.error()}>
            <View class="absolute right-6 bottom-6 max-w-md rounded-lg border border-err/40 bg-panel px-3 py-2 shadow-lg">
              <Text class="text-[12px] text-err">{autopilot.error()}</Text>
            </View>
          </If>
        </View>
      )}
    </If>
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
function Overview(props: { config: AutopilotConfig }) {
  const status = () => autopilot.status()
  const sources = () => status()?.sources ?? []
  const working = () => Object.values(issues.runs()).filter((run) => isActivePhase(run.phase) && run.phase !== 'queued').length
  const passed = () => autopilot.activity().filter((item) => item.at > Date.now() - 86_400_000 && item.source !== 'router' && item.outcome !== 'ignored').length
  const problems = () =>
    [
      ...sources()
        .filter((source) => source.state === 'error')
        .map((source) => `${sourceName(source.id)} · ${source.error ?? ''}`),
      status()?.router === 'error' ? `Router · ${status()?.routerError ?? ''}` : '',
    ].filter(Boolean)
  const router = () => status()?.router ?? 'off'
  const routerLabel = () => (router() === 'thinking' ? t('处理中') : router() === 'error' ? t('出错') : router() === 'idle' ? t('空闲') : t('已关闭'))
  const thinking = () => router() === 'thinking' || (status()?.pending ?? 0) > 0

  const strip = (
    <View class="h-[46px] shrink-0 flex-row items-center justify-end px-5" desktop={{ windowDrag: true }}>
      <View class="flex-row items-center gap-2.5">
        <Text class="text-[12px] text-fg-2">{props.config.enabled ? t('托管运行中') : t('托管已关闭')}</Text>
        <AppSwitch checked={props.config.enabled} onChange={(enabled) => void autopilot.update({ enabled })} />
      </View>
    </View>
  )
  const alerts = () => (
    <If when={problems().length > 0}>
      <View class="gap-1.5">
        <Each of={problems()} key={(problem) => problem}>
          {(problem) => (
            <View class="rounded-xl bg-err-soft px-3 py-2" tooltip={problem()}>
              <Text class="text-[12px] text-err" style={{ numberOfLines: 1 }}>
                {problem()}
              </Text>
            </View>
          )}
        </Each>
      </View>
    </If>
  )
  const pills = () => (
    <View class="flex-row flex-wrap items-center justify-center gap-2">
      <Pill label={t('数据源')} onPress={() => void autopilot.show('teable')}>
        <View class="flex-row items-center gap-1">
          <Each of={sources()} key={(source) => source.id}>
            {(source) => (
              <View tooltip={`${sourceName(source().id)} · ${sourceStateLabel()[source().state]}`}>
                <SourceDot state={source().state} />
              </View>
            )}
          </Each>
        </View>
      </Pill>
      <Pill label="Router" hot={router() === 'thinking'} onPress={() => void autopilot.show('router')}>
        <Text class="text-[12px] font-medium text-fg tabular-nums">
          {routerLabel()}
          {status()?.pending ? ` · ${status()?.pending}` : ''}
        </Text>
      </Pill>
      <Pill label="Worker" hot={working() > 0} onPress={() => void autopilot.show('worker')}>
        <Text class="text-[12px] font-medium text-fg tabular-nums">
          {working()}/{issues.queue().concurrency}
        </Text>
      </Pill>
      <Pill label={t('今天')} onPress={() => void autopilot.show('activity')}>
        <Text class="text-[12px] font-medium text-fg tabular-nums">{passed()}</Text>
      </Pill>
    </View>
  )
  return (
    <If
      when={autopilot.chat().length > 0}
      else={
        <>
          {strip}
          <Scroll class="min-h-0 flex-1" contentClass="items-center">
            <View class="w-full max-w-[720px] px-8 pb-10">
              {/* The greeting and the composer sit in the middle of the window, a touch above
                  centre; the feed's head peeks in under them and scrolls up. */}
              <View class="justify-center pb-6" style={{ minHeight: 440 }}>
                <View class="flex-row items-center justify-center gap-3">
                  <Spark size={28} />
                  <Text class="font-display text-[30px] leading-tight font-medium tracking-tight text-fg">{greeting(issues.user()?.name)}</Text>
                </View>
                <View class="mt-7">
                  <HomeComposer />
                </View>
                <View class="mt-4">{alerts()}</View>
                <View class="mt-5">{pills()}</View>
              </View>
              <View>
                <View class="mb-2 flex-row items-center justify-between px-1">
                  <Text class="text-[13px] font-medium text-fg-2">{t('最近动态')}</Text>
                  <View role="button" onPress={() => void autopilot.show('activity')}>
                    <Text class="text-[12px] text-fg-2 hover:text-fg">{t('查看全部')}</Text>
                  </View>
                </View>
                <Card>
                  <Pipeline activity={autopilot.activity()} limit={8} showFiltered={false} />
                </Card>
              </View>
            </View>
          </Scroll>
        </>
      }
    >
      {strip}
      <Scroll class="min-h-0 flex-1" contentClass="items-center">
        <View class="w-full max-w-[720px] px-8 pt-2 pb-6">
          <RouterChat items={autopilot.chat()} thinking={thinking()} />
        </View>
      </Scroll>
      <View class="shrink-0 items-center pb-3">
        <View class="w-full max-w-[720px] gap-3 px-8">
          {alerts()}
          <HomeComposer />
          {pills()}
        </View>
      </View>
    </If>
  )
}

/** A small round chip of state that opens its page. */
function Pill(props: { label: string; hot?: boolean; onPress: () => void; children: JSX.Element }) {
  return (
    <View
      class="h-7 flex-row items-center gap-1.5 rounded-full border border-border bg-card px-3 hover:border-border-strong"
      role="button"
      onPress={props.onPress}
    >
      <If when={props.hot}>
        <StatusDot color="bg-brand" pulse />
      </If>
      <Text class="text-[12px] text-fg-2">{props.label}</Text>
      {props.children}
    </View>
  )
}

/** A source's dot and what it's doing, then its own switch — in its page header; the error on hover. */
function SourceBadge(props: { id: SourceId }) {
  const source = () => autopilot.status()?.sources?.find((candidate) => candidate.id === props.id)
  const config = () => autopilot.config()
  const state = () => source()?.state ?? 'off'
  const on = () => !!config()?.sources[props.id]
  return (
    <View class="flex-row items-center gap-3">
      <View class="flex-row items-center gap-1.5" tooltip={source()?.error}>
        <SourceDot state={state()} />
        <Text class={cn('text-[12px]', state() === 'error' ? 'text-err' : 'text-fg-2')}>
          {on() && !config()?.enabled ? t('托管已关闭') : source()?.detail || sourceStateLabel()[state()]}
        </Text>
      </View>
      <AppSwitch checked={on()} onChange={(value) => config() && void autopilot.update({ sources: { ...config()!.sources, [props.id]: value } })} />
    </View>
  )
}

// MARK: - Teable

function TeablePage(props: { config: AutopilotConfig }) {
  const issueConfig = () => issues.config()
  const statusField = () => (issueConfig() ? issues.fields().find((field) => field.name === mapping(issueConfig()!, issues.fields()).status) : undefined)
  const choices = () => statusField()?.choices ?? []
  const doneWarning = () =>
    issueConfig()?.doneStatus && props.config.teableDoneStatuses.includes(issueConfig()!.doneStatus!)
      ? t('“{status}”也是提 PR 后回写的状态：PR 一开就会尝试清理', { status: issueConfig()!.doneStatus! })
      : issueConfig()?.fixStatuses.some((status) => props.config.teableDoneStatuses.includes(status))
        ? t('同一个状态既算“修复”又算“完成”：先修复，修完再清理会互相打架')
        : undefined
  return (
    <>
      <PageHeader
        title="Teable"
        actions={
          <>
            <SourceBadge id="teable" />
            <Button onPress={() => app.openSettings('issueTeable')}>{t('Issue 设置…')}</Button>
          </>
        }
      />
      <PageBody>
        <Card title={t('规则')}>
          <SwitchRow
            label={t('状态符合时自动修复')}
            hint={t('代码直接处理，不经过 Router')}
            checked={!!issueConfig()?.autoFix}
            onChange={(autoFix) => void issues.updateConfig({ autoFix })}
          />
          <Row label={t('修复这些状态')} stacked>
            <StatusChips
              choices={choices()}
              selected={issueConfig()?.fixStatuses ?? []}
              onChange={(fixStatuses) => void issues.updateConfig({ fixStatuses })}
            />
          </Row>
        </Card>
        <Card title={t('完成后清理')}>
          <SwitchRow
            label={t('issue 完成后删除 worktree 和分支')}
            hint={t('PR 还开着、有没推送的提交或没提交的改动时不删，会在 issue 里说明原因')}
            checked={props.config.teableCleanup}
            onChange={(teableCleanup) => void autopilot.update({ teableCleanup })}
          />
          <Row label={t('算作完成的状态')} hint={doneWarning() ? <Text class="mt-0.5 text-[11.5px] text-warn">{doneWarning()}</Text> : undefined} stacked>
            <StatusChips
              choices={choices()}
              selected={props.config.teableDoneStatuses}
              onChange={(teableDoneStatuses) => void autopilot.update({ teableDoneStatuses })}
            />
          </Row>
        </Card>
        <Card title="Router">
          <Row label={t('规则没覆盖的新 issue')}>
            <Segmented<AutopilotConfig['teableNewIssues']>
              class="w-44"
              value={props.config.teableNewIssues}
              onChange={(teableNewIssues) => void autopilot.update({ teableNewIssues })}
              options={[
                { value: 'router', label: t('交给 Router') },
                { value: 'ignore', label: t('不处理') },
              ]}
            />
          </Row>
          <SwitchRow
            label={t('在 issue 评论里回复')}
            checked={props.config.teableReplies}
            onChange={(teableReplies) => void autopilot.update({ teableReplies })}
          />
          <Row label={t('读表间隔')}>
            <NumberInput value={props.config.pollMinutes} min={1} suffix={t('分钟')} onSave={(pollMinutes) => void autopilot.update({ pollMinutes })} />
          </Row>
        </Card>
      </PageBody>
    </>
  )
}

// MARK: - Feishu

function FeishuPage(props: { config: AutopilotConfig }) {
  const asUser = () => props.config.feishuIdentity === 'user'
  return (
    <>
      <PageHeader
        title={t('飞书')}
        actions={
          <>
            <SourceBadge id="feishu" />
            <Segmented<AutopilotConfig['feishuIdentity']>
              class="w-36"
              value={props.config.feishuIdentity}
              onChange={(feishuIdentity) => void autopilot.update({ feishuIdentity })}
              options={[
                { value: 'bot', label: t('机器人') },
                { value: 'user', label: t('我自己') },
              ]}
            />
          </>
        }
      />
      <PageBody>
        <Credentials config={props.config} />
        <Card title={asUser() ? t('我自己') : t('机器人')}>
          <If when={asUser()}>
            <UserAuthorization />
          </If>
          <If
            when={asUser()}
            else={
              <SwitchRow label={t('私聊')} checked={props.config.directMessages} onChange={(directMessages) => void autopilot.update({ directMessages })} />
            }
          >
            <Row label={t('私聊')}>
              <ModeSelect
                value={props.config.userDirectMode}
                onChange={(userDirectMode) => void autopilot.update({ userDirectMode })}
                labels={{ ignore: t('不读'), candidate: t('只处理 bug'), mention: t('全部交给 AI') }}
              />
            </Row>
          </If>
          <Row label={t('新群默认')}>
            <ModeSelect value={props.config.unknownChatMode} onChange={(unknownChatMode) => void autopilot.update({ unknownChatMode })} />
          </Row>
          <If when={asUser()}>
            <Row label={t('读取间隔')}>
              <NumberInput value={props.config.pollSeconds} min={5} suffix={t('秒')} onSave={(pollSeconds) => void autopilot.update({ pollSeconds })} />
            </Row>
          </If>
          <AllowedUsers config={props.config} />
        </Card>
        <ChatList config={props.config} />
      </PageBody>
    </>
  )
}

/** App ID and secret, folded away once both are saved. */
function Credentials(props: { config: AutopilotConfig }) {
  const open = signal(!props.config.feishuAppId || !autopilot.hasSecret())
  const appId = signal(props.config.feishuAppId)
  const secret = signal('')
  effect(() => appId.set(props.config.feishuAppId))
  const appIdDirty = () => appId().trim() !== props.config.feishuAppId
  const saveAppId = () => void autopilot.update({ feishuAppId: appId().trim() })
  const saveSecret = () => {
    void autopilot.setSecret(secret())
    secret.set('')
  }
  const devConsole = () => (props.config.feishuDomain === 'lark' ? 'https://open.larksuite.com/app' : 'https://open.feishu.cn/app')
  return (
    <If
      when={open()}
      else={
        <View class="flex-row items-center gap-2 self-start" role="button" onPress={() => open.set(true)}>
          <Text class="font-mono text-[12px] text-fg-2">{props.config.feishuAppId}</Text>
          <Text class="text-[12px] text-fg-2">·</Text>
          <Text class="text-[12px] text-fg-2">{t('修改应用')}</Text>
        </View>
      }
    >
      <Card
        title={t('应用')}
        right={
          <Button tone="ghost" icon={<Icon name="external-link" size={12} tint="fg-2" />} onPress={() => void api.openExternal(devConsole())}>
            {t('开放平台')}
          </Button>
        }
      >
        <Row label={t('平台')}>
          <Segmented<AutopilotConfig['feishuDomain']>
            class="w-36"
            value={props.config.feishuDomain}
            onChange={(feishuDomain) => void autopilot.update({ feishuDomain })}
            options={[
              { value: 'feishu', label: t('飞书') },
              { value: 'lark', label: 'Lark' },
            ]}
          />
        </Row>
        <Row label="App ID">
          <View class="flex-row gap-2">
            <TextInput
              value={appId()}
              onChange={(e) => appId.set(e.value)}
              onSubmit={() => appIdDirty() && saveAppId()}
              placeholder="cli_..."
              class="w-56 font-mono"
            />
            <Button tone={appIdDirty() ? 'accent' : 'plain'} disabled={!appIdDirty()} onPress={saveAppId}>
              {t('保存')}
            </Button>
          </View>
        </Row>
        <Row label="App Secret" hint={autopilot.hasSecret() ? t('已保存在钥匙串里。填新的会替换它。') : undefined}>
          <View class="flex-row gap-2">
            <TextInput
              masked
              value={secret()}
              onChange={(e) => secret.set(e.value)}
              onSubmit={() => secret().trim() && saveSecret()}
              placeholder={autopilot.hasSecret() ? '••••••••' : 'App Secret'}
              class="w-56 font-mono"
            />
            <Button tone={secret().trim() ? 'accent' : 'plain'} disabled={!secret().trim()} onPress={saveSecret}>
              {t('保存')}
            </Button>
          </View>
        </Row>
      </Card>
    </If>
  )
}

/** Speaking as you: who authorized; what the app needs for it, on hover. */
function UserAuthorization() {
  const info = resource(
    () => autopilot.status()?.feishu ?? 'none',
    () => api.feishuUserInfo(),
  )
  const busy = signal(false)
  const error = signal<string | null>(null)
  const authorize = async () => {
    busy.set(true)
    error.set(null)
    try {
      await api.authorizeFeishuUser()
    } catch (failure) {
      error.set(messageOf(failure))
    } finally {
      busy.set(false)
      info.refetch()
    }
  }
  return (
    <If when={info()}>
      {(current) => (
        <Row
          label={current().name ? t('已授权：{name}', { name: current().name as string }) : t('还没授权')}
          hint={error() ? <Text class="mt-0.5 text-[11.5px] text-err">{error()}</Text> : undefined}
        >
          <View class="flex-row gap-2" tooltip={`${t('重定向 URL')}: ${current().redirectURL}\n${t('用户身份权限')}: ${current().scopes.join(' ')}`}>
            <Button tone={current().name ? 'plain' : 'accent'} disabled={busy()} onPress={() => void authorize()}>
              {busy() ? t('等待浏览器里确认…') : current().name ? t('重新授权') : t('用飞书账号授权')}
            </Button>
            <If when={current().name}>
              <Button onPress={() => void api.signOutFeishuUser().then(() => info.refetch())}>{t('取消授权')}</Button>
            </If>
          </View>
        </Row>
      )}
    </If>
  )
}

function AllowedUsers(props: { config: AutopilotConfig }) {
  const users = signal(props.config.allowedUsers.join(' '))
  const save = () => {
    const allowedUsers = users()
      .split(/[\s,]+/)
      .map((id) => id.trim())
      .filter(Boolean)
    if (allowedUsers.join(' ') !== props.config.allowedUsers.join(' ')) void autopilot.update({ allowedUsers })
  }
  return (
    <Row label={t('允许的人')} hint={t('open_id，留空不限')}>
      <TextInput value={users()} onChange={(e) => users.set(e.value)} onBlur={save} onSubmit={save} placeholder={t('所有人')} class="w-56 font-mono" />
    </Row>
  )
}

/** Every chat it knows, listened ones first, searchable: there may be dozens. */
function ChatList(props: { config: AutopilotConfig }) {
  const query = signal('')
  const all = () => Object.values(props.config.chats)
  const chats = () =>
    all()
      .filter((chat) => !query().trim() || chat.name.toLowerCase().includes(query().trim().toLowerCase()))
      .sort((a, b) => Number(b.mode !== 'ignore') - Number(a.mode !== 'ignore') || b.seenAt - a.seenAt || a.name.localeCompare(b.name))
  const listening = () => all().filter((chat) => chat.mode !== 'ignore').length
  return (
    <Card
      title={t('群')}
      right={
        <View class="flex-row items-center gap-3">
          <If when={all().length > 6}>
            <View class="flex-row items-center gap-1.5">
              <Icon name="search" size={14} tint="fg-3" />
              <TextInput value={query()} onChange={(e) => query.set(e.value)} placeholder={t('搜索群')} class="h-7 w-40" />
            </View>
          </If>
          <Text class="text-[12px] text-fg-2 tabular-nums">
            {listening()}/{all().length}
          </Text>
        </View>
      }
    >
      <If when={!all().length}>
        <Text class="bg-card px-4 py-3 text-[12px] text-fg-3">{t('机器人在群里收到第一条消息后，群会出现在这里。')}</Text>
      </If>
      <Scroll class="max-h-96 bg-card">
        <Each of={chats()} key={(chat) => chat.id}>
          {(chat) => (
            <View class="flex-row items-center gap-3 border-t border-border/60 px-4 py-1.5">
              <StatusDot color={chat().mode === 'ignore' ? 'bg-fg-3' : chat().mode === 'candidate' ? 'bg-agent' : 'bg-ok'} />
              <Text
                class={cn('min-w-0 flex-1 text-[13px]', chat().mode === 'ignore' ? 'text-fg-2' : 'text-fg')}
                style={{ numberOfLines: 1 }}
                tooltip={chat().id}
              >
                {chat().name}
              </Text>
              <ModeSelect
                small
                value={chat().mode}
                onChange={(mode) => void autopilot.update({ chats: { ...props.config.chats, [chat().id]: { ...chat(), mode } } })}
              />
            </View>
          )}
        </Each>
      </Scroll>
    </Card>
  )
}

// MARK: - GitHub

function GitHubPage(props: { config: AutopilotConfig }) {
  const review = (patch: Partial<AutopilotConfig['prReview']>): void => void autopilot.update({ prReview: { ...props.config.prReview, ...patch } })
  return (
    <>
      <PageHeader title="GitHub" actions={<SourceBadge id="github" />} />
      <PageBody>
        <Text class="text-[12.5px] text-fg-2">
          {t('PR 评论和 review 直达 agent')} · {t('自己和机器人的评论会被过滤')}
        </Text>
        <Card title="PR review" hint={t('有人 @ 它并发来 PR 链接时：检出代码 review，把意见发到 GitHub，在原话题里回复结论。')}>
          <SwitchRow label={t('Review 群里发来的 PR')} checked={props.config.prReview.enabled} onChange={(enabled) => review({ enabled })} />
          <SwitchRow label={t('没有问题时 approve')} checked={props.config.prReview.approve} onChange={(approve) => review({ approve })} />
          <SwitchRow
            label={t('有问题时 request changes')}
            hint={t('关掉则只评论')}
            checked={props.config.prReview.requestChanges}
            onChange={(requestChanges) => review({ requestChanges })}
          />
        </Card>
      </PageBody>
    </>
  )
}

// MARK: - Router

function RouterPage(props: { config: AutopilotConfig }) {
  const status = () => autopilot.status()
  const prefix = signal(props.config.replyPrefix)
  effect(() => prefix.set(props.config.replyPrefix))
  const notify = (key: keyof AutopilotConfig['notify'], value: boolean) => void autopilot.update({ notify: { ...props.config.notify, [key]: value } })
  const state = () => status()?.router ?? 'off'
  const stateLabel = () => (state() === 'thinking' ? t('处理中') : state() === 'error' ? t('出错') : state() === 'idle' ? t('空闲') : t('已关闭'))
  return (
    <>
      <PageHeader
        title="Router"
        actions={
          <>
            <View class="flex-row items-center gap-1.5" tooltip={status()?.routerError}>
              <StatusDot
                color={state() === 'error' ? 'bg-err' : state() === 'thinking' ? 'bg-brand' : state() === 'idle' ? 'bg-ok' : 'bg-fg-3'}
                pulse={state() === 'thinking'}
              />
              <Text class={cn('text-[12px]', state() === 'error' ? 'text-err' : 'text-fg-2')}>
                {stateLabel()}
                {status()?.pending ? ` · ${status()?.pending}` : ''}
              </Text>
            </View>
            <ContextShare usage={status()?.routerContext} />
            <ModelPicker
              placement="down"
              scene="router"
              inherit={t('跟随兜底')}
              model={app.settings()?.models?.rules.router}
              onChange={(model) => void app.setModelRule('router', model)}
            />
            <Button tone="ghost" title={t('整理记忆并重开会话')} onPress={() => void api.resetRouter()}>
              <Icon name="rotate-ccw" size={14} tint="fg-2" />
            </Button>
          </>
        }
      />
      <PageBody>
        <MemoryCard />
        <Card title={t('什么时候说话')}>
          <SwitchRow label={t('接到任务')} checked={props.config.notify.accepted} onChange={(value) => notify('accepted', value)} />
          <SwitchRow label={t('提了 PR')} checked={props.config.notify.pr} onChange={(value) => notify('pr', value)} />
          <SwitchRow label={t('需要人回答')} checked={props.config.notify.question} onChange={(value) => notify('question', value)} />
          <SwitchRow label={t('review 通过')} checked={props.config.notify.approved} onChange={(value) => notify('approved', value)} />
          <SwitchRow label={t('失败')} checked={props.config.notify.failed} onChange={(value) => notify('failed', value)} />
        </Card>
        <Card title={t('怎么说')}>
          <Row label={t('字数上限')}>
            <NumberInput value={props.config.chatReplyLimit} min={20} onSave={(chatReplyLimit) => void autopilot.update({ chatReplyLimit })} />
          </Row>
          <Row label={t('前缀')}>
            <TextInput
              value={prefix()}
              onChange={(e) => prefix.set(e.value)}
              onBlur={() => prefix() !== props.config.replyPrefix && void autopilot.update({ replyPrefix: prefix() })}
              class="w-20"
            />
          </Row>
          <Row label={t('回复规则')} stacked>
            <TextArea
              value={props.config.replyRules}
              rows={3}
              placeholder={t('称呼对方名字；结论放第一句；不承诺上线时间。')}
              onSave={(replyRules) => void autopilot.update({ replyRules })}
            />
          </Row>
          <Row label={t('主动发现策略')} stacked>
            <TextArea
              value={props.config.candidatePolicy}
              rows={3}
              placeholder={t('只管表格、导出、权限相关的 bug；有人说“我来看”就不插手。')}
              onSave={(candidatePolicy) => void autopilot.update({ candidatePolicy })}
            />
          </Row>
        </Card>
      </PageBody>
    </>
  )
}

/** How full the router's session is; it hands over to a fresh one past two thirds. */
function ContextShare(props: { usage?: ContextUsage }) {
  const share = () => (props.usage?.window ? Math.round((100 * props.usage.used) / props.usage.window) : null)
  return (
    <If when={share() !== null}>
      <Text class={cn('text-[12px] tabular-nums', (share() ?? 0) > 60 ? 'text-warn' : 'text-fg-2')} tooltip={t('上下文用量')}>
        {share()}%
      </Text>
    </If>
  )
}

/**
 * The router's notes to its next session: written by it before a session ends, read again at the
 * start of the next. Yours to edit, so a standing instruction or a correction goes in here too.
 */
function MemoryCard() {
  const memoryAt = () => autopilot.status()?.routerMemoryAt
  const memory = resource(
    () => memoryAt() ?? 0,
    () => api.routerMemory(),
  )
  return (
    <If when={memory() !== undefined && memory() !== null}>
      <Card title={t('记忆')} hint={t('会话快满时它自己整理，重开会话时带上；你也可以直接改')}>
        <Row label={memoryAt() ? t('上次整理：{time}', { time: new Date(memoryAt() as number).toLocaleString() }) : t('还没有整理过')} stacked>
          <TextArea
            value={memory() ?? ''}
            rows={8}
            placeholder={t('它会写下在跑的任务、答应过谁什么、你的习惯…')}
            onSave={(text) => void api.setRouterMemory(text).then(() => memory.mutate(text))}
          />
        </Row>
      </Card>
    </If>
  )
}

// MARK: - Worker

function WorkerPage(props: { config: AutopilotConfig }) {
  return (
    <>
      <PageHeader title="Worker" actions={<Button onPress={() => app.openSettings('issueFix')}>{t('Issue 设置…')}</Button>} />
      <PageBody>
        <Card>
          <WorkerQueue />
        </Card>
        <Card title="Watchdog">
          <Row label={t('卡住判定')}>
            <NumberInput value={props.config.stallMinutes} min={5} suffix={t('分钟')} onSave={(stallMinutes) => void autopilot.update({ stallMinutes })} />
          </Row>
          <Row label={t('自动重试次数')}>
            <NumberInput value={props.config.maxRetries} onSave={(maxRetries) => void autopilot.update({ maxRetries })} />
          </Row>
          <Row label={t('进展检查')} hint={t('每隔这么久让模型看一眼它是不是在原地打转；0 关掉')}>
            <NumberInput
              value={props.config.progressCheckMinutes}
              suffix={t('分钟')}
              onSave={(progressCheckMinutes) => void autopilot.update({ progressCheckMinutes })}
            />
          </Row>
          <SwitchRow label={t('阻止 Mac 休眠')} checked={props.config.keepAwake} onChange={(keepAwake) => void autopilot.update({ keepAwake })} />
          <SwitchRow label={t('登录时启动')} checked={props.config.openAtLogin} onChange={(openAtLogin) => void autopilot.update({ openAtLogin })} />
        </Card>
      </PageBody>
    </>
  )
}

// MARK: - Activity

type Filter = 'all' | ActivityItem['source']

function ActivityPage() {
  const filter = signal<Filter>('all')
  const showFiltered = signal(false)
  const shown = () => (filter() === 'all' ? autopilot.activity() : autopilot.activity().filter((item) => item.source === filter() || item.source === 'router'))
  return (
    <>
      <PageHeader
        title={t('动态')}
        actions={
          <View class="flex-row items-center gap-2">
            <Text class="text-[12px] text-fg-2">{t('显示被过滤的')}</Text>
            <AppSwitch checked={showFiltered()} onChange={(value) => showFiltered.set(value)} />
          </View>
        }
      />
      <PageBody>
        <Segmented<Filter>
          value={filter()}
          onChange={(value) => filter.set(value)}
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
          <Pipeline activity={shown()} showFiltered={showFiltered()} />
        </Card>
      </PageBody>
    </>
  )
}
