/**
 * ANSI SGR escapes → styled segments. Dev servers colour their output and losing it hurts. Only
 * the colours and the four common attributes are read; everything else is dropped.
 */
export interface AnsiSegment {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

const BASIC = ['#000000', '#c23b2b', '#2fb380', '#e0a83a', '#5b8fdc', '#9b6ee8', '#2aa198', '#d0cfc8']
const BRIGHT = ['#7f7f7f', '#e5604c', '#4cd39a', '#f2c14e', '#7aa8f0', '#b28bff', '#5ad1c0', '#ffffff']

/** The 256-colour cube and greys, as xterm lays them out. */
function xterm(n: number): string {
  if (n < 8) return BASIC[n]
  if (n < 16) return BRIGHT[n - 8]
  if (n < 232) {
    const i = n - 16
    const steps = [0, 95, 135, 175, 215, 255]
    const r = steps[Math.floor(i / 36)]
    const g = steps[Math.floor(i / 6) % 6]
    const b = steps[i % 6]
    return `rgb(${r}, ${g}, ${b})`
  }
  const grey = 8 + (n - 232) * 10
  return `rgb(${grey}, ${grey}, ${grey})`
}

const ESCAPE = /\u001b\[([0-9;]*)m|\u001b\][^\u0007]*\u0007|\u001b[()][AB012]|\u001b\[[0-9;]*[A-Za-z]/g

export function parseAnsi(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = []
  let state: Omit<AnsiSegment, 'text'> = {}
  let from = 0
  for (const match of text.matchAll(ESCAPE)) {
    if (match.index > from) segments.push({ text: text.slice(from, match.index), ...state })
    from = match.index + match[0].length
    if (match[1] === undefined) continue
    const codes = match[1] === '' ? [0] : match[1].split(';').map(Number)
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]
      if (code === 0) state = {}
      else if (code === 1) state = { ...state, bold: true }
      else if (code === 2) state = { ...state, dim: true }
      else if (code === 3) state = { ...state, italic: true }
      else if (code === 4) state = { ...state, underline: true }
      else if (code === 22) state = { ...state, bold: false, dim: false }
      else if (code === 23) state = { ...state, italic: false }
      else if (code === 24) state = { ...state, underline: false }
      else if (code >= 30 && code <= 37) state = { ...state, fg: BASIC[code - 30] }
      else if (code >= 90 && code <= 97) state = { ...state, fg: BRIGHT[code - 90] }
      else if (code === 39) state = { ...state, fg: undefined }
      else if (code >= 40 && code <= 47) state = { ...state, bg: BASIC[code - 40] }
      else if (code >= 100 && code <= 107) state = { ...state, bg: BRIGHT[code - 100] }
      else if (code === 49) state = { ...state, bg: undefined }
      else if ((code === 38 || code === 48) && codes[i + 1] === 5) {
        const color = xterm(codes[i + 2] ?? 0)
        state = code === 38 ? { ...state, fg: color } : { ...state, bg: color }
        i += 2
      } else if ((code === 38 || code === 48) && codes[i + 1] === 2) {
        const color = `rgb(${codes[i + 2] ?? 0}, ${codes[i + 3] ?? 0}, ${codes[i + 4] ?? 0})`
        state = code === 38 ? { ...state, fg: color } : { ...state, bg: color }
        i += 4
      }
    }
  }
  if (from < text.length) segments.push({ text: text.slice(from), ...state })
  return segments.filter((segment) => segment.text.length)
}

export const stripAnsi = (text: string): string => text.replace(ESCAPE, '')
