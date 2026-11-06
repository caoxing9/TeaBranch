import { t } from '../shared/i18n'

/**
 * HTTP through the host's network stack (nsh's `fetch` is native and follows the system proxy).
 *
 * One retry for a dropped connection — a reset TLS handshake is usually transient.
 */
export async function httpFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const attempt = () => fetch(String(url), init)
  try {
    return await attempt()
  } catch (first) {
    if ((init.method ?? 'GET') === 'GET') {
      try {
        return await attempt()
      } catch {
        // Report the original failure below.
      }
    }
    const cause = (first as { cause?: { code?: string; message?: string } }).cause
    const host = new URL(String(url)).host
    const reason = cause?.code ?? cause?.message ?? (first as Error).message
    throw new Error(t('连不上 {host}：{reason}（检查网络或代理）', { host, reason }), { cause: first })
  }
}
