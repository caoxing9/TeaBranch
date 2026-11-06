import { mkdirSync, writeFileBase64Sync } from '../node/fs'
import { join } from 'path'
import { state } from '../core/appState'
import { emitSoon } from '../core/events'
import { sleep } from '../core/spawn'
import * as processManager from './processManager'
import { type Page, consoleOf, pageFor, previewURL, resize, resolveAddress, touch } from './browser'

/**
 * What `tb-browser` does: the agent's hands on its branch's browser. The page is a WebView, so the
 * reading is done by a script in the page — a walk of the DOM in accessibility terms, elements
 * named by refs (`e12`) the script marks them with — and the pointing by real input the host
 * delivers, so canvases and keyboard-driven UIs react as they would to a person.
 */

export const HELP = `tb-browser — drive this branch's browser in TeaBranch (the user can watch it).
  start                     start the branch's dev server and wait until it serves
  open <url|/path>          open a page; /path is on the branch's dev server
  snapshot [-i]             accessibility tree with refs (e12); -i: interactive elements only
  click <ref|x,y>           click an element, or a point in CSS pixels (canvas, the grid)
  dblclick <ref|x,y>        double-click
  hover <ref|x,y>           move the mouse there
  fill <ref> <text>         replace a field's text ("" clears it)
  type <text>               type into whatever has focus
  press <key>               Enter, Escape, Tab, ArrowDown, Backspace, Meta+a, Shift+Tab, ...
  select <ref> <value>      choose an <option> by value or label
  scroll <dy> [ref|x,y]     scroll by dy pixels (negative is up)
  wait <ms>                 sleep
  wait-for <text> [ms]      until the page shows text (default 10000 ms)
  eval <js>                 evaluate an expression in the page, print the JSON result
  screenshot                save a PNG of the viewport and print its path — Read it to look
  console [--clear]         the page's console messages and errors
  viewport <w> <h>          page size while the panel is closed (default 1280 800)
  url                       current address and title
  back | forward | reload
Refs change whenever the page does: take a new snapshot after anything that changes it.
Only addresses on this machine open.`

export interface Owner {
  branch: string
  /** Where screenshots go. */
  dir: string
}

// MARK: - The script in the page

const SNAPSHOT_LINES = 600

/**
 * The page walked as an accessibility tree: roles from tags and ARIA, names from labels, the
 * states that matter, refs stamped on interactive elements as `data-tb-ref`. Runs in the page.
 */
