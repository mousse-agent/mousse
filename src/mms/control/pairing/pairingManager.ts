/**
 * Pairing Manager for MMS:
 * - Creates QR v2 pairing attempts with 256-bit one-time secrets
 * - Enforces single pending pairing and 2-minute expiration
 * - Handles claimed peer handshakes and explicit local user approval
 * - Signs pairing receipts and updates control server
 * - Enforces immediate local revocation
 */

import { EventEmitter } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import type {
  ClaimedPeerInfo,
  CreatePairingResult,
  PairingGrant,
  PendingPairingState,
  QrPayload,
  QrV2Payload,
  RemoteScope
} from '../../../shared/controlTypes'
import { DEFAULT_PAIRING_SCOPES } from '../../../shared/controlTypes'
import { ControlStore } from '../storage/controlStore'
import { encodePairingQrUri } from './pairingQr'
import { computeFingerprint, signEd25519 } from '../crypto/keys'
import { PAIRING_SECRET_BYTES, QR_TTL_MS } from '../constants'

export interface PairingManagerEvents {
  'pairing:created': (state: PendingPairingState) => void
  'pairing:claimed': (info: ClaimedPeerInfo, pairingId: string) => void
  'pairing:approved': (grant: PairingGrant) => void
  'pairing:rejected': (pairingId: string) => void
  'pairing:revoked': (grant: PairingGrant) => void
  'pairing:expired': (pairingId: string) => void
}

export class PairingManager extends EventEmitter {
  private store: ControlStore
  private currentPending: PendingPairingState | null = null
  private expiryTimer: NodeJS.Timeout | null = null

  constructor(store: ControlStore) {
    super()
    this.store = store
  }

  getPendingPairing(): PendingPairingState | null {
    if (this.currentPending && Date.now() > this.currentPending.expiresAt) {
      this.cancelPending('expired')
      return null
    }
    return this.currentPending
  }

  /**
   * Create a new QR v2 pairing attempt.
   * Cancels any existing pending pairing attempt.
   */
  async createPairingAttempt(options?: {
    scopes?: RemoteScope[]
    ttlMs?: number
    onRegisterWithServer?: (pairingId: string, expiresAt: number) => Promise<void>
  }): Promise<CreatePairingResult> {
    // Cancel prior pending attempt
    if (this.currentPending) {
      this.cancelPending('replaced')
    }

    const config = this.store.getConfig()
    const identity = this.store.getDeviceIdentity()
    const credentials = this.store.getCredentials()

    const pairingId = `pair-${randomUUID()}`
    const pairingSecretBuf = randomBytes(PAIRING_SECRET_BYTES)
    const pairingSecret = pairingSecretBuf.toString('base64url')

    const ttl = options?.ttlMs ?? QR_TTL_MS
    const expiresAt = Date.now() + ttl
    const scopes = options?.scopes ?? [...DEFAULT_PAIRING_SCOPES]

    function toBase64UrlKey(key: string): string {
      if (/^[A-Za-z0-9_-]{43}$/.test(key)) return key
      return Buffer.from(key, 'base64').toString('base64url')
    }

    const accountId =
      credentials?.accountId ||
      (config.mode === 'hosted' ? `acct_${identity.installationId.slice(0, 16)}` : undefined)

    const qrPayload: QrPayload = {
      mode: config.mode,
      controlOrigin: config.controlOrigin,
      installationId: identity.installationId,
      installationPublicKey: toBase64UrlKey(identity.installationPublicKey),
      mmsDeviceId: identity.mmsDeviceId,
      mmsIdentityPublicKey: toBase64UrlKey(identity.transportPublicKey),
      pairingId,
      expiresAt,
      protocolMajor: 2,
      pairingSecret,
      ...(accountId ? { accountId } : {})
    }


    const qrUri = encodePairingQrUri(qrPayload)

    // Register pending route with Control Server (without secret!) if callback supplied
    if (options?.onRegisterWithServer) {
      await options.onRegisterWithServer(pairingId, expiresAt)
    }

    this.currentPending = {
      pairingId,
      pairingSecret,
      expiresAt,
      requestedScopes: scopes,
      qrUri,
      state: 'pending'
    }

    this.expiryTimer = setTimeout(() => {
      if (this.currentPending?.pairingId === pairingId) {
        this.cancelPending('expired')
      }
    }, ttl)

    this.emit('pairing:created', this.currentPending)

    return {
      pairingId,
      qrUri,
      expiresAt,
      scopes
    }
  }

