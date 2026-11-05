import { colorScheme } from 'nsh'

/**
 * The palette, for the places a class cannot reach: image tints, canvas drawing, inline styles.
 * The same values as nsh.json's theme and Tailwind colours; `color('brand')` follows the scheme.
 */
const LIGHT = {
  bg: '#faf9f5',
  panel: '#ffffff',
  fg: '#141413',
  'fg-2': '#6f6e68',
  'fg-3': 'rgba(111, 110, 104, 0.7)',
  fill: 'rgba(20, 20, 19, 0.04)',
  border: '#e6e3d9',
  brand: '#d97757',
  primary: '#c96442',
  ok: '#2fb380',
  warn: '#e0a83a',
  err: '#c23b2b',
  agent: '#9b6ee8',
  link: '#3b6fcf',
  log: '#f5f4ee',
  muted: '#f0eee6',
  sidebar: '#f4f3ee',
  'sidebar-accent': '#e9e7dd',
} as const

const DARK: Record<keyof typeof LIGHT, string> = {
  bg: '#262624',
  panel: '#30302e',
  fg: '#edebe3',
  'fg-2': '#a3a29b',
  'fg-3': 'rgba(163, 162, 155, 0.7)',
  fill: 'rgba(237, 235, 227, 0.04)',
  border: 'rgba(255, 255, 255, 0.10)',
  brand: '#d97757',
  primary: '#d97757',
  ok: '#2fb380',
  warn: '#e0a83a',
  err: '#e5604c',
  agent: '#9b6ee8',
  link: '#8fb3f0',
  log: '#1f1e1d',
  muted: '#393937',
  sidebar: '#1f1e1d',
  'sidebar-accent': '#34332f',
}

export type ColorName = keyof typeof LIGHT

/** The colour called `name` in the current scheme; reactive. */
export const color = (name: ColorName): string => (colorScheme() === 'dark' ? DARK : LIGHT)[name]

export const isDark = (): boolean => colorScheme() === 'dark'

export const isColorName = (name: string): name is ColorName => name in LIGHT