const SNAPSHOT_SCRIPT = `(function (interactiveOnly, limit) {
  const INTERACTIVE = new Set(['button','link','textbox','searchbox','combobox','checkbox','radio','switch','tab','menuitem','menuitemcheckbox','menuitemradio','option','slider','spinbutton','listbox','treeitem'])
  const TRANSPARENT = new Set(['generic','none','presentation','paragraph'])
  const INPUT_ROLES = { checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox', submit: 'button', button: 'button', reset: 'button', image: 'button', file: 'button' }
  const TAG_ROLES = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', option: 'option', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', img: 'img', li: 'listitem', ul: 'list', ol: 'list', nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo', aside: 'complementary', form: 'form', table: 'table', tr: 'row', td: 'cell', th: 'columnheader', dialog: 'dialog', summary: 'button', details: 'group', label: 'generic', p: 'paragraph', section: 'region', article: 'article', hr: 'separator', progress: 'progressbar', meter: 'meter', menu: 'menu', fieldset: 'group', legend: 'generic', iframe: 'Iframe' }
  for (const el of document.querySelectorAll('[data-tb-ref]')) el.removeAttribute('data-tb-ref')
  const lines = []
  let omitted = 0
  let refs = 0
  const clip = (s, n = 100) => (s.length > n ? s.slice(0, n) + '…' : s)
  const text = (s) => (s || '').replace(/\\s+/g, ' ').trim()
  const visible = (el) => {
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || el.getAttribute('aria-hidden') === 'true') return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 || rect.height > 0 || el.tagName === 'OPTION'
  }
  const roleOf = (el) => {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === 'input') return INPUT_ROLES[(el.type || 'text').toLowerCase()] || 'textbox'
    if (tag === 'a' && !el.hasAttribute('href')) return 'generic'
    if (el.isContentEditable && !['button'].includes(tag)) return 'textbox'
    return TAG_ROLES[tag] || 'generic'
  }
  const nameOf = (el, role) => {
    const aria = el.getAttribute('aria-label')
    if (aria) return text(aria)
    const by = el.getAttribute('aria-labelledby')
    if (by) return text(by.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' '))
    if (el.id) { const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (label) return text(label.textContent) }
    const wrapping = el.closest('label')
    if (wrapping && wrapping !== el && ['textbox','searchbox','checkbox','radio','combobox','spinbutton','slider','switch'].includes(role)) return text(wrapping.textContent)
    if (el.tagName === 'IMG') return text(el.getAttribute('alt'))
    const title = el.getAttribute('title') || el.getAttribute('placeholder')
    if (title) return text(title)
    if (INTERACTIVE.has(role) || role === 'heading' || role === 'tab' || role === 'listitem' || role === 'cell' || role === 'columnheader' || role === 'row') return text(el.innerText || el.textContent)
    return ''
  }
  const valueOf = (el, role) => {
    const tag = el.tagName.toLowerCase()
    if (tag === 'select') return el.selectedOptions[0] ? el.selectedOptions[0].label : ''
    if (tag === 'input' || tag === 'textarea') return el.type === 'password' ? '••••' : el.value
    if (role === 'textbox' && el.isContentEditable) return text(el.innerText)
    const aria = el.getAttribute('aria-valuetext') || el.getAttribute('aria-valuenow')
    return aria || ''
  }
  const statesOf = (el, role) => {
    const out = []
    if (el === document.activeElement) out.push('focused')
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.push('disabled')
    if (el.required || el.getAttribute('aria-required') === 'true') out.push('required')
    if (el.getAttribute('aria-invalid') === 'true') out.push('invalid')
    const expanded = el.getAttribute('aria-expanded'); if (expanded === 'true') out.push('expanded')
    const pressed = el.getAttribute('aria-pressed'); if (pressed === 'true') out.push('pressed')
    const selected = el.getAttribute('aria-selected'); if (selected === 'true' || (el.tagName === 'OPTION' && el.selected)) out.push('selected')
    if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox' || role === 'menuitemradio') {
      const checked = el.tagName === 'INPUT' ? (el.indeterminate ? 'mixed' : el.checked ? 'true' : 'false') : (el.getAttribute('aria-checked') || 'false')
      if (checked === 'mixed') out.push('mixed'); else if (checked === 'true') out.push('checked')
    }
    return out
  }
  const visit = (node, depth, parentName) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = text(node.textContent)
      if (value && value !== parentName && !interactiveOnly) {
        if (lines.length >= limit) omitted++
        else lines.push('  '.repeat(depth) + '- text "' + clip(value) + '"')
      }
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node
    const tag = el.tagName.toLowerCase()
    if (['script','style','noscript','template','head','meta','link','svg','path','br'].includes(tag)) return
    if (!visible(el)) return
    const role = roleOf(el)
    const interactive = INTERACTIVE.has(role)
    const name = nameOf(el, role)
    let shown = !TRANSPARENT.has(role)
    if (interactiveOnly) shown = shown && interactive
    if (shown) {
      if (lines.length >= limit) omitted++
      else {
        let line = '  '.repeat(depth) + '- ' + role
        if (name) line += ' "' + clip(name) + '"'
        if (interactive) { refs += 1; const ref = 'e' + refs; el.setAttribute('data-tb-ref', ref); line += ' [' + ref + ']' }
        const value = valueOf(el, role)
        if (value !== undefined && value !== '' && value !== name) line += ': ' + clip(String(value))
        for (const s of statesOf(el, role)) line += ' [' + s + ']'
        lines.push(line)
      }
    }
    // A control's own text is its name; its children add nothing.
    if (interactive && (tag === 'button' || tag === 'a' || tag === 'select' || tag === 'option' || tag === 'summary')) return
    const childDepth = shown && !interactiveOnly ? depth + 1 : depth
    const children = el.shadowRoot ? [...el.shadowRoot.childNodes, ...el.childNodes] : [...el.childNodes]
    for (const child of children) visit(child, childDepth, name || parentName)
  }
  if (document.body) visit(document.body, 0, '')
  const head = (document.title || '(untitled)') + ' — ' + location.href
  if (omitted) lines.push('… ' + omitted + ' more; use snapshot -i, or eval to read a part')
  return [head, ...(lines.length ? lines : ['(empty page)'])].join('\\n')
})`