  /**
   * Record that a mobile peer has initiated the handshake and claimed this route.
   */
  recordClaim(
    pairingIdOrOpts:
      | string
      | {
          pairingId?: string
          mobileDeviceId: string
          mobileDeviceName?: string
          mobileStaticPublicKey: Buffer | Uint8Array | string
          fingerprint?: string
          requestedScopes?: RemoteScope[]
          claimedAt?: number
        },
    mobileDeviceId?: string,
    mobileStaticPublicKey?: Buffer | Uint8Array | string,
    mobileDeviceName?: string,
    requestedScopes?: RemoteScope[]
  ): ClaimedPeerInfo {
    let pairingId: string
    let devId: string
    let keyBuf: Buffer
    let devName: string | undefined
    let scopes: RemoteScope[] | undefined
    let fp: string | undefined

    function parseKeyBuf(val: Buffer | Uint8Array | string): Buffer {
      if (typeof val === 'string') {
        if (/^[A-Za-z0-9_-]{43}$/.test(val)) {
          return Buffer.from(val, 'base64url')
        }
        return Buffer.from(val, 'base64')
      }
      return Buffer.from(val)
    }

    if (typeof pairingIdOrOpts === 'object') {
      pairingId = pairingIdOrOpts.pairingId || this.currentPending?.pairingId || ''
      devId = pairingIdOrOpts.mobileDeviceId
      keyBuf = parseKeyBuf(pairingIdOrOpts.mobileStaticPublicKey)
      devName = pairingIdOrOpts.mobileDeviceName
      scopes = pairingIdOrOpts.requestedScopes
      fp = pairingIdOrOpts.fingerprint
    } else {
      pairingId = pairingIdOrOpts
      devId = mobileDeviceId!
      keyBuf = parseKeyBuf(mobileStaticPublicKey!)
      devName = mobileDeviceName
      scopes = requestedScopes
    }

    if (!this.currentPending || this.currentPending.pairingId !== pairingId) {
      throw new Error(`Pairing attempt ${pairingId} not found or expired`)
    }
    if (Date.now() > this.currentPending.expiresAt) {
      this.cancelPending('expired')
      throw new Error('Pairing attempt has expired')
    }

    const keyBase64 = keyBuf.toString('base64')
    const fingerprint = fp || computeFingerprint(keyBuf)
    const effectiveScopes = scopes ?? this.currentPending.requestedScopes

    const info: ClaimedPeerInfo = {
      mobileDeviceId: devId,
      mobileDeviceName: devName,
      mobileStaticPublicKey: keyBase64,
      fingerprint,
      requestedScopes: effectiveScopes,
      claimedAt: Date.now()
    }

    this.currentPending.state = 'claimed'
    this.currentPending.claimedPeer = info

    this.emit('pairing:claimed', info, pairingId)
    return info
  }

  /**
   * Approve a pending/claimed pairing locally on the desktop/CLI.
   */
  async approvePairing(
    pairingId: string,
    approvedScopes?: RemoteScope[],
    onActivateWithServer?: (pairingId: string, receiptSignature: string) => Promise<void>
  ): Promise<{ grant: PairingGrant; receipt: string; receiptSignature: string }> {
    if (!this.currentPending || this.currentPending.pairingId !== pairingId) {
      throw new Error(`Pairing attempt ${pairingId} not found or expired`)
    }
    if (Date.now() > this.currentPending.expiresAt) {
      this.cancelPending('expired')
      throw new Error('Pairing attempt has expired')
    }

    const peer = this.currentPending.claimedPeer
    if (!peer) {
      throw new Error('Pairing attempt has not been claimed by a device yet')
    }

    const grantedScopes = approvedScopes ?? peer.requestedScopes
    const signingKeys = this.store.getSigningKeyPair()

    const now = new Date().toISOString()
    const receiptPayload = `${pairingId}:${peer.mobileDeviceId}:${grantedScopes.sort().join(',')}:${now}`
    const signature = signEd25519(receiptPayload, signingKeys.privateKey).toString('base64')

    const grant: PairingGrant = {
      pairingId,
      mobileDeviceId: peer.mobileDeviceId,
      mobileDeviceName: peer.mobileDeviceName,
      mobileStaticPublicKey: peer.mobileStaticPublicKey,
      fingerprint: peer.fingerprint,
      grantedScopes,
      createdAt: now,
      status: 'active',
      receiptSignature: signature
    }

    this.store.savePairing(grant)

    if (onActivateWithServer) {
      try {
        await onActivateWithServer(pairingId, signature)
      } catch (err) {
        // Log error but keep local grant
      }
    }

    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer)
      this.expiryTimer = null
    }
    this.currentPending = null

    this.emit('pairing:approved', grant)
    return { grant, receipt: receiptPayload, receiptSignature: signature }
  }

  /**
   * Explicitly reject a pending/claimed pairing.
   */
  rejectPairing(pairingId: string): void {
    if (this.currentPending?.pairingId === pairingId) {
      this.cancelPending('rejected')
      this.emit('pairing:rejected', pairingId)
    }
  }

  /**
   * Revoke an active pairing locally.
   */
  async revokePairing(
    pairingIdOrDeviceId: string,
    onRevokeWithServer?: (pairingId: string) => Promise<void>
  ): Promise<PairingGrant | null> {
    const revoked = this.store.revokePairing(pairingIdOrDeviceId)
    if (revoked) {
      if (onRevokeWithServer) {
        try {
          await onRevokeWithServer(revoked.pairingId)
        } catch {
          // Ignore server error on local revocation
        }
      }
      this.emit('pairing:revoked', revoked)
    }
    return revoked
  }

  cancelPending(reason: 'expired' | 'rejected' | 'replaced' = 'expired'): void {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer)
      this.expiryTimer = null
    }
    if (this.currentPending) {
      const id = this.currentPending.pairingId
      this.currentPending = null
      if (reason === 'expired') {
        this.emit('pairing:expired', id)
      } else if (reason === 'rejected') {
        this.emit('pairing:rejected', id)
      }
    }
  }
}
