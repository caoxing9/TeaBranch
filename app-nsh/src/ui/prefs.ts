import { Storage } from 'nsh'

/**
 * Per-user conveniences that `localStorage` kept in the React build: the section, the theme, the
 * sidebar width. nsh's `Storage` is asynchronous, so everything is read once at start into a map
 * the views read synchronously, and written through.
 */
const cache = new Map<string, string>()

export async function loadPrefs(): Promise<void> {
  for (const key of await Storage.keys()) {
    const value = await Storage.getItem(key)
    if (value !== null) cache.set(key, value)
  }
}

export function pref<T>(key: string, fallback: T): T {
  try {
    const raw = cache.get(key)
    return raw === undefined ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function setPref(key: string, value: unknown): void {
  const raw = JSON.stringify(value)
  cache.set(key, raw)
  void Storage.setItem(key, raw).catch(() => undefined)
}
