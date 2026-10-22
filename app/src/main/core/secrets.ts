import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { configDirectory } from './settingsStore'

/**
 * Secrets — the Teable token, a Magpie key — encrypted with the OS keychain via `safeStorage`,
 * never written in the clear next to the settings, which are easy to paste into a bug report.
 */
export type SecretName = 'teable.token' | 'teable.oauth' | 'magpie.key'

const path = (name: SecretName): string => join(configDirectory, 'secrets', `${name}.bin`)

export function readSecret(name: SecretName): string | undefined {
  try {
    return safeStorage.decryptString(readFileSync(path(name)))
  } catch {
    return undefined
  }
}

export function writeSecret(name: SecretName, value: string | undefined): void {
  if (!value) {
    rmSync(path(name), { force: true })
    return
  }
  mkdirSync(join(configDirectory, 'secrets'), { recursive: true, mode: 0o700 })
  writeFileSync(path(name), safeStorage.encryptString(value), { mode: 0o600 })
}
