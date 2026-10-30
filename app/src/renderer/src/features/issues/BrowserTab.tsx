import { ArrowLeft, ArrowRight, Bot, ExternalLink, Play, RotateCw, SquareTerminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { BrowserState } from '@shared/types'
import { isLive } from '@shared/types'
import { t } from '@shared/i18n'
import { Button, IconButton, Spinner } from '@/components/kit'
import { api, on } from '@/lib/api'
import { statusOf, useApp } from '@/store/app'

/** Popups the native page would cover: while one is open, the page steps aside. */
const POPUP = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]'

/** The agent drove it within this long: the panel says so. */
const AGENT_RECENT_MS = 4000

/**
 * The branch's own browser — the one its agent drives with `tb-browser` — shown over the panel.
 * The page is a native view the main process lays over `slot`; it keeps working when this closes.
 */
export function BrowserTab({ branch: name }: { branch: string }) {
  const app = useApp()
  const branch = app.branches.find((candidate) => candidate.name === name)
  const status = branch ? statusOf(branch) : 'stopped'
  const [view, setView] = useState<BrowserState | null>(null)
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const [covered, setCovered] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const slot = useRef<HTMLDivElement>(null)
  const act = (work: () => Promise<unknown>) => void app.run(null, work)

  useEffect(() => {
    void api.browserState(name).then(setView)
    return on('browser', (next) => {
      if (next.branch === name) setView(next)
    })
  }, [name])

  useEffect(() => {
    if (!editing) setAddress(view?.url === 'about:blank' ? '' : (view?.url ?? ''))
  }, [view?.url, editing])

  // Nothing loaded yet and the server is up: open its front page.
  const blank = !view?.url || view.url === 'about:blank'
  useEffect(() => {
    if (blank && status === 'running') void api.browserNavigate(name, '/').catch(() => undefined)
  }, [blank, status, name])

  useEffect(() => {
    const check = () => setCovered(!!document.querySelector(POPUP))
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role'] })
    check()
    return () => observer.disconnect()
  }, [])

  const agentAt = view?.agentAt ?? 0
  const driving = now - agentAt < AGENT_RECENT_MS
  useEffect(() => {
    if (Date.now() - agentAt >= AGENT_RECENT_MS) return
    const timer = setTimeout(() => setNow(Date.now()), AGENT_RECENT_MS)
    setNow(Date.now())
    return () => clearTimeout(timer)
  }, [agentAt])

  const visible = !blank && !covered
  useEffect(() => {
    const element = slot.current
    if (!element || !visible) return
    let frame = 0
    const place = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect()
        void api.showBrowser(name, { x: rect.left, y: rect.top, width: rect.width, height: rect.height })
      })
    }
    const observer = new ResizeObserver(place)
    observer.observe(element)
    window.addEventListener('resize', place)
    place()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      cancelAnimationFrame(frame)
      void api.hideBrowser(name)
    }
  }, [name, visible])

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-0.5 border-b px-2 py-1.5">
        <IconButton label={t('后退')} disabled={!view?.canGoBack} onClick={() => act(() => api.browserBack(name))}>
          <ArrowLeft className="size-4" />
        </IconButton>
        <IconButton label={t('前进')} disabled={!view?.canGoForward} onClick={() => act(() => api.browserForward(name))}>
          <ArrowRight className="size-4" />
        </IconButton>
        <IconButton label={t('刷新')} disabled={blank} onClick={() => act(() => api.browserReload(name))}>
          {view?.loading ? <Spinner /> : <RotateCw className="size-3.5" />}
        </IconButton>
        <form
          className="mx-1 min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            setEditing(false)
            if (address.trim()) act(() => api.browserNavigate(name, address))
          }}
        >
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => {
              setEditing(true)
              event.target.select()
            }}
            onBlur={() => setEditing(false)}
            placeholder={t('本机地址，或 /路径')}
            className="selectable h-[26px] w-full rounded-md bg-fill px-2 text-[12px] outline-none placeholder:text-fg-3"
          />
        </form>
        {driving && (
          <span className="flex shrink-0 items-center gap-1 rounded-md bg-brand/10 px-1.5 py-0.5 text-[11px] text-brand">
            <Bot className="size-3" />
            {t('Agent 在操作')}
          </span>
        )}
        <IconButton label={t('在系统浏览器打开')} disabled={blank} onClick={() => act(() => api.openExternal(view!.url))}>
          <ExternalLink className="size-3.5" />
        </IconButton>
        <IconButton label={t('开发者工具')} disabled={blank} onClick={() => act(() => api.browserDevTools(name))}>
          <SquareTerminal className="size-3.5" />
        </IconButton>
      </div>
      <div ref={slot} className="relative min-h-0 flex-1 bg-white">
        {blank ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 bg-background p-6 text-center text-[12.5px] text-muted-foreground">
            {status === 'running' ? (
              <Spinner />
            ) : (
              <>
                <span>{t('启动 dev server 后，分支的页面会在这里打开；agent 也用它验证。')}</span>
                {branch && (
                  <Button
                    tone="accent"
                    disabled={app.busy.has(name) || isLive(status)}
                    icon={isLive(status) ? <Spinner /> : <Play className="size-3.5" />}
                    onClick={() => void app.toggle(branch)}
                  >
                    {isLive(status) ? t('启动中') : t('启动')}
                  </Button>
                )}
              </>
            )}
          </div>
        ) : (
          covered && (
            <div className="flex h-full items-center justify-center bg-background text-[12px] text-muted-foreground">{view?.title}</div>
          )
        )}
      </div>
    </div>
  )
}
