import { Bug, TableProperties, Wand2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, EmptyState, inputClass, Spinner, Toggle, TitleStrip } from '@/components/kit'
import { api } from '@/lib/api'
import { fixable, useIssues } from '@/store/issues'
import { PhaseBadge } from './IssueSidebar'
import { IssueDetail } from './IssueDetail'
import { IssueTabs } from './IssueTabs'
import { ChatView } from './ChatView'
import { TerminalDock } from '../terminal/TerminalDock'
import { useChats } from '@/store/chats'
import { currentGroup, useTabs } from '@/store/tabs'

export function IssuesMain() {
  const user = useIssues((s) => s.user)
  const checkedSession = useIssues((s) => s.checkedSession)
  const selection = useIssues((s) => s.selection)
  const issues = useIssues((s) => s.issues)
  const config = useIssues((s) => s.config)
  const checked = useIssues((s) => s.checked)
  const chats = useChats((s) => s.chats)
  const activeChat = useTabs((s) => s.activeChat)
  const initChats = useChats((s) => s.init)
  useEffect(() => void initChats(), [initChats])

  if (!checkedSession) return <div className="h-full" />
  if (!user) return <LoginView />
  if (!config?.tableId) return <TablePicker />
  const issue = selection.size === 1 ? issues.find((candidate) => selection.has(candidate.id)) : undefined
  // Only a chat from the group on screen: the selected issue's, or the free-standing ones.
  const chat = chats.find((candidate) => candidate.id === activeChat && (candidate.issueId ?? null) === currentGroup(selection))
  return (
    <div className="flex h-full flex-col">
      <IssueTabs />
      <div className="min-h-0 flex-1">
        {chat ? (
          <ChatView key={chat.id} chat={chat} />
        ) : issue ? (
          <IssueDetail key={issue.id} issue={issue} />
        ) : checked.size > 0 ? (
          <BatchPanel />
        ) : (
          <Empty />
        )}
      </div>
      <TerminalDock />
    </div>
  )
}

function Empty() {
  return (
    <div className="flex h-full flex-col">
      <EmptyState
        icon={<Bug className="size-9" strokeWidth={1.2} />}
        title="选择一个 issue"
        detail="点“自动修复”：建 worktree → agent 修复 → 提 PR → 自动 review，你只负责审查。⌘/⇧ 点击可以多选，批量修复。"
      />
    </div>
  )
}

