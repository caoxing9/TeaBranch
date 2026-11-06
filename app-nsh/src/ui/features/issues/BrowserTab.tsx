import { Text, View, type ViewRef, cleanup, effect, signal } from 'nsh'
import { t } from '../../../shared/i18n'
import type { BrowserState } from '../../../shared/types'
import { isLive } from '../../../shared/types'
import { Icon } from '../../components/Icon'
import { Button, IconButton, Spinner, TextInput } from '../../components/kit'
import { api, on } from '../../lib/api'
import { app, statusOf } from '../../store/app'
import { placeBrowser } from './browserHost'

/** The agent drove it within this long: the panel says so. */
const AGENT_RECENT_MS = 4000

/** How often the slot checks it still sits where the page is shown: layout shifts around it don't report. */
const PLACE_INTERVAL_MS = 500

/**
 * The branch's own browser — the one its agent drives with `tb-browser` — shown over the panel.
 * The page is a WebView the host keeps at the window's root; this lays it over `slot` and keeps
 * it there, and it keeps working when this closes.
 */
export function BrowserTab(props: { branch: string }) {
  const branch = () => app.branches().find((candidate) => candidate.name === props.branch)
  const status = () => {
    const current = branch()
    return current ? statusOf(current) : 'stopped'
  }
  const view = signal<BrowserState | null>(null)
  const address = signal('')
  const editing = signal(false)
  const now = signal(Date.now())
  let slot: ViewRef | undefined
  const act = (work: () => Promise<unknown>) => void app.run(null, work)

  void api.browserState(props.branch).then((state) => view.set(state))
  cleanup(
    on('browser', (next) => {
      if (next.branch === props.branch) view.set(next)
    }),
  )
  effect(() => {
    if (!editing()) address.set(view()?.url === 'about:blank' ? '' : (view()?.url ?? ''))
  })

  // Nothing loaded yet and the server is up: open its front page, once.
  const blank = () => !view()?.url || view()?.url === 'about:blank'
  let opened = false
  effect(() => {
    if (blank() && status() === 'running' && !opened) {
      opened = true
      void api.browserNavigate(props.branch, '/').catch(() => undefined)
    }
  })

  const agentAt = () => view()?.agentAt ?? 0
  const driving = () => now() - agentAt() < AGENT_RECENT_MS
  effect(() => {
    const at = agentAt()
    if (Date.now() - at >= AGENT_RECENT_MS) return
    now.set(Date.now())
    const timer = setTimeout(() => now.set(Date.now()), AGENT_RECENT_MS)
    cleanup(() => clearTimeout(timer))
  })

  // The page goes where the slot is, and follows it. A failed load shows its reason here instead.
  const failed = () => !!view()?.error
  const visible = () => !blank() && !failed()
  let placed: string | null = null
  const place = async () => {
    if (!slot || !visible()) return
    const measured = await slot.measure()
    if (!measured) return
    const next = { x: measured.pagePosition.x, y: measured.pagePosition.y, width: measured.bounds.size.width, height: measured.bounds.size.height }
    const key = JSON.stringify(next)
    if (key === placed) return
    placed = key
    placeBrowser(props.branch, next)
    void api.showBrowser(props.branch, next)
  }
  effect(() => {
    if (!visible()) {
      placed = null
      placeBrowser(props.branch, null)
      return
    }
    void place()
    const timer = setInterval(() => void place(), PLACE_INTERVAL_MS)
    cleanup(() => clearInterval(timer))
  })
  cleanup(() => {
    placeBrowser(props.branch, null)
    void api.hideBrowser(props.branch)
  })

  const submit = () => {
    editing.set(false)
    if (address().trim()) act(() => api.browserNavigate(props.branch, address()))
  }

  return (
    <View class="flex-1">
      <View class="shrink-0 flex-row items-center gap-0.5 border-b border-border px-2 py-1.5">
        <IconButton label={t('后退')} disabled={!view()?.canGoBack} onPress={() => act(() => api.browserBack(props.branch))}>
          <Icon name="arrow-left" size={16} tint="fg-2" />
        </IconButton>
        <IconButton label={t('前进')} disabled={!view()?.canGoForward} onPress={() => act(() => api.browserForward(props.branch))}>
          <Icon name="arrow-right" size={16} tint="fg-2" />
        </IconButton>
        <IconButton label={t('刷新')} disabled={blank()} onPress={() => act(() => api.browserReload(props.branch))}>
          <If when={view()?.loading} else={<Icon name="rotate-cw" size={14} tint="fg-2" />}>
            <Spinner />
          </If>
        </IconButton>
        <TextInput
          value={address()}
          onChange={(e) => address.set(e.value)}
          onFocus={() => editing.set(true)}
          onBlur={() => editing.set(false)}
          onSubmit={submit}
          placeholder={t('本机地址，或 /路径')}
          class="mx-1 h-[26px] min-w-0 flex-1 border-0 bg-fill px-2 text-[12px] shadow-none"
        />
        <If when={driving()}>
          <View class="shrink-0 flex-row items-center gap-1 rounded-md bg-brand/10 px-1.5 py-0.5">
            <Icon name="bot" size={12} tint="brand" />
            <Text class="text-[11px] text-brand">{t('Agent 在操作')}</Text>
          </View>
        </If>
        <IconButton label={t('在系统浏览器打开')} disabled={blank()} onPress={() => act(() => api.openExternal(view()?.url ?? ''))}>
          <Icon name="external-link" size={14} tint="fg-2" />
        </IconButton>
        <IconButton label={t('开发者工具')} disabled={blank()} onPress={() => act(() => api.browserDevTools(props.branch))}>
          <Icon name="square-terminal" size={14} tint="fg-2" />
        </IconButton>
      </View>
      <View ref={(node) => (slot = node)} class="relative min-h-0 flex-1 bg-white" onLayout={() => void place()}>
        <If when={failed()}>
          <View class="flex-1 items-center justify-center gap-3 bg-bg p-6">
            <Icon name="alert-triangle" size={20} tint="warn" />
            <Text class="text-center text-[13px] text-fg" style={{ userSelect: 'text' }}>
              {t('打不开 {url}', { url: view()?.url ?? '' })}
            </Text>
            <Text class="max-w-md text-center text-[12px] text-fg-2" style={{ userSelect: 'text' }}>
              {view()?.error ?? ''}
            </Text>
            <View class="flex-row items-center gap-2">
              <Button tone="accent" icon={<Icon name="rotate-cw" size={13} tint="#ffffff" />} onPress={() => act(() => api.browserReload(props.branch))}>
                {t('重试')}
              </Button>
              <If when={status() !== 'running' ? branch() : undefined}>
                {(current) => (
                  <Button disabled={app.busy().has(props.branch) || isLive(status())} onPress={() => void app.toggle(current())}>
                    {isLive(status()) ? t('启动中') : t('启动 dev server')}
                  </Button>
                )}
              </If>
            </View>
          </View>
        </If>
        <If when={blank()}>
          <View class="flex-1 items-center justify-center gap-3 bg-bg p-6">
            <If
              when={status() === 'running'}
              else={
                <>
                  <Text class="text-center text-[12.5px] text-fg-2">{t('启动 dev server 后，分支的页面会在这里打开；agent 也用它验证。')}</Text>
                  <If when={branch()}>
                    {(current) => (
                      <Button
                        tone="accent"
                        disabled={app.busy().has(props.branch) || isLive(status())}
                        icon={isLive(status()) ? <Spinner /> : <Icon name="play" size={14} tint="#ffffff" />}
                        onPress={() => void app.toggle(current())}
                      >
                        {isLive(status()) ? t('启动中') : t('启动')}
                      </Button>
                    )}
                  </If>
                </>
              }
            >
              <Spinner />
            </If>
          </View>
        </If>
      </View>
    </View>
  )
}
