import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { state } from '../core/appState'
import { emitSoon } from '../core/events'
import { errorMessage } from '../core/log'
import { sleep } from '../core/spawn'
import * as processManager from './processManager'
import { consoleOf, contentsFor, previewURL, resize, resolveAddress, touch } from './browser'

/**
 * What `tb-browser` does: the agent's hands on its branch's browser, over the Chrome DevTools
 * Protocol. Elements are named by refs from the last `snapshot` (`e12`), not selectors — the
 * accessibility tree is what the agent reads, so that is what it points at.
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
  screenshot [--full]       save a PNG and print its path — Read it to look
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

/** One debugger session per page, attached on first use; DevTools open by hand would refuse it. */
async function cdp<T = Record<string, unknown>>(contents: WebContents, method: string, params?: object): Promise<T> {
  if (!contents.debugger.isAttached()) {
    try {
      contents.debugger.attach('1.3')
    } catch (error) {
      throw new Error(`can't attach to the page (close its DevTools?): ${errorMessage(error)}`, { cause: error })
    }
  }
  return (await contents.debugger.sendCommand(method, params)) as T
}

// MARK: - Refs

/** `ref` → backend DOM node, from the last snapshot of each page. */
const refsByPage = new WeakMap<WebContents, Map<string, number>>()

interface AXValue {
  value?: unknown
}

interface AXNode {
  nodeId: string
  ignored?: boolean
  role?: AXValue
  name?: AXValue
  value?: AXValue
  properties?: { name: string; value: AXValue }[]
  childIds?: string[]
  backendDOMNodeId?: number
}

const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'slider',
  'spinbutton',
  'listbox',
  'treeitem',
])

/** Wrappers that only add nesting: their children are shown in their place. */
const TRANSPARENT = new Set(['generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak', 'RootWebArea', 'paragraph', 'div', 'Section'])

const STATES = ['focused', 'checked', 'selected', 'expanded', 'disabled', 'pressed', 'required', 'invalid']

const SNAPSHOT_LINES = 600

const clip = (text: string, length = 100): string => (text.length > length ? `${text.slice(0, length)}…` : text)

async function snapshot(contents: WebContents, interactiveOnly: boolean): Promise<string> {
  await cdp(contents, 'Accessibility.enable')
  const { nodes } = await cdp<{ nodes: AXNode[] }>(contents, 'Accessibility.getFullAXTree')
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  const refs = new Map<string, number>()
  refsByPage.set(contents, refs)
  const lines: string[] = []
  let omitted = 0

  const visit = (node: AXNode, depth: number, parentName: string) => {
    const role = String(node.role?.value ?? '')
    const name = String(node.name?.value ?? '').trim()
    const interactive = INTERACTIVE.has(role)
    let shown = !node.ignored && !TRANSPARENT.has(role)
    // A label repeating its control's name says nothing new.
    if (role === 'StaticText') shown = !!name && name !== parentName && !interactiveOnly
    else if (interactiveOnly) shown = shown && interactive
    if (shown) {
      if (lines.length >= SNAPSHOT_LINES) omitted++
      else {
        let line = `${'  '.repeat(depth)}- ${role === 'StaticText' ? 'text' : role}`
        if (name) line += ` "${clip(name)}"`
        if (interactive && node.backendDOMNodeId) {
          const ref = `e${refs.size + 1}`
          refs.set(ref, node.backendDOMNodeId)
          line += ` [${ref}]`
        }
        const value = node.value?.value
        if (value !== undefined && value !== '' && String(value) !== name) line += `: ${clip(String(value))}`
        for (const property of node.properties ?? []) {
          const on = property.value?.value
          if (STATES.includes(property.name) && on && on !== 'false') {
            line += property.name === 'checked' && on === 'mixed' ? ' [mixed]' : ` [${property.name}]`
          }
        }
        lines.push(line)
      }
    }
    for (const id of node.childIds ?? []) {
      const child = byId.get(id)
      if (child) visit(child, shown && !interactiveOnly ? depth + 1 : depth, name || parentName)
    }
  }
  if (nodes[0]) visit(nodes[0], 0, '')
  const head = `${contents.getTitle() || '(untitled)'} — ${contents.getURL()}`
  if (omitted) lines.push(`… ${omitted} more; use snapshot -i, or eval to read a part`)
  return [head, ...(lines.length ? lines : ['(empty page)'])].join('\n')
}

