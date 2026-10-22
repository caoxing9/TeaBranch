import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { type ITheme, Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import { api, on } from '@/lib/api'

/** Any CSS color (the palette is oklch) as #rrggbb, which xterm needs. */
function hex(css: string, fallback: string): string {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d')
  if (!context) return fallback
  context.fillStyle = fallback
  context.fillStyle = css
  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

const token = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

// MonoCode's palettes: One Light on a light canvas, a softened Tailwind set on a dark one.
const ANSI_LIGHT = {
  black: '#383a42',
  red: '#e45649',
  green: '#50a14f',
  yellow: '#c18401',
  blue: '#4078f2',
  magenta: '#a626a4',
  cyan: '#0184bc',
  white: '#fafafa',
  brightBlack: '#7c8591',
  brightRed: '#df6b60',
  brightGreen: '#68b567',
  brightYellow: '#d19a2f',
  brightBlue: '#5c89f5',
  brightMagenta: '#b54bb3',
  brightCyan: '#1f9cc9',
  brightWhite: '#ffffff',
}
const ANSI_DARK = {
  black: '#1d2428',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e8eef2',
  brightBlack: '#64748b',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#f8fafc',
}

function theme(): ITheme {
  const dark = document.documentElement.classList.contains('dark')
  return {
    background: hex(token('--background'), dark ? '#0a0a0a' : '#ffffff'),
    foreground: hex(token('--foreground'), dark ? '#fafafa' : '#0a0a0a'),
    cursor: hex(token('--brand'), '#4078f2'),
    cursorAccent: dark ? '#000000' : '#ffffff',
    selectionBackground: dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.15)',
    selectionInactiveBackground: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)',
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
  }
}

const openLink = (uri: string) => /^https?:\/\//i.test(uri) && void api.openExternal(uri)

/**
 * One xterm bound to a shell in the main process. Mounting attaches (starting the shell the first
 * time) and replays what it printed meanwhile; unmounting only detaches — closing the tab kills it.
 */
export function TerminalView({ id, cwd, active }: { id: string; cwd: string; active: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const fit = useRef<() => void>(() => {})

  useEffect(() => {
    const element = host.current
    if (!element) return
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: token('--font-mono') || 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.15,
      scrollback: 5000,
      macOptionIsMeta: true,
      theme: theme(),
      linkHandler: { activate: (_event, uri) => openLink(uri) },
    })
    const fitter = new FitAddon()
    term.loadAddon(fitter)
    term.loadAddon(new WebLinksAddon((_event, uri) => openLink(uri)))
    term.open(element)
    terminal.current = term
    let closed = false

    // ⌘ shortcuts are the app's (menu: copy, paste, ⌘J, ⌘`…), never the shell's; ⌘K clears like
    // Terminal.app. Copy and paste then reach xterm as clipboard events.
    term.attachCustomKeyEventHandler((event) => {
      if (!event.metaKey) return true
      if (event.key.toLowerCase() === 'k' && event.type === 'keydown') term.clear()
      return false
    })

    // Live output that arrives before the replay is in hand waits, then only what's newer is written.
    let attached: number | null = null
    const early: { data: string; seq: number }[] = []
    const offData = on('terminalData', (event) => {
      if (event.id !== id || closed) return
      if (attached === null) early.push(event)
      else if (event.seq > attached) term.write(event.data)
    })
    const offExit = on('terminalExit', (event) => {
      if (event.id === id && !closed) term.write('\r\n\x1b[2m[进程已退出]\x1b[0m\r\n')
    })

    let lastCols = 0
    let lastRows = 0
    const resize = () => {
      if (closed || !element.clientWidth || !element.clientHeight) return
      fitter.fit()
      if (term.cols === lastCols && term.rows === lastRows) return
      lastCols = term.cols
      lastRows = term.rows
      if (attached !== null) void api.terminalResize(id, term.cols, term.rows)
    }
    fit.current = resize
    resize()

    void api
      .terminalOpen(id, cwd, term.cols, term.rows)
      .then(({ replay, seq, exited }) => {
        if (closed) return
        if (replay) term.write(replay)
        attached = seq
        for (const event of early) if (event.seq > seq) term.write(event.data)
        early.length = 0
        if (exited) term.write('\r\n\x1b[2m[进程已退出]\x1b[0m\r\n')
      })
      .catch((error) => term.write(`\x1b[31m${String(error)}\x1b[0m\r\n`))

    const input = term.onData((data) => void api.terminalWrite(id, data))
    const observer = new ResizeObserver(() => requestAnimationFrame(resize))
    observer.observe(element)
    const themeWatch = new MutationObserver(() => (term.options.theme = theme()))
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    return () => {
      closed = true
      offData()
      offExit()
      input.dispose()
      observer.disconnect()
      themeWatch.disconnect()
      fit.current = () => {}
      term.dispose()
      terminal.current = null
    }
  }, [id, cwd])

  useEffect(() => {
    if (!active) return
    fit.current()
    terminal.current?.focus()
  }, [active])

  return (
    <div className="h-full w-full bg-background py-1 pl-3" onMouseDown={() => terminal.current?.focus()}>
      <div ref={host} className="h-full w-full" />
    </div>
  )
}