/** One click for teable.ai; other hosts, custom OAuth apps and tokens sit behind a disclosure. */
function LoginView() {
  const config = useIssues((s) => s.config)
  const signIn = useIssues((s) => s.signIn)
  const signingIn = useIssues((s) => s.signingIn)
  const error = useIssues((s) => s.error)
  const deviceLogin = useIssues((s) => s.deviceLogin)
  const oauthReady = useIssues((s) => s.oauthReady)
  const startDeviceLogin = useIssues((s) => s.startDeviceLogin)
  const cancelDeviceLogin = useIssues((s) => s.cancelDeviceLogin)
  const updateConfig = useIssues((s) => s.updateConfig)
  const [token, setToken] = useState('')
  const [clientId, setClientId] = useState(config?.oauthClientId ?? '')
  const [baseURL, setBaseURL] = useState(config?.baseURL ?? 'https://app.teable.ai')
  const [more, setMore] = useState(false)
  const showMore = more || !oauthReady
  const host = baseURL.replace(/^https?:\/\//, '').replace(/\/+$/, '')

  return (
    <div className="flex h-full flex-col">
      <TitleStrip />
      <div className="flex flex-1 flex-col items-center justify-center px-6 pb-[38px]">
        <div className="no-drag w-[320px]">
          <TableProperties className="mb-4 size-7 text-fg-2" strokeWidth={1.5} />
          <h1 className="text-[17px] font-semibold">登录 Teable</h1>
          <p className="mt-1 text-[12.5px] leading-relaxed text-fg-2">读取你的 issue 表，修复后把 PR 链接写回去。</p>

          {deviceLogin ? (
            <div className="mt-5 rounded-lg border border-border bg-fill p-4">
              <div className="text-[12px] text-fg-2">在浏览器里粘贴这个验证码并确认（已复制）</div>
              <div className="selectable mt-2 font-mono text-[26px] font-semibold tracking-[0.18em]">{deviceLogin.userCode}</div>
              <div className="mt-3 flex items-center gap-2 text-[12px] text-fg-2">
                <Spinner />
                等待授权…
                <div className="flex-1" />
                <button type="button" className="hover:text-fg" onClick={() => void api.openExternal(deviceLogin.verificationUri)}>
                  重新打开
                </button>
                <button type="button" className="hover:text-fg" onClick={() => void cancelDeviceLogin()}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            <>
              {oauthReady && (
                <Button tone="accent" className="mt-5 h-8 w-full justify-center" onClick={() => void startDeviceLogin()}>
                  用 Teable 登录
                </Button>
              )}
              {oauthReady && <div className="mt-1.5 text-center text-[11px] text-fg-3">{host} · 浏览器里确认即可，无需复制令牌</div>}

              {oauthReady && (
                <button type="button" className="mt-5 text-[12px] text-fg-2 hover:text-fg" onClick={() => setMore(!more)}>
                  {more ? '▾' : '▸'} 其他登录方式
                </button>
              )}
              {showMore && (
                <div className="mt-2 space-y-2 rounded-lg border border-border p-3">
                  <div className="text-[11px] text-fg-3">Teable 地址（自部署时改这里）</div>
                  <input
                    value={baseURL}
                    onChange={(e) => setBaseURL(e.target.value)}
                    onBlur={() => baseURL.trim() !== config?.baseURL && void updateConfig({ baseURL: baseURL.trim() })}
                    className={inputClass}
                  />
                  <div className="pt-1 text-[11px] text-fg-3">
                    OAuth 应用 Client ID（需开启 Device Flow）{' '}
                    <button type="button" className="text-brand hover:underline" onClick={() => void api.openOAuthAppPage()}>
                      去创建
                    </button>
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value.trim())}
                      placeholder={oauthReady ? '留空用内置应用' : 'Client ID'}
                      className={`${inputClass} font-mono`}
                    />
                    <Button
                      disabled={!clientId && !oauthReady}
                      onClick={async () => {
                        await updateConfig({ oauthClientId: clientId || undefined })
                        await startDeviceLogin()
                      }}
                    >
                      登录
                    </Button>
                  </div>
                  <form
                    className="pt-1"
                    onSubmit={(event) => {
                      event.preventDefault()
                      if (token) void signIn(token, baseURL.trim())
                    }}
                  >
                    <div className="mb-1 text-[11px] text-fg-3">
                      或个人访问令牌{' '}
                      <button type="button" onClick={() => void api.openTokenPage()} className="text-brand hover:underline">
                        创建
                      </button>
                    </div>
                    <div className="flex gap-1.5">
                      <input
                        type="password"
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        placeholder="Personal access token"
                        className={inputClass}
                      />
                      <Button type="submit" disabled={!token || signingIn}>
                        {signingIn ? <Spinner /> : '登录'}
                      </Button>
                    </div>
                  </form>
                </div>
              )}
            </>
          )}
          {error && <div className="selectable mt-3 rounded-md bg-err-soft px-3 py-2 text-[12px] text-err">{error}</div>}
        </div>
      </div>
    </div>
  )
}