/** The centre of the ref's box, after scrolling it into view; null when it has none. */
const LOCATE_SCRIPT = `(function (ref) {
  const el = document.querySelector('[data-tb-ref="' + ref + '"]')
  if (!el) return 'missing'
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const rect = el.getBoundingClientRect()
  if (!(rect.width > 0 || rect.height > 0)) return null
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
})`

const quote = (value: unknown): string => JSON.stringify(value)

// MARK: - Pointing

interface Point {
  x: number
  y: number
  label: string
}

/** `e12` from the last snapshot, or `x,y` in CSS pixels; scrolled into view. */
async function locate(page: Page, target: string | undefined): Promise<Point> {
  if (!target) throw new Error('needs a ref from snapshot, or x,y')
  const xy = /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/.exec(target)
  if (xy) return { x: Number(xy[1]), y: Number(xy[2]), label: `(${xy[1]}, ${xy[2]})` }
  if (!/^e\d+$/.test(target)) throw new Error(`${target} is neither a ref (e12) nor x,y`)
  const box = (await page.evaluate(`${LOCATE_SCRIPT}(${quote(target)})`)) as 'missing' | null | { x: number; y: number }
  if (box === 'missing') throw new Error(`no ref ${target} — take a snapshot first, refs change with the page`)
  if (!box) throw new Error(`${target} has no box on screen (hidden, or the page changed — take a new snapshot)`)
  return { x: box.x, y: box.y, label: target }
}

/** Run `fn` with the element as `this`, in the page. */
async function callOn<T>(page: Page, ref: string, fn: string, args: unknown[] = []): Promise<T> {
  const script = `(function () {
    const el = document.querySelector('[data-tb-ref=' + ${quote(quote(ref))} + ']')
    if (!el) throw new Error('no ref ${ref} — take a snapshot first, refs change with the page')
    return (${fn}).apply(el, ${quote(args)})
  })()`
  return (await page.evaluate(script)) as T
}

// MARK: - Pages

/** Until the page stops loading, or `timeoutMs`. */
async function settle(page: Page, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  await sleep(150)
  while (page.loading() && Date.now() < deadline) await sleep(100)
}

const where = (page: Page): string => `${page.title() || '(untitled)'} — ${page.url()}`

async function screenshot(page: Page, dir: string): Promise<string> {
  const data = await page.screenshot()
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
  const path = join(dir, `screenshot-${stamp}-${Math.random().toString(36).slice(2, 6)}.png`)
  writeFileBase64Sync(path, data)
  return path
}

/** Start the branch's dev server if it isn't, and wait until it serves. */
async function startServer(branch: string): Promise<string> {
  const status = state.environment(branch)?.status ?? 'stopped'
  if (status !== 'running' && status !== 'building') {
    await processManager.start(branch)
    emitSoon('branchesChanged')
  }
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    const environment = state.environment(branch)
    if (environment?.status === 'running' && environment.port) return `running: ${previewURL(branch, environment.port)}`
    if (!environment || environment.status === 'stopped' || environment.status === 'error') {
      throw new Error(`the dev server stopped (${environment?.status ?? 'gone'}); the branch's log in TeaBranch says why`)
    }
    await sleep(1000)
  }
  throw new Error('the dev server did not come up in 10 minutes')
}

// MARK: - Dispatch

