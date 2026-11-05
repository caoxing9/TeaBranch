import { Scroll, Text, View, signal } from 'nsh'
import { t } from '../../../shared/i18n'
import { Icon } from '../../components/Icon'
import { Button, EmptyState, Spinner, TextInput, TitleStrip } from '../../components/kit'
import { api } from '../../lib/api'
import { fixable, issues } from '../../store/issues'
import { chats } from '../../store/chats'
import { currentGroup, tabs } from '../../store/tabs'
import { TerminalDock } from '../terminal/TerminalDock'
import { ChatView } from './ChatView'
import { IssueDetail } from './IssueDetail'
import { IssueTabs } from './IssueTabs'
import { PhaseBadge } from './phase'
import { TablePicker } from './TablePicker'

export function IssuesMain() {
  const issue = () => (issues.selection().size === 1 ? issues.issues().find((candidate) => issues.selection().has(candidate.id)) : undefined)
  // Only a chat from the group on screen: the selected issue's, or the free-standing ones.
  const chat = () => chats.chats().find((candidate) => candidate.id === tabs.activeChat() && (candidate.issueId ?? null) === currentGroup(issues.selection()))
  return (
    <If when={issues.checkedSession()} else={<View class="flex-1" />}>
      <If when={issues.user()} else={<LoginView />}>
        <If when={issues.config()?.tableId} else={<TableOnboarding />}>
          <View class="flex-1">
            <IssueTabs />
            <View class="min-h-0 flex-1">
              <If when={chat()} else={<If when={issue()} else={<If when={issues.checked().size > 0} else={<Empty />}><BatchPanel /></If>}>{(current) => <IssueDetail issue={current()} />}</If>}>
                {(current) => <ChatView chat={current()} />}
              </If>
            </View>
            <TerminalDock />
          </View>
        </If>
      </If>
    </If>
  )
}

function Empty() {
  return (
    <View class="flex-1">
      <EmptyState
        icon={<Icon name="bug" size={28} tint="fg-2" />}
        title={t('选择一个 issue')}
        detail={t('点“自动修复”：建 worktree → agent 修复 → 提 PR → 自动 review，你只负责审查。⌘/⇧ 点击可以多选，批量修复。')}
      />
    </View>
  )
}

