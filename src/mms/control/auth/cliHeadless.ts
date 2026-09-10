/** Server-issued headless login transactions with cancellable, bounded polling. */
import { createHash, randomBytes } from 'node:crypto'
import { ControlStore } from '../storage/controlStore'
import { generatePkcePair } from './desktopPkce'
import { LOGIN_TRANSACTION_TTL_MS } from '../constants'
import { authDelay, authDuration, authRecord, authRequest, authString, authUrl, type AuthFetch } from './authTransport'

export interface LoginTransactionInit {
  transactionId: string; verificationUrl: string; humanCode: string; pollIntervalMs: number; expiresAt: number
}
export interface CliLoginResult { ok: boolean; accountId?: string; error?: string }

export class CliHeadlessAuth {
  private active?: AbortController
  constructor(private readonly store: ControlStore, private readonly fetcher: AuthFetch = fetch) {}

  async startLogin(options: {
    controlOrigin?: string; dashboardUrl?: string; onPrompt: (info: LoginTransactionInit) => void
  }): Promise<CliLoginResult> {
    this.cancel()
    const controller = new AbortController()
    this.active = controller
    const signal = controller.signal
    try {
      const config = this.store.getConfig()
      const origin = authUrl(options.controlOrigin ?? config.controlOrigin).replace(/\/$/, '')
      const dashboard = authUrl(options.dashboardUrl ?? config.dashboardUrl).replace(/\/$/, '')
      const identity = this.store.getDeviceIdentity()
      const { verifier, challenge } = generatePkcePair()
      const pollingSecret = randomBytes(32).toString('base64url')
      const response = await authRequest(this.fetcher, origin + '/v1/login-transactions', {
        code_challenge: challenge, code_challenge_method: 'S256',
        secret_hash: createHash('sha256').update(pollingSecret).digest('hex'),
        device_id: identity.mmsDeviceId, device_label: 'CLI Host', installation_id: identity.installationId
      }, signal)
      if (!response.ok) throw new Error('Login transaction failed with status ' + response.status)
      const data = authRecord(await response.json())
      const code = authString(data.human_code, 'human_code')!
      const transaction: LoginTransactionInit = {
        transactionId: authString(data.id, 'id')!,
        humanCode: code,
        verificationUrl: authUrl(authString(data.verification_url, 'verification_url', true) ?? dashboard + '/auth/verify?code=' + encodeURIComponent(code)),
        pollIntervalMs: Math.max(1000, authDuration(data.poll_interval_ms, 5000, 30_000)),
        expiresAt: Date.now() + authDuration(data.expires_in, LOGIN_TRANSACTION_TTL_MS / 1000, LOGIN_TRANSACTION_TTL_MS / 1000) * 1000
      }
      signal.throwIfAborted()
      options.onPrompt({ ...transaction })
      while (Date.now() < transaction.expiresAt) {
        await authDelay(Math.min(transaction.pollIntervalMs, Math.max(1, transaction.expiresAt - Date.now())), signal)
        if (Date.now() >= transaction.expiresAt) break
        let exchange: Response
        try {
          exchange = await authRequest(this.fetcher, origin + '/v1/login-transactions/' + encodeURIComponent(transaction.transactionId) + '/exchange', {
            polling_secret: pollingSecret, code_verifier: verifier
          }, signal)
        } catch (error) { if (signal.aborted) throw error; continue }
        signal.throwIfAborted()
        if (exchange.status === 200) {
          const account = authRecord(await exchange.json())
          const accountId = authString(account.account_id, 'account_id')!
          const deviceEnrollmentToken = authString(account.device_token, 'device_token')!
          const accountEmail = authString(account.account_email, 'account_email', true)
          signal.throwIfAborted()
          this.store.saveCredentials({ accountId, accountEmail, deviceEnrollmentToken, updatedAt: new Date().toISOString() })
          return { ok: true, accountId }
        }
        if ([400, 401, 403, 404, 410].includes(exchange.status)) throw new Error('Login transaction expired, denied, or invalid (status ' + exchange.status + ')')
        if (exchange.status === 429) transaction.pollIntervalMs = Math.min(transaction.pollIntervalMs * 1.5, 30_000)
      }
      return { ok: false, error: 'Login transaction timed out' }
    } catch (error) {
      return { ok: false, error: signal.aborted ? 'Login cancelled by user' : error instanceof Error ? error.message : 'Authentication failed' }
    } finally {
      if (this.active === controller) this.active = undefined
      controller.abort()
    }
  }
  cancel(): void { this.active?.abort(); this.active = undefined }
}
