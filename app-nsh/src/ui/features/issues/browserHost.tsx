import { View, WebView, type WebViewNavigation, type WebViewRef, cleanup, signal } from 'nsh'
import { t } from '../../../shared/i18n'
import * as browser from '../../../services/browser'
import type { Page } from '../../../services/browser'

/**
 * The branches' browsers, one WebView each, mounted at the window's root and kept there for as
 * long as the branch has one — so the agent can drive a page whose panel is closed. While a
 * panel shows the page it tells the host where (`placeBrowser`); otherwise the page sits off
 * screen at the viewport the agent gets.
 */
export interface Slot {
  x: number
  y: number
  width: number
  height: number
}

const slots = signal<Record<string, Slot | null>>({})

/** Where a panel shows the branch's page now, or null once it stops showing it. */
export const placeBrowser = (branch: string, slot: Slot | null): void => slots.set({ ...slots(), [branch]: slot })

export function BrowserHost() {
  return (
    <Each of={browser.branches()} key={(branch) => branch}>
      {(branch) => <BrowserPage branch={branch()} />}
    </Each>
  )
}

/** Runs before each page's scripts: its console and errors come out as messages. */
const CONSOLE_HOOK = `(function(){
  if (window.__teabranch) return; window.__teabranch = true;
  var post = function(level, args) {
    try {
      var text = Array.prototype.map.call(args, function(a) { try { return typeof a === 'string' ? a : JSON.stringify(a) } catch (e) { return String(a) } }).join(' ');
      window.nsh.postMessage(JSON.stringify({ type: 'console', level: level, text: text }));
    } catch (e) {}
  };
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function(level) {
    var original = console[level];
    console[level] = function() { post(level, arguments); if (original) original.apply(console, arguments) };
  });
  window.addEventListener('error', function(e) { post('error', [e.message]) });
  window.addEventListener('unhandledrejection', function(e) { post('error', ['Unhandled rejection: ' + (e.reason && e.reason.message || e.reason)]) });
  // The title and address as the page itself changes them (a SPA's routing): the web view's own
  // events only follow real navigations.
  var last = '';
  var sendTitle = function() {
    var now = document.title + '\\n' + location.href;
    if (now === last) return;
    last = now;
    try { window.nsh.postMessage(JSON.stringify({ type: 'title', title: document.title, url: location.href })) } catch (e) {}
  };
  document.addEventListener('DOMContentLoaded', function() {
    sendTitle();
    new MutationObserver(sendTitle).observe(document.documentElement, { childList: true, characterData: true, subtree: true });
  });
  window.addEventListener('load', function() { last = ''; sendTitle() });
  window.addEventListener('popstate', sendTitle);
  window.addEventListener('hashchange', sendTitle);
  ['pushState', 'replaceState'].forEach(function(name) {
    var original = history[name];
    history[name] = function() { var result = original.apply(this, arguments); setTimeout(sendTitle, 0); return result };
  });
})()`

const EVAL_TIMEOUT_MS = 15_000
const KEYS = ['Enter', 'Tab', 'Escape', 'Backspace'] as const
type Key = (typeof KEYS)[number]

function BrowserPage(props: { branch: string }) {
  let view: WebViewRef | undefined
  const src = signal<string | undefined>(undefined)
  const nav = signal<WebViewNavigation>({ url: 'about:blank', title: '', loading: false, canGoBack: false, canGoForward: false })
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let seq = 0

  const update = (e: WebViewNavigation) => {
    // WebKit reports the title a beat after the load: an empty one on the same page says nothing new.
    nav.set({ ...e, title: e.title || (e.url === nav().url ? nav().title : '') })
    browser.publish(props.branch)
  }
  const onMessage = (data: string) => {
    let message: { type?: string; id?: number; ok?: boolean; value?: unknown; error?: string; level?: string; text?: string; title?: string; url?: string }
    try {
      message = JSON.parse(data)
    } catch {
      return
    }
    if (message.type === 'console') browser.recordConsole(props.branch, `[${message.level}] ${message.text}`)
    if (message.type === 'title') update({ ...nav(), title: message.title ?? '', url: message.url || nav().url })
    if (message.type === 'eval' && message.id !== undefined) {
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      if (!waiter) return
      if (message.ok) waiter.resolve(message.value)
      else waiter.reject(new Error(message.error ?? 'error'))
    }
  }
  /** Runs `expression` in the page and brings its JSON value back over the message bridge. */
  const evaluate = (expression: string) =>
    new Promise<unknown>((resolve, reject) => {
      if (!view) return reject(new Error(t('浏览器还没准备好：先在 TeaBranch 里打开这个分支的页面')))
      const id = ++seq
      pending.set(id, { resolve, reject })
      const script = `(function(){
        var result;
        try { result = { type: 'eval', id: ${id}, ok: true, value: (0, eval)(${JSON.stringify(expression)}) } }
        catch (e) { result = { type: 'eval', id: ${id}, ok: false, error: String(e && e.message || e) } }
        var text;
        try { text = JSON.stringify(result) } catch (e) { text = JSON.stringify({ type: 'eval', id: ${id}, ok: false, error: 'result is not serializable' }) }
        window.nsh.postMessage(text);
      })()`
      view.injectJavaScript(script)
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(t('页面脚本超时')))
      }, EVAL_TIMEOUT_MS)
    })

  const page: Page = {
    url: () => nav().url,
    title: () => nav().title,
    loading: () => nav().loading,
    canGoBack: () => nav().canGoBack,
    canGoForward: () => nav().canGoForward,
    load: (url) => {
      // The first page goes in as `src`; after that the page itself navigates, so the same URL loads again too.
      if (src() === undefined || !view) src.set(url)
      else view.injectJavaScript(`location.assign(${JSON.stringify(url)})`)
    },
    back: () => view?.goBack(),
    forward: () => view?.goForward(),
    reload: () => view?.reload(),
    evaluate,
    click: async (x, y) => view?.sendInput({ type: 'click', x, y }),
    text: async (text) => view?.sendInput({ type: 'text', text }),
    key: async (combo) => {
      if (!(KEYS as readonly string[]).includes(combo)) throw new Error(t('暂不支持按键 {combo}', { combo }))
      view?.sendInput({ type: 'key', key: combo as Key })
    },
    screenshot: async () => {
      throw new Error(t('应用内浏览器截图还没搬过来'))
    },
  }
  browser.attachPage(props.branch, page)
  cleanup(() => browser.detachPage(props.branch))

  const slot = () => slots()[props.branch] ?? null
  const hidden = () => browser.sizeOf(props.branch)
  const frame = () => {
    const current = slot()
    return current ? { left: current.x, top: current.y, width: current.width, height: current.height } : { left: -10_000, top: 0, width: hidden().width, height: hidden().height }
  }
  return (
    <View class="absolute overflow-hidden bg-white" style={frame()}>
      <WebView
        ref={(node) => (view = node)}
        src={src()}
        class="flex-1"
        injectedJavaScriptBeforeContentLoaded={CONSOLE_HOOK}
        onLoadStart={update}
        onLoad={update}
        onNavigationStateChange={update}
        onMessage={(e) => onMessage(e.data)}
        onError={(e) => browser.recordConsole(props.branch, `[error] ${e.message}`)}
      />
    </View>
  )
}