/** One click for teable.ai; other hosts, custom OAuth apps and tokens sit behind a disclosure. */
function LoginView() {
  const token = signal('')
  const clientId = signal(issues.config()?.oauthClientId ?? '')
  const baseURL = signal(issues.config()?.baseURL ?? 'https://app.teable.ai')
  const more = signal(false)
  const showMore = () => more() || !issues.oauthReady()
  const host = () => baseURL().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return (
    <View class="flex-1">
      <TitleStrip />
      <View class="flex-1 items-center justify-center px-6 pb-[38px]">
        <View class="w-[320px]">
          <Icon name="table-properties" size={28} tint="fg-2" class="mb-4" />
          <Text class="text-[17px] font-semibold text-fg">{t('登录 Teable')}</Text>
          <Text class="mt-1 text-[12.5px] leading-relaxed text-fg-2">{t('读取你的 issue 表，修复后把 PR 链接写回去。')}</Text>
          <If
            when={issues.deviceLogin()}
            else={
              <>
                <If when={issues.oauthReady()}>
                  <Button tone="accent" class="mt-5 h-8 w-full justify-center" onPress={() => void issues.startDeviceLogin()}>
                    {t('用 Teable 登录')}
                  </Button>
                  <Text class="mt-1.5 text-center text-[11px] text-fg-3">{t('{host} · 浏览器里确认即可，无需复制令牌', { host: host() })}</Text>
                  <View class="mt-5 self-start" role="button" onPress={() => more.set(!more())}>
                    <Text class="text-[12px] text-fg-2">
                      {more() ? '▾' : '▸'} {t('其他登录方式')}
                    </Text>
                  </View>
                </If>
                <If when={showMore()}>
                  <View class="mt-2 gap-2 rounded-lg border border-border p-3">
                    <Text class="text-[11px] text-fg-3">{t('Teable 地址（自部署时改这里）')}</Text>
                    <TextInput value={baseURL()} onChange={(e) => baseURL.set(e.value)} onBlur={() => baseURL().trim() !== issues.config()?.baseURL && void issues.updateConfig({ baseURL: baseURL().trim() })} />
                    <View class="flex-row items-center gap-1 pt-1">
                      <Text class="text-[11px] text-fg-3">{t('OAuth 应用 Client ID（需开启 Device Flow）')}</Text>
                      <View role="button" onPress={() => void api.openOAuthAppPage()}>
                        <Text class="text-[11px] text-brand">{t('去创建')}</Text>
                      </View>
                    </View>
                    <View class="flex-row gap-1.5">
                      <TextInput value={clientId()} onChange={(e) => clientId.set(e.value.trim())} placeholder={issues.oauthReady() ? t('留空用内置应用') : 'Client ID'} class="flex-1 font-mono" />
                      <Button
                        disabled={!clientId() && !issues.oauthReady()}
                        onPress={async () => {
                          await issues.updateConfig({ oauthClientId: clientId() || undefined })
                          await issues.startDeviceLogin()
                        }}
                      >
                        {t('登录')}
                      </Button>
                    </View>
                    <View class="flex-row items-center gap-1 pt-1">
                      <Text class="text-[11px] text-fg-3">{t('或个人访问令牌')}</Text>
                      <View role="button" onPress={() => void api.openTokenPage()}>
                        <Text class="text-[11px] text-brand">{t('创建')}</Text>
                      </View>
                    </View>
                    <View class="flex-row gap-1.5">
                      <TextInput masked value={token()} onChange={(e) => token.set(e.value)} onSubmit={() => token() && void issues.signIn(token(), baseURL().trim())} placeholder="Personal access token" class="flex-1" />
                      <Button disabled={!token() || issues.signingIn()} onPress={() => token() && void issues.signIn(token(), baseURL().trim())}>
                        {issues.signingIn() ? <Spinner /> : t('登录')}
                      </Button>
                    </View>
                  </View>
                </If>
              </>
            }
          >
            {(login) => (
              <View class="mt-5 rounded-lg border border-border bg-fill p-4">
                <Text class="text-[12px] text-fg-2">{t('在浏览器里粘贴这个验证码并确认（已复制）')}</Text>
                <Text class="mt-2 font-mono text-[26px] font-semibold tracking-[0.18em] text-fg" style={{ userSelect: 'text' }}>
                  {login().userCode}
                </Text>
                <View class="mt-3 flex-row items-center gap-2">
                  <Spinner />
                  <Text class="text-[12px] text-fg-2">{t('等待授权…')}</Text>
                  <View class="flex-1" />
                  <View role="button" onPress={() => void api.openExternal(login().verificationUri)}>
                    <Text class="text-[12px] text-fg-2">{t('重新打开')}</Text>
                  </View>
                  <View role="button" onPress={() => void issues.cancelDeviceLogin()}>
                    <Text class="text-[12px] text-fg-2">{t('取消')}</Text>
                  </View>
                </View>
              </View>
            )}
          </If>
          <If when={issues.error()}>
            <View class="mt-3 rounded-md bg-err-soft px-3 py-2">
              <Text class="text-[12px] text-err" style={{ userSelect: 'text' }}>
                {issues.error()}
              </Text>
            </View>
          </If>
        </View>
      </View>
    </View>
  )
}

