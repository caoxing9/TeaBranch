import { type InputRef, Scroll, type ScrollRef, Text, View, cleanup, effect, signal } from 'nsh'
import { Input } from 'nsh/base'
import { t } from '../../../shared/i18n'
import { api, on } from '../../lib/api'

/** Output kept on screen; older lines fall off the top. */
const KEEP = 64 * 1024

/** Rough glyph metrics of the mono font at 12.5px, to tell the shell its size. */
const CELL_WIDTH = 7.5
const CELL_HEIGHT = 17

/** Escape sequences and carriage returns out, so the stream reads as plain lines. */
function clean(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\x1b[=>78]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[^\n]*\r(?!\n)/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

/**
 * A built-in terminal, first cut: the shell's output as text and a line to type into, until the
 * VT emulator arrives from the Rust side. Mounting attaches (starting the shell the first time)
 * and replays what it printed meanwhile; unmounting only detaches — closing the tab kills it.
 */
export function TerminalView(props: { id: string; cwd: string; active: boolean }) {
  const output = signal('')
  const command = signal('')
  const exited = signal(false)
  let scroll: ScrollRef | undefined
  let input: InputRef | undefined
  let closed = false
  let attached: number | null = null
  const early: { data: string; seq: number }[] = []
  let cols = 100
  let rows = 30

  const append = (data: string) => {
    const text = clean(output() + data)
    output.set(text.length > KEEP ? text.slice(text.length - KEEP) : text)
    scroll?.scrollToEnd({ animated: false })
  }
  const ended = () => {
    exited.set(true)
    append(`\n[${t('进程已退出')}]\n`)
  }

  // Live output that arrives before the replay is in hand waits, then only what's newer is written.
  cleanup(
    on('terminalData', (event) => {
      if (event.id !== props.id || closed) return
      if (attached === null) early.push(event)
      else if (event.seq > attached) append(event.data)
    }),
  )
  cleanup(
    on('terminalExit', (event) => {
      if (event.id === props.id && !closed) ended()
    }),
  )
  cleanup(() => {
    closed = true
  })
  void api
    .terminalOpen(props.id, props.cwd, cols, rows)
    .then(({ replay, seq, exited: done }) => {
      if (closed) return
      if (replay) append(replay)
      attached = seq
      for (const event of early) if (event.seq > seq) append(event.data)
      early.length = 0
      if (done) ended()
    })
    .catch((error) => append(`${String(error)}\n`))

  effect(() => {
    if (props.active) input?.focus()
  })

  const send = (data: string) => void api.terminalWrite(props.id, data)

  return (
    <View class="flex-1 bg-bg" onPress={() => input?.focus()}>
      <Scroll
        ref={(node) => (scroll = node)}
        class="min-h-0 flex-1"
        contentClass="px-3 py-1"
        onLayout={(e) => {
          const nextCols = Math.max(20, Math.floor((e.bounds.size.width - 24) / CELL_WIDTH))
          const nextRows = Math.max(4, Math.floor(e.bounds.size.height / CELL_HEIGHT))
          if (nextCols === cols && nextRows === rows) return
          cols = nextCols
          rows = nextRows
          if (attached !== null) void api.terminalResize(props.id, cols, rows)
        }}
      >
        <Text class="font-mono text-[12.5px] leading-[17px] text-fg" style={{ userSelect: 'text' }}>
          {output()}
        </Text>
      </Scroll>
      <View class="flex-row items-center gap-2 border-t border-border px-3 py-1">
        <Text class="font-mono text-[12.5px] text-fg-2">{exited() ? '×' : '›'}</Text>
        <Input
          ref={(node) => (input = node)}
          testID="terminal-input"
          value={command()}
          readonly={exited()}
          autoCorrect={false}
          autoCapitalize="none"
          placeholder={exited() ? t('进程已退出') : t('输入命令，⏎ 执行；^C 发送中断')}
          submitBehavior="submit"
          onChange={(e) => command.set(e.value)}
          onSubmit={() => {
            send(`${command()}\r`)
            command.set('')
          }}
          onKeyPress={(e) => {
            // Control-C as the shell knows it, from the text field's point of view.
            if (e.key === '\u0003') send('\u0003')
          }}
          class="h-7 flex-1 font-mono text-[12.5px] text-fg"
        />
        <Text class="text-[10.5px] text-fg-3">{t('完整终端模拟还在搬过来')}</Text>
      </View>
    </View>
  )
}
