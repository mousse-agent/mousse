/**
 * Desktop PKCE flow: credentials are stored only after a validated token
 * exchange and device enrollment. Each attempt owns its callback and abort.
 */
import { createServer } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { ControlStore, type PlusAccountCredentials } from '../storage/controlStore'
import { signEd25519 } from '../crypto/keys'
import { authDuration, authRecord, authRequest, authString, authUrl, escapeAuthHtml, type AuthFetch } from './authTransport'

export interface DesktopLoginResult { ok: boolean; accountId?: string; accountEmail?: string; error?: string }
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export class DesktopPkceAuth {
  private cancelAttempt?: () => void
  constructor(private readonly store: ControlStore, private readonly fetcher: AuthFetch = fetch) {}

  async startLogin(options: {
    openExternal: (url: string) => Promise<void>
    dashboardUrl?: string; controlOrigin?: string; timeoutMs?: number
  }): Promise<DesktopLoginResult> {
    this.cancel()
    const config = this.store.getConfig()
    let dashboard: URL
    let origin: string
    try {
      dashboard = new URL(authUrl(options.dashboardUrl ?? config.dashboardUrl))
      origin = authUrl(options.controlOrigin ?? config.controlOrigin).replace(/\/$/, '')
    } catch { return { ok: false, error: 'Invalid authentication server URL' } }
    const { verifier, challenge } = generatePkcePair()
    const state = randomBytes(32).toString('base64url')
    const abort = new AbortController()
    return new Promise((resolve) => {
      let settled = false
      let exchanging = false
      let port = 0
      const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 300_000, 1), 600_000)
      const timer = setTimeout(() => finish({ ok: false, error: 'Login timed out' }), timeoutMs)
      const finish = (result: DesktopLoginResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        abort.abort()
        if (this.cancelAttempt === cancel) this.cancelAttempt = undefined
        server.close()
        server.closeIdleConnections()
        resolve(result)
      }
      const cancel = () => finish({ ok: false, error: 'Login cancelled' })
      this.cancelAttempt = cancel
      const server = createServer(async (request, response) => {
        const reply = (status: number, title: string, message: string) => {
          if (response.destroyed || response.writableEnded) return
          response.writeHead(status, {
            'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
            'X-Content-Type-Options': 'nosniff'
          })
          response.end('<!DOCTYPE html><html><body><h2>' + escapeAuthHtml(title) + '</h2><p>' + escapeAuthHtml(message) + '</p></body></html>')
        }
        try {
          const parsed = new URL(request.url ?? '/', 'http://127.0.0.1')
          if (request.method !== 'GET' || parsed.pathname !== '/callback') { reply(404, 'Not Found', ''); return }
          if (settled || exchanging) { reply(409, 'Login unavailable', 'This callback has already been handled.'); return }
          const returned = parsed.searchParams.get('state')
          if (!returned || Buffer.byteLength(returned) !== Buffer.byteLength(state) || !timingSafeEqual(Buffer.from(returned), Buffer.from(state))) {
            reply(400, 'Invalid State', 'State validation failed. Please try again.')
            finish({ ok: false, error: 'State validation failed' })
            return
          }
          const providerError = parsed.searchParams.get('error')
          if (providerError) {
            const message = (parsed.searchParams.get('error_description') ?? providerError).slice(0, 1024)
            reply(200, 'Authentication Cancelled', message)
            finish({ ok: false, error: message })
            return
          }
          const code = parsed.searchParams.get('code')
          if (!code || code.length > 16_384) { reply(400, 'Missing Code', 'No authorization code received.'); finish({ ok: false, error: 'No authorization code received' }); return }
          exchanging = true
          const credentials = await this.exchange(origin, code, verifier, 'http://127.0.0.1:' + port + '/callback', abort.signal)
          abort.signal.throwIfAborted()
          credentials.deviceEnrollmentToken = await this.enroll(origin, credentials, abort.signal)
          abort.signal.throwIfAborted()
          if (settled) return
          this.store.saveCredentials(credentials)
          reply(200, 'Signed in to Mousse Plus!', 'You can close this tab and return to Mousse.')
          finish({ ok: true, accountId: credentials.accountId, accountEmail: credentials.accountEmail })
        } catch (error) {
          if (settled) { reply(409, 'Login cancelled', 'Please start a new login.'); return }
          const message = error instanceof Error ? error.message : 'Authentication failed'
          reply(500, 'Authentication Error', message)
          finish({ ok: false, error: message })
        }
      })
      server.on('error', () => finish({ ok: false, error: 'Failed to start login callback server' }))
      server.listen(0, '127.0.0.1', async () => {
        if (settled) { server.close(); return }
        const address = server.address()
        if (!address || typeof address === 'string') { finish({ ok: false, error: 'Failed to bind loopback server' }); return }
        port = address.port
        const url = new URL(dashboard)
        url.pathname = url.pathname.replace(/\/$/, '') + '/login'
        url.search = new URLSearchParams({
          client_id: 'mousse-desktop', response_type: 'code', code_challenge: challenge,
          code_challenge_method: 'S256', state, redirect_uri: 'http://127.0.0.1:' + port + '/callback'
        }).toString()
        try { await options.openExternal(url.toString()) }
        catch { finish({ ok: false, error: 'Failed to open system browser' }) }
      })
    })
  }

  private async exchange(origin: string, code: string, verifier: string, redirect: string, signal: AbortSignal): Promise<PlusAccountCredentials> {
    const response = await authRequest(this.fetcher, origin + '/v1/auth/token', {
      grant_type: 'authorization_code', client_id: 'mousse-desktop', code, code_verifier: verifier, redirect_uri: redirect
    }, signal)
    if (!response.ok) throw new Error('Token exchange failed with status ' + response.status)
    const data = authRecord(await response.json())
    return {
      accountId: authString(data.account_id, 'account_id')!,
      accountEmail: authString(data.email, 'email', true),
      accountName: authString(data.name, 'name', true),
      accessToken: authString(data.access_token, 'access_token')!,
      refreshToken: authString(data.refresh_token, 'refresh_token', true),
      expiresAt: data.expires_in === undefined ? undefined : Date.now() + authDuration(data.expires_in, 3600, 365 * 86400) * 1000,
      updatedAt: new Date().toISOString()
    }
  }

  private async enroll(origin: string, credentials: PlusAccountCredentials, signal: AbortSignal): Promise<string> {
    const identity = this.store.getDeviceIdentity()
    const challenge = randomBytes(16).toString('hex')
    const signature = signEd25519(challenge, this.store.getSigningKeyPair().privateKey).toString('base64')
    const response = await authRequest(this.fetcher, origin + '/v1/devices/enroll', {
      device_id: identity.mmsDeviceId, installation_id: identity.installationId,
      public_key: identity.transportPublicKey, signing_key: identity.signingPublicKey,
      challenge, signature, device_label: 'Desktop MMS'
    }, signal, { Authorization: 'Bearer ' + credentials.accessToken })
    if (!response.ok) throw new Error('Device enrollment failed with status ' + response.status)
    return authString(authRecord(await response.json()).device_token, 'device_token')!
  }

  cancel(): void { this.cancelAttempt?.() }
}