export async function runCommand(owner: Owner, command: string, args: string[]): Promise<string> {
  const { branch } = owner
  if (!command || command === 'help' || command === '--help') return HELP
  if (command === 'start') return startServer(branch)
  const page = await pageFor(branch)
  touch(branch)
  const [first, second] = args
  switch (command) {
    case 'open': {
      if (!first) throw new Error('open needs a url or /path')
      page.load(resolveAddress(branch, first))
      await settle(page)
      return where(page)
    }
    case 'url':
      return where(page)
    case 'back':
      page.back()
      await settle(page)
      return where(page)
    case 'forward':
      page.forward()
      await settle(page)
      return where(page)
    case 'reload':
      page.reload()
      await settle(page)
      return where(page)
    case 'snapshot':
      return String(await page.evaluate(`${SNAPSHOT_SCRIPT}(${first === '-i'}, ${SNAPSHOT_LINES})`))
    case 'click':
    case 'dblclick': {
      const point = await locate(page, first)
      const before = page.url()
      await page.click(point.x, point.y)
      if (command === 'dblclick') await page.click(point.x, point.y)
      await sleep(200)
      const after = page.url()
      return `${command === 'click' ? 'clicked' : 'double-clicked'} ${point.label}${after !== before ? `; now at ${after}` : ''}`
    }
    case 'hover': {
      const point = await locate(page, first)
      // No pointer to move without a click: the hover events, dispatched where it would be.
      await page.evaluate(`(function (x, y) {
        const el = document.elementFromPoint(x, y)
        if (!el) return false
        for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
          el.dispatchEvent(new MouseEvent(type, { bubbles: !type.endsWith('enter'), clientX: x, clientY: y }))
        }
        return true
      })(${point.x}, ${point.y})`)
      return `hovered ${point.label}`
    }
    case 'fill': {
      if (!first || second === undefined) throw new Error('fill needs a ref and text')
      await callOn(
        page,
        first,
        `function () {
          this.focus()
          if (typeof this.select === 'function') return this.select()
          const range = document.createRange()
          range.selectNodeContents(this)
          const selection = getSelection()
          selection.removeAllRanges()
          selection.addRange(range)
        }`,
      )
      if (second) await page.text(second)
      else await page.key('Backspace')
      return `filled ${first}`
    }
    case 'type':
      if (!first) throw new Error('type needs text')
      await page.text(args.join(' '))
      return 'typed'
    case 'press':
      if (!first) throw new Error('press needs a key')
      await page.key(first)
      await sleep(100)
      return `pressed ${first}`
    case 'select': {
      if (!first || second === undefined) throw new Error('select needs a ref and a value')
      const chosen = await callOn<string | null>(
        page,
        first,
        `function (wanted) {
          const option = [...(this.options ?? [])].find((o) => o.value === wanted || o.label === wanted || o.text.trim() === wanted)
          if (!option) return null
          this.value = option.value
          this.dispatchEvent(new Event('input', { bubbles: true }))
          this.dispatchEvent(new Event('change', { bubbles: true }))
          return option.label
        }`,
        [second],
      )
      if (chosen === null) throw new Error(`no option ${second} in ${first}`)
      return `selected ${chosen}`
    }
    case 'scroll': {
      const deltaY = Number(first)
      if (!Number.isFinite(deltaY)) throw new Error('scroll needs a pixel amount')
      if (second) {
        const point = await locate(page, second)
        await page.evaluate(`(function (x, y, dy) {
          let el = document.elementFromPoint(x, y)
          while (el && el !== document.body && getComputedStyle(el).overflowY !== 'auto' && getComputedStyle(el).overflowY !== 'scroll') el = el.parentElement
          ;(el && el !== document.body ? el : window).scrollBy({ top: dy, behavior: 'instant' })
        })(${point.x}, ${point.y}, ${deltaY})`)
      } else await page.evaluate(`window.scrollBy({ top: ${deltaY}, behavior: 'instant' })`)
      await sleep(200)
      return `scrolled ${deltaY}`
    }
    case 'wait': {
      const ms = Number(first)
      if (!Number.isFinite(ms) || ms < 0) throw new Error('wait needs milliseconds')
      await sleep(Math.min(ms, 60_000))
      return `waited ${Math.min(ms, 60_000)} ms`
    }
    case 'wait-for': {
      if (!first) throw new Error('wait-for needs text')
      const deadline = Date.now() + (Number(second) || 10_000)
      while (Date.now() < deadline) {
        const found = await page.evaluate(`document.body?.innerText.includes(${quote(first)}) ?? false`).catch(() => false)
        if (found) return `found "${first}"`
        await sleep(250)
      }
      throw new Error(`"${first}" did not appear`)
    }
    case 'eval': {
      if (!first) throw new Error('eval needs an expression')
      const value = await page.evaluate(args.join(' '))
      return value === undefined ? 'undefined' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    }
    case 'screenshot':
      return screenshot(page, owner.dir)
    case 'console': {
      const lines = consoleOf(branch)
      const text = lines.length ? lines.slice(-100).join('\n') : '(no console messages)'
      if (first === '--clear') lines.length = 0
      return text
    }
    case 'viewport': {
      const width = Number(first)
      const height = Number(second)
      if (!(width >= 200 && height >= 200)) throw new Error('viewport needs a width and a height of at least 200')
      resize(branch, Math.round(width), Math.round(height))
      return `viewport ${Math.round(width)}×${Math.round(height)} (while the panel is closed)`
    }
    default:
      throw new Error(`unknown command ${command}; tb-browser help lists them`)
  }
}
