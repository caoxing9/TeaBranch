import { BrowserWindow, type Rectangle, shell, WebContentsView, type WebContents } from 'electron'
import type { BrowserState } from '@shared/types'
import { t } from '@shared/i18n'
import { state } from '../core/appState'
import { emit } from '../core/events'
import { TeaBranchError } from '../core/log'

/**
 * Each branch's own browser, the one its agent drives and you watch. A view lives in a host window
 * that is never shown — it still paints there, so the agent can click and screenshot while you look
 * at something else — and moves into the main window while its panel is open. Off-window bounds
 * or `setVisible(false)` would stop it painting; the main window can't hold it underneath either,
 * its vibrancy would let the page show through.
 */

interface Tab {
  view: WebContentsView
  shown: boolean
  /** Size while hidden — the viewport the agent sees then. */
  size: { width: number; height: number }
  console: string[]
  /** Last time the agent drove it, so the panel can say so. */
  agentAt?: number
}

const tabs = new Map<string, Tab>()
let main: BrowserWindow | null = null
let host: BrowserWindow | null = null

const CONSOLE_LIMIT = 200

export const setBrowserWindow = (window: BrowserWindow): void => {
  main = window
}

function hostWindow(): BrowserWindow {
  if (!host || host.isDestroyed()) {
    host = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { backgroundThrottling: false } })
  }
  return host
}

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
  if (!tab) return { branch, url: '', title: '', loading: false, canGoBack: false, canGoForward: false }
  const contents = tab.view.webContents
  return {
    branch,
    url: contents.getURL(),
    title: contents.getTitle(),
    loading: contents.isLoading(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
    agentAt: tab.agentAt,
  }
}

const publish = (branch: string): void => emit('browser', browserState(branch))

/** The branch's browser, made on first use and opened on its dev server when that is up. */
export function tabFor(branch: string): Tab {
  const existing = tabs.get(branch)
  if (existing) return existing
  const view = new WebContentsView({
    webPreferences: { partition: `persist:browser-${slug(branch)}`, backgroundThrottling: false, sandbox: true },
  })
  view.setBackgroundColor('#ffffff')
  const tab: Tab = { view, shown: false, size: { width: 1280, height: 800 }, console: [] }
  hostWindow().contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, ...tab.size })

  const contents = view.webContents
  const guard = (event: { preventDefault: () => void }, url: string) => {
    if (isLocal(url)) return
    event.preventDefault()
    void shell.openExternal(url)
  }
  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)
  contents.setWindowOpenHandler(({ url }) => {
    if (isLocal(url)) void contents.loadURL(url)
    else void shell.openExternal(url)
    return { action: 'deny' }
  })
  for (const name of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'] as const) {
    contents.on(name as 'did-stop-loading', () => publish(branch))
  }
  contents.on('console-message', (event) => {
    // Electron's own advice to app authors, from a dev build; not the page's.
    if (event.message.startsWith('Electron Security Warning')) return
    tab.console.push(`[${event.level}] ${event.message}${event.sourceId ? ` (${event.sourceId}:${event.lineNumber})` : ''}`)
    if (tab.console.length > CONSOLE_LIMIT) tab.console.splice(0, tab.console.length - CONSOLE_LIMIT)
  })
  contents.on('render-process-gone', (_event, details) => tab.console.push(`[error] page crashed: ${details.reason}`))

  tabs.set(branch, tab)
  const port = state.environment(branch)?.port
  void contents.loadURL(port ? previewURL(branch, port) : 'about:blank').catch(() => undefined)
  return tab
}

export const contentsFor = (branch: string): WebContents => tabFor(branch).view.webContents

/** The agent drove it just now. */
export function touch(branch: string): void {
  tabFor(branch).agentAt = Date.now()
  publish(branch)
}

export const consoleOf = (branch: string): string[] => tabFor(branch).console

/** What the agent sees while the panel is closed; while it's open, the panel decides. */
export function resize(branch: string, width: number, height: number): void {
  const tab = tabFor(branch)
  tab.size = { width, height }
  if (!tab.shown) tab.view.setBounds({ x: 0, y: 0, width, height })
}

/** Into the main window at `bounds` (the panel's placeholder, in window coordinates). */
export function show(branch: string, bounds: Rectangle): void {
  if (!main || main.isDestroyed()) return
  for (const [other, tab] of tabs) if (other !== branch && tab.shown) hide(other)
  const tab = tabFor(branch)
  if (!tab.shown) {
    hostWindow().contentView.removeChildView(tab.view)
    main.contentView.addChildView(tab.view)
    tab.shown = true
  }
  tab.view.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  })
  publish(branch)
}

/** Back to the host window, where it keeps working out of sight. */
export function hide(branch: string): void {
  const tab = tabs.get(branch)
  if (!tab?.shown) return
  main?.contentView.removeChildView(tab.view)
  hostWindow().contentView.addChildView(tab.view)
  tab.view.setBounds({ x: 0, y: 0, ...tab.size })
  tab.shown = false
}

export async function navigate(branch: string, input: string): Promise<void> {
  await contentsFor(branch)
    .loadURL(resolveAddress(branch, input))
    // A redirect or a page that aborts its own load still shows; the state event tells the rest.
    .catch(() => undefined)
}

export function goBack(branch: string): void {
  const history = contentsFor(branch).navigationHistory
  if (history.canGoBack()) history.goBack()
}

export function goForward(branch: string): void {
  const history = contentsFor(branch).navigationHistory
  if (history.canGoForward()) history.goForward()
}

export const reload = (branch: string): void => contentsFor(branch).reload()

export function openDevTools(branch: string): void {
  contentsFor(branch).openDevTools({ mode: 'detach' })
}

/** The branch is gone: so is its browser. */
export function close(branch: string): void {
  const tab = tabs.get(branch)
  if (!tab) return
  hide(branch)
  host?.contentView.removeChildView(tab.view)
  tab.view.webContents.close()
  tabs.delete(branch)
}
