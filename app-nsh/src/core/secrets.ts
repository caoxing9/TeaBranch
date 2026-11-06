import { Keychain } from 'teabranch/native'

/**
 * Secrets — the Teable token, a Magpie key — in the macOS keychain, never written in the clear
 * next to the settings, which are easy to paste into a bug report.
 */
export type SecretName = 'teable.token' | 'teable.oauth' | 'magpie.key' | 'feishu.secret' | 'feishu.user'

export function readSecret(name: SecretName): string | undefined {
  try {
    return Keychain.get(name) ?? undefined
  } catch {
    return undefined
  }
}

export function writeSecret(name: SecretName, value: string | undefined): void {
  if (!value) Keychain.delete(name)
  else Keychain.set(name, value)
}
