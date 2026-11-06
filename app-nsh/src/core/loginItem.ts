import { log } from './log'

let wanted: boolean | undefined

/**
 * Start at login. macOS registers login items per bundle (`SMAppService`), so this only takes
 * effect in the packaged app, where the Rust base registers the bundle; the development host
 * remembers the wish and says so once.
 */
export function setOpenAtLogin(open: boolean): void {
  if (wanted === open) return
  wanted = open
  log.info(`login item: ${open ? 'on' : 'off'} (applies to the packaged app)`)
}

export const openAtLogin = (): boolean => wanted ?? false