/** Signed in, no table yet: pick the view that holds your issues. */
function TablePicker() {
  const updateConfig = useIssues((s) => s.updateConfig)
  const reload = useIssues((s) => s.reload)
  const [url, setURL] = useState('')
  const [error, setError] = useState<string | null>(null)
  const apply = async () => {
    const match = /\/base\/([^/]+)\/table\/([^/?]+)(?:\/([^/?]+))?/.exec(url)
    if (!match) return setError('需要形如 …/base/bse…/table/tbl…/viw… 的视图链接')
    setError(null)
    await updateConfig({ baseURL: new URL(url.trim()).origin, baseId: match[1], tableId: match[2], viewId: match[3] })
    await reload()
  }
  return (
    <div className="flex h-full flex-col">
      <TitleStrip />
      <div className="flex flex-1 flex-col items-center justify-center px-6 pb-[38px]">
        <div className="no-drag w-[360px]">
          <TableProperties className="mb-4 size-7 text-fg-2" strokeWidth={1.5} />
          <h1 className="text-[17px] font-semibold">选择 issue 表</h1>
          <p className="mt-1 text-[12.5px] leading-relaxed text-fg-2">
            在浏览器打开放 issue 的那张表，选好视图（比如“待修复”），把地址栏的链接粘贴到这里。
          </p>
          <div className="mt-5 flex gap-1.5">
            <input
              autoFocus
              value={url}
              onChange={(e) => setURL(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void apply()}
              placeholder="https://app.teable.ai/base/…/table/…/…"
              className={inputClass}
            />
            <Button tone="accent" disabled={!url} onClick={() => void apply()}>
              使用
            </Button>
          </div>
          {error && <div className="mt-2 text-[12px] text-err">{error}</div>}
        </div>
      </div>
    </div>
  )
}

/** Several issues selected: queue them all, with the batch window set right here. */
function BatchPanel() {
  const state = useIssues()
  const selected = state.issues.filter((issue) => state.checked.has(issue.id))
  const ready = fixable(selected, state.runs)
  const batchSize = Math.max(1, state.config?.batchSize ?? 3)
  const batches = Math.ceil(ready.length / batchSize)
  const autoNext = state.config?.autoNextBatch ?? false

  return (
    <div className="h-full overflow-y-auto">
      <div className="drag h-10" />
      <div className="mx-auto max-w-2xl px-8 pb-8">
        <h1 className="text-[22px] font-bold">已选 {selected.length} 个 issue</h1>
        <p className="mt-1 text-[13px] text-fg-2">
          {ready.length === selected.length
            ? '全部可以加入修复队列。'
            : `${ready.length} 个可以修复，另外 ${selected.length - ready.length} 个已经在处理或已有结果。`}
        </p>

        <div className="mt-5 space-y-3 rounded-xl bg-fill p-4">
          <div className="flex items-center gap-3">
            <span className="text-[13px]">每批同时修复</span>
            <div className="flex items-center rounded-md bg-bg">
              <button
                type="button"
                className="px-2.5 py-1 hover:bg-fill-hover"
                onClick={() => void state.updateConfig({ batchSize: Math.max(1, batchSize - 1) })}
              >
                −
              </button>
              <span className="w-8 text-center font-semibold tabular-nums">{batchSize}</span>
              <button
                type="button"
                className="px-2.5 py-1 hover:bg-fill-hover"
                onClick={() => void state.updateConfig({ batchSize: Math.min(10, batchSize + 1) })}
              >
                +
              </button>
            </div>
            <span className="text-[13px]">个</span>
          </div>
          <Toggle
            checked={autoNext}
            onChange={(value) => void state.updateConfig({ autoNextBatch: value })}
            label="一批全部完成后自动开始下一批"
          />
          <p className="text-[12px] text-fg-2">
            共 {batches} 批。
            {autoNext ? '一直跑到队列清空，每批结束和全部结束都会发系统通知。' : '每批结束发系统通知并暂停，你审查完点“开始下一批”。'}
            一批要等每个 issue 都走完修复 → PR → review → 回改（或失败、停止、等你回复）才算结束。
          </p>
        </div>

        <div className="mt-5 flex gap-2">
          <Button
            tone="accent"
            className="h-8 px-4"
            icon={<Wand2 className="size-4" />}
            disabled={!ready.length}
            onClick={() => {
              void state.perform(() => api.enqueueFix(ready))
              state.setChecked(new Set())
            }}
          >
            全部修复（{ready.length}）
          </Button>
          <Button className="h-8" onClick={() => state.setChecked(new Set())}>
            取消选择
          </Button>
        </div>

        <div className="mt-6 divide-y divide-border rounded-xl border border-border">
          {selected.map((issue) => (
            <div key={issue.id} className="flex items-center gap-3 px-3 py-2">
              <span className="w-16 shrink-0 font-mono text-[12px] text-fg-2">{issue.key}</span>
              <span className="min-w-0 flex-1 truncate text-[13px]">{issue.title}</span>
              {state.runs[issue.id] && <PhaseBadge phase={state.runs[issue.id].phase} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