// MARK: - Pointing

interface Point {
  x: number
  y: number
  label: string
}

/** `e12` from the last snapshot, or `x,y` in CSS pixels; scrolled into view. */
async function locate(contents: WebContents, target: string | undefined): Promise<Point> {
  if (!target) throw new Error('needs a ref from snapshot, or x,y')
  const xy = /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/.exec(target)
  if (xy) return { x: Number(xy[1]), y: Number(xy[2]), label: `(${xy[1]}, ${xy[2]})` }
  const backendNodeId = nodeOf(contents, target)
  await cdp(contents, 'DOM.enable')
  await cdp(contents, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined)
  const { quads } = await cdp<{ quads: number[][] }>(contents, 'DOM.getContentQuads', { backendNodeId }).catch(() => ({ quads: [] }))
  const quad = quads[0]
  if (!quad) throw new Error(`${target} has no box on screen (hidden, or the page changed — take a new snapshot)`)
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4
  return { x, y, label: target }
}

function nodeOf(contents: WebContents, ref: string): number {
  const id = refsByPage.get(contents)?.get(ref)
  if (!id) throw new Error(`no ref ${ref} — take a snapshot first, refs change with the page`)
  return id
}

/**
 * A page in the hidden host window has no frame until something asks for one, and without a frame
 * mouse events hit nothing. A one-pixel capture asks for one.
 */
const paint = (contents: WebContents) =>
  cdp(contents, 'Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } })

async function mouse(contents: WebContents, point: Point, clicks: number): Promise<void> {
  await paint(contents)
  await cdp(contents, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  for (let count = 1; count <= clicks; count++) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp(contents, 'Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: count })
    }
  }
}

/** Run `fn` with the element as `this`. */
async function callOn<T>(contents: WebContents, ref: string, fn: string, args: unknown[] = []): Promise<T> {
  const { object } = await cdp<{ object: { objectId: string } }>(contents, 'DOM.resolveNode', { backendNodeId: nodeOf(contents, ref) })
  const result = await cdp<{ result: { value: T }; exceptionDetails?: { text: string } }>(contents, 'Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: fn,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true,
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}

// MARK: - Keys

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
}

const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 }

/** Without these Chromium ignores ⌘-shortcuts sent as key events: the editing command is what acts. */
const COMMANDS: Record<string, string> = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo' }

