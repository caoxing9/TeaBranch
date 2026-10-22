import { en } from './en'

/**
 * Two languages, Chinese as the source: the key of a string is its Chinese text, and the English
 * catalog maps it over. A missing English entry falls back to the Chinese (the catalog test catches
 * those). Placeholders are `{name}`. Main and renderer each hold the current locale; the renderer
 * reloads when it changes.
 */

export type Locale = 'zh' | 'en'
/** The setting: follow macOS, or pin a language. */
export type LanguagePref = 'system' | Locale

let current: Locale = 'zh'

export const setLocale = (locale: Locale): void => {
  current = locale
}
export const getLocale = (): Locale => current

export function t(text: string, vars?: Record<string, string | number>): string {
  const translated = current === 'en' ? (en[text] ?? text) : text
  return vars ? translated.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match)) : translated
}

/** Chinese when macOS prefers any Chinese, English otherwise. */
export const resolveLocale = (pref: LanguagePref | undefined, system: readonly string[]): Locale =>
  pref === 'zh' || pref === 'en' ? pref : system[0]?.toLowerCase().startsWith('zh') ? 'zh' : 'en'

/** The language agents should write reports and PRs in. */
export const languageName = (locale: Locale = current): string => (locale === 'zh' ? 'Chinese' : 'English')
