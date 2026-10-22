import { net } from 'electron'

/**
 * HTTP through Chromium's network stack rather than Node's: `net.fetch` honours the system proxy
 * (and PAC files) the way the browser does, where Node's `fetch` ignores them and fails on networks
 * that only reach the internet through a proxy.
 *
 * One retry for a dropped connection — a reset TLS handshake is usually transient.
 */
export async function httpFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const attempt = () => net.fetch(String(url), init as Parameters<typeof net.fetch>[1])
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
    throw new Error(`连不上 ${host}：${cause?.code ?? cause?.message ?? (first as Error).message}（检查网络或代理）`, { cause: first })
  }
}