async function press(contents: WebContents, combo: string): Promise<void> {
  const parts = combo.split('+')
  const name = parts.pop() ?? ''
  let modifiers = 0
  for (const part of parts) {
    const bit = MODIFIERS[part]
    if (bit === undefined) throw new Error(`unknown modifier ${part}`)
    modifiers |= bit
  }
  const known = KEYS[name === ' ' ? 'Space' : name]
  let key: { key: string; code: string; keyCode: number; text?: string }
  if (known) key = { key: name === 'Space' ? ' ' : name, ...known }
  else if (name.length === 1) {
    const upper = name.toUpperCase()
    const code = /[A-Z]/.test(upper) ? `Key${upper}` : /\d/.test(name) ? `Digit${name}` : ''
    key = { key: name, code, keyCode: upper.charCodeAt(0), text: name }
  } else throw new Error(`unknown key ${name}`)
  // A shortcut types nothing.
  const text = modifiers & ~8 ? undefined : key.text
  const commands = modifiers === 4 && COMMANDS[name.toLowerCase()] ? [COMMANDS[name.toLowerCase()]] : undefined
  const base = { modifiers, key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode }
  await cdp(contents, 'Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, text, unmodifiedText: text, commands })
  await cdp(contents, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

// MARK: - Pages

/** Until the page stops loading, or `timeoutMs`. */
async function settle(contents: WebContents, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  await sleep(150)
  while (contents.isLoading() && Date.now() < deadline) await sleep(100)
}

const where = (contents: WebContents): string => `${contents.getTitle() || '(untitled)'} — ${contents.getURL()}`

async function evaluate(contents: WebContents, expression: string): Promise<unknown> {
  const result = await cdp<{
    result: { value?: unknown; description?: string }
    exceptionDetails?: { text: string; exception?: { description?: string } }
  }>(contents, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value ?? result.result.description
}

async function screenshot(contents: WebContents, dir: string, full: boolean): Promise<string> {
  let clip: object | undefined
  if (full) {
    const { cssContentSize } = await cdp<{ cssContentSize: { width: number; height: number } }>(contents, 'Page.getLayoutMetrics')
    clip = { x: 0, y: 0, width: cssContentSize.width, height: Math.min(cssContentSize.height, 16_000), scale: 1 }
  }
  const { data } = await cdp<{ data: string }>(contents, 'Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: full })
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
  const path = join(dir, `screenshot-${stamp}-${Math.random().toString(36).slice(2, 6)}.png`)
  writeFileSync(path, Buffer.from(data, 'base64'))
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

  const contents = contentsFor(branch)
  touch(branch)
  const [first, second] = args
  switch (command) {
    case 'open': {
      if (!first) throw new Error('open needs a url or /path')
      const url = resolveAddress(branch, first)
      await contents.loadURL(url).catch(() => undefined)
      await settle(contents)
      return where(contents)
    }
    case 'url':
      return where(contents)
    case 'back':
      contents.navigationHistory.goBack()
      await settle(contents)
      return where(contents)
    case 'forward':
      contents.navigationHistory.goForward()
      await settle(contents)
      return where(contents)
    case 'reload':
      contents.reload()
      await settle(contents)
      return where(contents)
    case 'snapshot':
      return snapshot(contents, first === '-i')
    case 'click':
    case 'dblclick':
    case 'hover': {
      const point = await locate(contents, first)
      const before = contents.getURL()
      await mouse(contents, point, command === 'click' ? 1 : command === 'dblclick' ? 2 : 0)
      await sleep(200)
      const after = contents.getURL()
      return `${command === 'hover' ? 'hovered' : command === 'click' ? 'clicked' : 'double-clicked'} ${point.label}${after !== before ? `; now at ${after}` : ''}`
    }
    case 'fill': {
      if (!first || second === undefined) throw new Error('fill needs a ref and text')
      await cdp(contents, 'DOM.enable')
      await cdp(contents, 'DOM.focus', { backendNodeId: nodeOf(contents, first) })
      await callOn(
        contents,
        first,
        `function () {
          if (typeof this.select === 'function') return this.select()
          const range = document.createRange()
          range.selectNodeContents(this)
          const selection = getSelection()
          selection.removeAllRanges()
          selection.addRange(range)
        }`,
      )
      if (second) await cdp(contents, 'Input.insertText', { text: second })
      else await press(contents, 'Backspace')
      return `filled ${first}`
    }
    case 'type':
      if (!first) throw new Error('type needs text')
      await cdp(contents, 'Input.insertText', { text: args.join(' ') })
      return 'typed'
    case 'press':
      if (!first) throw new Error('press needs a key')
      await press(contents, first)
      await sleep(100)
      return `pressed ${first}`
    case 'select': {
      if (!first || second === undefined) throw new Error('select needs a ref and a value')
      const chosen = await callOn<string | null>(
        contents,
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
      const point = second ? await locate(contents, second) : await viewportCenter(contents)
      await paint(contents)
      await cdp(contents, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY })
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
        const found = await evaluate(contents, `document.body?.innerText.includes(${JSON.stringify(first)}) ?? false`).catch(() => false)
        if (found) return `found "${first}"`
        await sleep(250)
      }
      throw new Error(`"${first}" did not appear`)
    }
    case 'eval': {
      if (!first) throw new Error('eval needs an expression')
      const value = await evaluate(contents, args.join(' '))
      return value === undefined ? 'undefined' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    }
    case 'screenshot':
      return screenshot(contents, owner.dir, first === '--full')
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

async function viewportCenter(contents: WebContents): Promise<Point> {
  const { cssLayoutViewport } = await cdp<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>(
    contents,
    'Page.getLayoutMetrics',
  )
  return { x: cssLayoutViewport.clientWidth / 2, y: cssLayoutViewport.clientHeight / 2, label: 'center' }
}
