import { getLocale } from '@shared/i18n'

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

/** The coarsest useful unit — a dev server's age matters to the minute. */
export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

export const cx = (...classes: (string | false | null | undefined)[]): string => classes.filter(Boolean).join(' ')

/**
 * English catalog entries are written plural ("{n} files"); this turns "1 files" into "1 file".
 * Chinese has no plural, so it passes through.
 */
export const plural = (text: string): string =>
  getLocale() === 'en'
    ? text.replace(/\b1 ([\w-]+?(?:ch|sh|ss|x))es\b|\b1 ([\w-]+?)s\b/g, (_, a?: string, b?: string) => `1 ${a ?? b}`)
    : text
