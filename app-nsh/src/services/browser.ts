import { signal } from 'nsh'
import type { BrowserState } from '../shared/types'
import { t } from '../shared/i18n'
import { state } from '../core/appState'
import { emit } from '../core/events'
import { TeaBranchError } from '../core/log'

/**
 * Each branch's own browser, the one its agent drives and you watch. The page itself is a WebView
 * the UI mounts (one per branch in `branches()`, kept mounted while its panel is closed so the
 * agent can keep driving it); the UI hands its controls in here as a `Page`, and this module keeps
 * what the rest of the app needs to know: the console, the agent's last touch, the viewport the
 * agent gets while the panel is closed.
 */

/** A mounted page's controls, as the UI implements them over the WebView. */
export interface Page {
  url(): string
  title(): string
  loading(): boolean
  canGoBack(): boolean
  canGoForward(): boolean
  /** The last load failed: why. */
  error(): string | undefined
  load(url: string): void
  back(): void
  forward(): void
  reload(): void
  /** Evaluates `expression` in the page; resolves with its JSON value, rejects with the page's exception. */
  evaluate(expression: string): Promise<unknown>
  /** A click at CSS pixels, from the viewport's top left. */
  click(x: number, y: number): Promise<void>
  /** Types `text` into whatever has focus. */
  text(text: string): Promise<void>
  /** Presses a key: `Enter`, `Escape`, `Meta+a`, `Shift+Tab`… */
  key(combo: string): Promise<void>
  /** The viewport as a PNG, base64. */
  screenshot(): Promise<string>
}

interface Tab {
  page: Page | null
  /** Viewport while the panel is closed — what the agent sees then. */
  size: { width: number; height: number }
  console: string[]
  /** Last time the agent drove it, so the panel can say so. */
  agentAt?: number
  /** Where to go once the page mounts. */
  pendingUrl?: string
  waiters: ((page: Page) => void)[]
}

const tabs = new Map<string, Tab>()
const CONSOLE_LIMIT = 200

/** The branches with a browser, for the UI to mount one WebView each. */
export const branches = signal<string[]>([])

const slug = (branch: string): string =>
  branch
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

/** `*.localhost` per branch, so each branch gets its own cookie jar. */
export const previewURL = (branch: string, port: number): string => `http://${slug(branch)}.localhost:${port}`

/** This machine only: what an issue's text could steer the agent to must not leave it. */
export function isLocal(raw: string): boolean {
  if (raw === 'about:blank') return true
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const host = url.hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')
  } catch {
    return false
  }
}

/** `/base/x` against the branch's dev server, `localhost:3000` without a scheme; nothing else. */
export function resolveAddress(branch: string, input: string): string {
  const text = input.trim()
  const port = state.environment(branch)?.port
  if (text.startsWith('/')) {
    if (!port) throw new TeaBranchError(t('分支的 dev server 没在运行'))
    return previewURL(branch, port) + text
  }
  const url = /^[a-z]+:/i.test(text) && !/^[\w.-]+:\d/.test(text) ? text : `http://${text}`
  if (!isLocal(url)) throw new TeaBranchError(t('只能打开本机地址：{url}', { url: text }))
  return url
}

export function browserState(branch: string): BrowserState {
  const tab = tabs.get(branch)
  const page = tab?.page
  if (!tab || !page) return { branch, url: tab?.pendingUrl ?? '', title: '', loading: !!tab, canGoBack: false, canGoForward: false, agentAt: tab?.agentAt }
  return {
    branch,
    url: page.url(),
    title: page.title(),
    loading: page.loading(),
    canGoBack: page.canGoBack(),
    canGoForward: page.canGoForward(),
    agentAt: tab.agentAt,
    error: page.error(),
  }
}

/** The UI calls it whenever the page's address, title or loading changes. */
export const publish = (branch: string): void => emit('browser', browserState(branch))

/** The branch's browser, made on first use and opened on its dev server when that is up. */
export function tabFor(branch: string): Tab {
  const existing = tabs.get(branch)
  if (existing) return existing
  const port = state.environment(branch)?.port
  const tab: Tab = { page: null, size: { width: 1280, height: 800 }, console: [], pendingUrl: port ? previewURL(branch, port) : 'about:blank', waiters: [] }
  tabs.set(branch, tab)
  branches.set([...tabs.keys()])
  return tab
}

/** The UI mounted the branch's WebView: its controls, and where it should go first. */
export function attachPage(branch: string, page: Page): void {
  const tab = tabFor(branch)
  tab.page = page
  if (tab.pendingUrl) {
    page.load(tab.pendingUrl)
    tab.pendingUrl = undefined
  }
  for (const waiter of tab.waiters.splice(0)) waiter(page)
  publish(branch)
}

/** The WebView went away (the UI unmounted); commands wait for the next one. */
export function detachPage(branch: string): void {
  const tab = tabs.get(branch)
  if (!tab) return
  tab.pendingUrl = tab.page?.url() || tab.pendingUrl
  tab.page = null
}

/** The page, once the UI has mounted it: up to `timeoutMs`. */
export function pageFor(branch: string, timeoutMs = 8000): Promise<Page> {
  const tab = tabFor(branch)
  if (tab.page) return Promise.resolve(tab.page)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      tab.waiters = tab.waiters.filter((w) => w !== waiter)
      reject(new TeaBranchError(t('浏览器还没准备好：先在 TeaBranch 里打开这个分支的页面')))
    }, timeoutMs)
    const waiter = (page: Page) => {
      clearTimeout(timer)
      resolve(page)
    }
    tab.waiters.push(waiter)
  })
}

/** The agent drove it just now. */
export function touch(branch: string): void {
  tabFor(branch).agentAt = Date.now()
  publish(branch)
}

export const consoleOf = (branch: string): string[] => tabFor(branch).console

/** A line from the page's console (the UI feeds them from the WebView). */
export function recordConsole(branch: string, line: string): void {
  const lines = tabFor(branch).console
  lines.push(line)
  if (lines.length > CONSOLE_LIMIT) lines.splice(0, lines.length - CONSOLE_LIMIT)
}

/** The viewport the UI gives a page while its panel is closed. */
export const sizeOf = (branch: string): { width: number; height: number } => tabFor(branch).size

/** What the agent sees while the panel is closed; while it's open, the panel decides. */
export function resize(branch: string, width: number, height: number): void {
  tabFor(branch).size = { width, height }
  publish(branch)
}

/** The panel opened over `bounds`: the UI places the WebView itself; this only notes it. */
export function show(branch: string, _bounds: { x: number; y: number; width: number; height: number }): void {
  tabFor(branch)
  publish(branch)
}

export function hide(branch: string): void {
  if (tabs.has(branch)) publish(branch)
}

export async function navigate(branch: string, input: string): Promise<void> {
  const url = resolveAddress(branch, input)
  const tab = tabFor(branch)
  if (tab.page) tab.page.load(url)
  else tab.pendingUrl = url
}

export function goBack(branch: string): void {
  const page = tabs.get(branch)?.page
  if (page?.canGoBack()) page.back()
}

export function goForward(branch: string): void {
  const page = tabs.get(branch)?.page
  if (page?.canGoForward()) page.forward()
}

export const reload = (branch: string): void => tabs.get(branch)?.page?.reload()

/** WebKit's inspector opens from the page's context menu ("Inspect Element") when enabled; nothing to do here. */
export function openDevTools(branch: string): void {
  tabFor(branch)
}

/** The branch is gone: so is its browser. */
export function close(branch: string): void {
  if (!tabs.delete(branch)) return
  branches.set([...tabs.keys()])
}