/** Signed in, no table yet: pick the view that holds your issues. */
function TableOnboarding() {
  return (
    <View class="flex-1">
      <TitleStrip />
      <View class="flex-1 items-center justify-center px-6 pb-[38px]">
        <View class="w-[400px]">
          <Icon name="table-properties" size={28} tint="fg-2" class="mb-4" />
          <Text class="text-[17px] font-semibold text-fg">{t('选择 issue 表')}</Text>
          <Text class="mt-1 mb-5 text-[12.5px] leading-relaxed text-fg-2">{t('选出放 issue 的那张表；视图可以缩小范围，比如“待修复”。')}</Text>
          <TablePicker
            confirm
            onPick={async (pick) => {
              await issues.updateConfig({ baseId: pick.baseId, tableId: pick.tableId, viewId: pick.viewId })
              await issues.reload()
            }}
          />
        </View>
      </View>
    </View>
  )
}

/** Several issues selected: queue them all, with how many run at once set right here. */
function BatchPanel() {
  const selected = () => issues.issues().filter((issue) => issues.checked().has(issue.id))
  const ready = () => fixable(selected(), issues.runs())
  const batchSize = () => Math.max(1, issues.config()?.batchSize ?? 3)
  return (
    <Scroll class="flex-1">
      <TitleStrip class="h-10" />
      <View class="items-center px-8 pb-8">
        <View class="w-full max-w-2xl">
          <Text class="text-[22px] font-bold text-fg">{t('已选 {n} 个 issue', { n: selected().length })}</Text>
          <Text class="mt-1 text-[13px] text-fg-2">
            {ready().length === selected().length
              ? t('全部可以加入修复队列。')
              : t('{ready} 个可以修复，另外 {other} 个已经在处理或已有结果。', { ready: ready().length, other: selected().length - ready().length })}
          </Text>
          <View class="mt-5 gap-3 rounded-xl bg-fill p-4">
            <View class="flex-row items-center gap-3">
              <Text class="text-[13px] text-fg">{t('最多同时修复')}</Text>
              <View class="flex-row items-center rounded-md bg-bg">
                <View class="px-2.5 py-1 hover:bg-fill-hover" role="button" onPress={() => void issues.updateConfig({ batchSize: Math.max(1, batchSize() - 1) })}>
                  <Text class="text-[13px] text-fg">−</Text>
                </View>
                <Text class="w-8 text-center text-[13px] font-semibold text-fg tabular-nums">{batchSize()}</Text>
                <View class="px-2.5 py-1 hover:bg-fill-hover" role="button" onPress={() => void issues.updateConfig({ batchSize: Math.min(10, batchSize() + 1) })}>
                  <Text class="text-[13px] text-fg">+</Text>
                </View>
              </View>
              <Text class="text-[13px] text-fg">{t('个')}</Text>
            </View>
            <Text class="text-[12px] text-fg-2">{t('跑完一个就补上排队的下一个，全部结束发系统通知；在“队列”里可以随时暂停、调整顺序。')}</Text>
          </View>
          <View class="mt-5 flex-row gap-2">
            <Button
              tone="accent"
              class="h-8 px-4"
              icon={<Icon name="wand-2" size={16} tint="#ffffff" />}
              disabled={!ready().length}
              onPress={() => {
                void issues.perform(() => api.enqueueFix(ready()))
                issues.setChecked(new Set())
              }}
            >
              {t('全部修复（{n}）', { n: ready().length })}
            </Button>
            <Button class="h-8" onPress={() => issues.setChecked(new Set())}>
              {t('取消选择')}
            </Button>
          </View>
          <View class="mt-6 gap-px overflow-hidden rounded-xl border border-border bg-border">
            <Each of={selected()} key={(issue) => issue.id}>
              {(issue) => (
                <View class="flex-row items-center gap-3 bg-bg px-3 py-2">
                  <Text class="w-16 shrink-0 font-mono text-[12px] text-fg-2">{issue().key}</Text>
                  <Text class="min-w-0 flex-1 text-[13px] text-fg" style={{ numberOfLines: 1 }}>
                    {issue().title}
                  </Text>
                  <If when={issues.runs()[issue().id]}>{(run) => <PhaseBadge phase={run().phase} recordId={issue().id} />}</If>
                </View>
              )}
            </Each>
          </View>
        </View>
      </View>
    </Scroll>
  )
}
