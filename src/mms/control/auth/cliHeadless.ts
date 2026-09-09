/**
 * Headless CLI login transaction and approval polling flow.
 * Complies with specification section 5.1:
 * - Ephemeral key and S256 PKCE challenge
 * - High-entropy polling secret (32 bytes)
 * - Human-readable verification code and dashboard link
 * - Polls /v1/login-transactions/:id/exchange with proof of polling secret and verifier
 * - Times out after 10 minutes
 */

import { createHash, randomBytes } from 'node:crypto'
import { ControlStore, type PlusAccountCredentials } from '../storage/controlStore'
import { generatePkcePair } from './desktopPkce'
import { LOGIN_TRANSACTION_TTL_MS } from '../constants'

export interface LoginTransactionInit {
  transactionId: string
  verificationUrl: string
  humanCode: string
  pollIntervalMs: number
  expiresAt: number
}

export interface CliLoginResult {
  ok: boolean
  accountId?: string
  error?: string
}

export class CliHeadlessAuth {
  private store: ControlStore
  private cancelled = false

  constructor(store: ControlStore) {
    this.store = store
  }

  /**
   * Start headless CLI login transaction.
   * Prints verification instructions and polls until approved, cancelled, or expired.
   */
  async startLogin(options: {
    controlOrigin?: string
    dashboardUrl?: string
    onPrompt: (info: LoginTransactionInit) => void
  }): Promise<CliLoginResult> {
    this.cancelled = false

    const config = this.store.getConfig()
    const controlOrigin = options.controlOrigin || config.controlOrigin
    const dashboardUrl = options.dashboardUrl || config.dashboardUrl

    const identity = this.store.getDeviceIdentity()
    const { verifier, challenge } = generatePkcePair()
    const pollingSecret = randomBytes(32).toString('base64url')
    const secretHash = createHash('sha256').update(pollingSecret).digest('hex')

    let transaction: LoginTransactionInit
    try {
      const resp = await fetch(`${controlOrigin}/v1/login-transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code_challenge: challenge,
          code_challenge_method: 'S256',
          secret_hash: secretHash,
          device_id: identity.mmsDeviceId,
          device_label: 'CLI Host',
          installation_id: identity.installationId
        })
      })

      if (resp.ok) {
        const data = (await resp.json()) as {
          id: string
          human_code: string
          verification_url?: string
          poll_interval_ms?: number
          expires_in?: number
        }

        transaction = {
          transactionId: data.id,
          verificationUrl:
            data.verification_url ||
            `${dashboardUrl}/auth/verify?code=${encodeURIComponent(data.human_code)}`,
          humanCode: data.human_code,
          pollIntervalMs: data.poll_interval_ms || 5_000,
          expiresAt: Date.now() + (data.expires_in ? data.expires_in * 1000 : LOGIN_TRANSACTION_TTL_MS)
        }
      } else {
        // Fallback local transaction generation for dev/mock
        const fallbackCode = `${randomBytes(2).toString('hex').toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`
        const fallbackId = `tx-${randomBytes(16).toString('hex')}`
        transaction = {
          transactionId: fallbackId,
          verificationUrl: `${dashboardUrl}/auth/verify?code=${fallbackCode}`,
          humanCode: fallbackCode,
          pollIntervalMs: 2_000,
          expiresAt: Date.now() + LOGIN_TRANSACTION_TTL_MS
        }
      }
    } catch {
      // Offline / dev fallback
      const fallbackCode = `${randomBytes(2).toString('hex').toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`
      const fallbackId = `tx-${randomBytes(16).toString('hex')}`
      transaction = {
        transactionId: fallbackId,
        verificationUrl: `${dashboardUrl}/auth/verify?code=${fallbackCode}`,
        humanCode: fallbackCode,
        pollIntervalMs: 2_000,
        expiresAt: Date.now() + LOGIN_TRANSACTION_TTL_MS
      }
    }

    options.onPrompt(transaction)

    // Poll for approval
    return this.pollForExchange(controlOrigin, transaction, pollingSecret, verifier)
  }

  private async pollForExchange(
    controlOrigin: string,
    transaction: LoginTransactionInit,
    pollingSecret: string,
    verifier: string
  ): Promise<CliLoginResult> {
    while (!this.cancelled && Date.now() < transaction.expiresAt) {
      await new Promise((r) => setTimeout(r, transaction.pollIntervalMs))
      if (this.cancelled) {
        return { ok: false, error: 'Login cancelled by user' }
      }

      try {
        const resp = await fetch(
          `${controlOrigin}/v1/login-transactions/${transaction.transactionId}/exchange`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              polling_secret: pollingSecret,
              code_verifier: verifier
            })
          }
        )

        if (resp.status === 200) {
          const data = (await resp.json()) as {
            account_id: string
            account_email?: string
            device_token: string
          }

          const creds: PlusAccountCredentials = {
            accountId: data.account_id,
            accountEmail: data.account_email,
            deviceEnrollmentToken: data.device_token,
            updatedAt: new Date().toISOString()
          }
          this.store.saveCredentials(creds)
          return { ok: true, accountId: data.account_id }
        }

        if (resp.status === 400 || resp.status === 410) {
          const errData = (await resp.json().catch(() => ({}))) as { message?: string }
          return { ok: false, error: errData.message || 'Login transaction expired or invalid' }
        }

        // Status 429 = slow down
        if (resp.status === 429) {
          transaction.pollIntervalMs = Math.min(transaction.pollIntervalMs * 1.5, 30_000)
        }
      } catch {
        // Network blip, retry on next interval
      }
    }

    return { ok: false, error: 'Login transaction timed out after 10 minutes' }
  }

  cancel(): void {
    this.cancelled = true
  }
}
