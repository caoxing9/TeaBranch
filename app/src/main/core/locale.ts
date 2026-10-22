import { app } from 'electron'
import { type LanguagePref, resolveLocale, setLocale } from '@shared/i18n'

const listeners: (() => void)[] = []

/** Set the main process's language from the setting; menus and the tray rebuild in it. */
export function applyLocale(pref: LanguagePref | undefined): void {
  setLocale(resolveLocale(pref, app.getPreferredSystemLanguages()))
  for (const listener of listeners) listener()
}

export const onLocaleChange = (listener: () => void): void => {
  listeners.push(listener)
}
