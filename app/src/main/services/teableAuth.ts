import type { TeableConfig } from '@shared/types'
import { httpFetch } from '../core/http'
import { log, TeaBranchError } from '../core/log'
import { readSecret, writeSecret } from '../core/secrets'
import { loadTeableConfig } from '../core/settingsStore'
import { apiBase } from './teable'

/**
 * Teable sign-in: OAuth device authorization (RFC 8628), with a personal access token as the
 * fallback.
 *
 * Device flow suits a desktop app: no redirect URI to host, and no client secret to hide — the
 * token endpoint accepts a bare `client_id` from public clients. The app shows a short code, the
 * browser approves it, and polling picks the token up.
 */

interface OAuthSession {
  accessToken: string
  refreshToken?: string
  /** Epoch ms; undefined when the server didn't say. */
  expiresAt?: number
  clientId: string
}

export interface DeviceCode {
  userCode: string
  verificationUri: string
  expiresIn: number
}

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

/**
 * The OAuth app TeaBranch ships with, per Teable host, so a fresh download signs in to teable.ai
 * with one click. A client id is public by design — device flow needs no secret, and every sign-in
 * still has to be approved in the browser by the person signing in. Never put a client secret here.
 */
const builtinClientIds: Record<string, string> = {
  'https://app.teable.ai': '',
}

/** The configured client id, else the built-in one for this host. */
export function clientIdFor(config: TeableConfig): string | undefined {
  const configured = config.oauthClientId?.trim()
  if (configured) return configured
  return builtinClientIds[apiBase(config)] || undefined
}

const loadSession = (): OAuthSession | undefined => {
  const raw = readSecret('teable.oauth')
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as OAuthSession
  } catch {
    return undefined
  }
}

const saveSession = (session: OAuthSession | undefined): void =>
  writeSecret('teable.oauth', session ? JSON.stringify(session) : undefined)

export function signOut(): void {
  saveSession(undefined)
  writeSecret('teable.token', undefined)
}

/** Whichever credential is current — refreshing an OAuth token that is about to expire. */
export async function accessToken(): Promise<string | undefined> {
  const session = loadSession()
  if (!session) return readSecret('teable.token')
  if (session.expiresAt && session.expiresAt - Date.now() < 60_000 && session.refreshToken) {
    try {
      const refreshed = await tokenRequest(loadTeableConfig(), {
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken,
        client_id: session.clientId,
      })
      const next = toSession(refreshed, session.clientId, session.refreshToken)
      saveSession(next)
      return next.accessToken
    } catch (error) {
      log.warn(`Teable token refresh failed: ${String(error)}`)
      // Fall through with the old token; the API call will say if it is really dead.
    }
  }
  return session.accessToken
}

export function savePersonalToken(token: string): void {
  saveSession(undefined)
  writeSecret('teable.token', token)
}

// MARK: - Device flow

let pending: { cancelled: boolean } | null = null

export async function startDeviceLogin(clientId: string, onDone: (error?: string) => void): Promise<DeviceCode> {
  const config = loadTeableConfig()
  const response = await httpFetch(`${apiBase(config)}/api/oauth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) throw new TeaBranchError(oauthError(body, response.status))

  const deviceCode = String(body.device_code)
  let interval = Number(body.interval ?? 5) * 1000
  const expiresAt = Date.now() + Number(body.expires_in ?? 600) * 1000

  if (pending) pending.cancelled = true
  const attempt = { cancelled: false }
  pending = attempt

  // Poll in the background; the renderer hears the outcome through `onDone`.
  void (async () => {
    while (!attempt.cancelled && Date.now() < expiresAt) {
      await new Promise((resolve) => setTimeout(resolve, interval))
      if (attempt.cancelled) return
      try {
        const token = await tokenRequest(config, { grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: clientId })
        saveSession(toSession(token, clientId))
        writeSecret('teable.token', undefined)
        pending = null
        onDone()
        return
      } catch (error) {
        const code = (error as { code?: string }).code
        if (code === 'authorization_pending') continue
        if (code === 'slow_down') {
          interval += 5000
          continue
        }
        pending = null
        onDone(code === 'access_denied' ? '你在浏览器里拒绝了授权' : String((error as Error).message))
        return
      }
    }
    if (!attempt.cancelled) onDone('验证码已过期，请重新登录')
  })()

  return {
    userCode: String(body.user_code),
    verificationUri: String(body.verification_uri),
    expiresIn: Number(body.expires_in ?? 600),
  }
}

export function cancelDeviceLogin(): void {
  if (pending) pending.cancelled = true
  pending = null
}

// MARK: - Internals

async function tokenRequest(config: TeableConfig, params: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await httpFetch(`${apiBase(config)}/api/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok || !body.access_token) {
    const error = new TeaBranchError(oauthError(body, response.status)) as TeaBranchError & { code?: string }
    error.code = typeof body.error === 'string' ? body.error : undefined
    throw error
  }
  return body
}

function toSession(body: Record<string, unknown>, clientId: string, previousRefresh?: string): OAuthSession {
  const expiresIn = Number(body.expires_in)
  return {
    accessToken: String(body.access_token),
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : previousRefresh,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
    clientId,
  }
}

const oauthError = (body: Record<string, unknown>, status: number): string => {
  const code = String(body.error ?? '')
  const description = String(body.error_description ?? body.message ?? '')
  if (code === 'invalid_client') return 'Teable 不认识这个 Client ID — 检查 OAuth 应用设置'
  if (code === 'unauthorized_client') return '这个 OAuth 应用没有开启 Device Flow — 在 Teable 的 OAuth 应用设置里打开它'
  return `${description || code || 'OAuth 请求失败'} (${status})`
}
