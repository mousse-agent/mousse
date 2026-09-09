/**
 * MMS Control Service:
 * Daemon-owned service orchestrating Plus authentication, device key management,
 * QR v2 pairing, outbound WebSocket relay, and E2E encrypted remote execution.
 */

import { EventEmitter } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import type {
  ControlEnvelope,
  ControlMode,
  ControlStatus,
  CreatePairingResult,
  PairingGrant,
  RemoteScope
} from '../../shared/controlTypes'
import { ControlStore, type PlusAccountCredentials } from './storage/controlStore'
import { PairingManager } from './pairing/pairingManager'
import { DesktopPkceAuth } from './auth/desktopPkce'
import { CliHeadlessAuth, type LoginTransactionInit } from './auth/cliHeadless'
import { RelayClient, type RelayConnectionStatus } from './relay/relayClient'
import {
  RemoteSessionDispatcher,
  type RemoteMethodExecutionHandler
} from './relay/remoteDispatcher'
import { IdempotencyStore } from './storage/idempotencyStore'
import {
  buildPrologue,
  CipherState,
  NoiseIkResponder,
  NoiseXxPsk0Responder
} from './crypto/noise'
import { chunkMessage, MessageReassembler, parseChunk } from './crypto/framing'
import type { MmsEventBus } from '../events'
import { PROTOCOL_MAJOR } from './constants'
import { signEd25519 } from './crypto/keys'

export interface MmsControlOptions {
  homeDir: string
  instanceId: string
  eventBus?: MmsEventBus
  executor?: RemoteMethodExecutionHandler
  openExternal?: (url: string) => Promise<void>
}

interface ActiveRemoteSession {
  pairingId: string
  mobileDeviceId: string
  sendCipher: CipherState
  recvCipher: CipherState
  reassembler: MessageReassembler
  dispatcher: RemoteSessionDispatcher
  nextMsgId: number
}

export class MmsControlService extends EventEmitter {
  readonly store: ControlStore
  readonly pairing: PairingManager
  readonly idempotency: IdempotencyStore
  readonly relay: RelayClient

  private desktopAuth: DesktopPkceAuth
  private headlessAuth: CliHeadlessAuth

  private instanceId: string
  private eventBus?: MmsEventBus
  private executor?: RemoteMethodExecutionHandler
  private openExternalFn?: (url: string) => Promise<void>

  private activeSessions = new Map<string, ActiveRemoteSession>()
  private inFlightHandshakes = new Map<string, NoiseXxPsk0Responder | NoiseIkResponder>()
  private nextMsgIdCounter = 1

  private started = false

  constructor(options: MmsControlOptions) {
    super()
    this.instanceId = options.instanceId
    this.eventBus = options.eventBus
    this.executor = options.executor
    this.openExternalFn = options.openExternal

    this.store = new ControlStore(options.homeDir)
    this.pairing = new PairingManager(this.store)
    this.idempotency = new IdempotencyStore()
    this.relay = new RelayClient(this.store)

    this.desktopAuth = new DesktopPkceAuth(this.store)
    this.headlessAuth = new CliHeadlessAuth(this.store)

    this.wireInternalEvents()
  }

  setExecutor(executor: RemoteMethodExecutionHandler): void {
    this.executor = executor
  }

  setOpenExternal(fn: (url: string) => Promise<void>): void {
    this.openExternalFn = fn
  }

  private wireInternalEvents(): void {
    this.pairing.on('pairing:created', (pending) => {
      this.emit('control:status_changed', this.getStatus())
    })

    this.pairing.on('pairing:claimed', (peer, pairingId) => {
      this.emit('control:pairing_request', {
        pairingId,
        mobileDeviceId: peer.mobileDeviceId,
        mobileDeviceName: peer.mobileDeviceName,
        fingerprint: peer.fingerprint,
        requestedScopes: peer.requestedScopes
      })
      this.emit('control:status_changed', this.getStatus())
    })

    this.pairing.on('pairing:approved', (grant) => {
      this.emit('control:status_changed', this.getStatus())
    })

    this.pairing.on('pairing:revoked', (grant) => {
      this.terminateSession(grant.pairingId)
      this.emit('control:status_changed', this.getStatus())
    })

    this.relay.on('connected', () => {
      this.emit('control:status_changed', this.getStatus())
    })

    this.relay.on('disconnected', () => {
      this.emit('control:status_changed', this.getStatus())
    })

    this.relay.on('message', (buffer) => {
      this.handleRelayMessage(buffer)
    })

    this.relay.on('revoked', () => {
      this.terminateAllSessions()
      this.emit('control:status_changed', this.getStatus())
    })

    this.relay.on('error', () => {
      this.emit('control:status_changed', this.getStatus())
    })
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    const config = this.store.getConfig()
    if (config.autoconnect) {
      this.relay.start()
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    this.desktopAuth.cancel()
    this.headlessAuth.cancel()
    this.pairing.cancelPending()
    this.terminateAllSessions()
    this.relay.stop()
  }

  // --- Status & Diagnostics ---

  getStatus(): ControlStatus {
    const config = this.store.getConfig()
    const identity = this.store.getDeviceIdentity()
    const credentials = this.store.getCredentials()
    const pairings = this.store.listPairings()
    const pending = this.pairing.getPendingPairing()

    return {
      mode: config.mode,
      enrolled: Boolean(credentials?.accessToken || credentials?.deviceEnrollmentToken),
      serverUrl: config.controlOrigin,
      dashboardUrl: config.dashboardUrl,
      mmsDeviceId: identity.mmsDeviceId,
      account: credentials
        ? {
            id: credentials.accountId,
            email: credentials.accountEmail,
            name: credentials.accountName
          }
        : undefined,
      relayConnected: this.relay.isConnected(),
      relayConnecting: this.relay.getStatus() === 'connecting' || this.relay.getStatus() === 'reconnecting',
      activePairingsCount: pairings.filter((p) => p.status === 'active').length,
      pendingPairing: pending
        ? {
            pairingId: pending.pairingId,
            expiresAt: pending.expiresAt,
            qrUri: pending.qrUri,
            state: pending.state,
            claimedBy: pending.claimedPeer
              ? {
                  mobileDeviceId: pending.claimedPeer.mobileDeviceId,
                  mobileDeviceName: pending.claimedPeer.mobileDeviceName,
                  fingerprint: pending.claimedPeer.fingerprint,
                  requestedScopes: pending.claimedPeer.requestedScopes
                }
              : undefined
          }
        : undefined,
      pairings
    }
  }

  async setMode(mode: 'hosted' | 'self-hosted'): Promise<{ ok: boolean }> {
    this.store.saveConfig({ mode })
    this.emit('control:status_changed', this.getStatus())
    return { ok: true }
  }

  getPairingManager(): PairingManager {
    return this.pairing
  }

  getStore(): ControlStore {
    return this.store
  }

  getRelayClient(): RelayClient {
    return this.relay
  }

  // --- Authentication Flows ---

  /**
   * Start desktop loopback PKCE login.
   */
  async loginDesktop(openExternal?: (url: string) => Promise<void>): Promise<{ ok: boolean; error?: string }> {
    const fn = openExternal || this.openExternalFn
    if (!fn) {
      return { ok: false, error: 'openExternal handler not available' }
    }

    try {
      const res = await this.desktopAuth.startLogin({ openExternal: fn })
      if (res.ok) {
        this.relay.start()
        this.emit('control:status_changed', this.getStatus())
      }
      return res
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  /**
   * Start headless CLI login.
   */
  async loginHeadless(
    onPrompt: (info: LoginTransactionInit) => void
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await this.headlessAuth.startLogin({ onPrompt })
      if (res.ok) {
        this.relay.start()
        this.emit('control:status_changed', this.getStatus())
      }
      return res
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  /**
   * Logout from Plus: clears local credentials and closes relay.
   */
  async logout(): Promise<void> {
    this.store.clearCredentials()
    this.terminateAllSessions()
    this.relay.stop()
    this.emit('control:status_changed', this.getStatus())
  }

  /**
   * Self-hosted operator pairing code enrollment.
   */
  async enrollSelfHosted(serverUrl: string, pairingCode: string): Promise<{ ok: boolean; error?: string }> {
    if (!pairingCode.trim()) {
      return { ok: false, error: 'Pairing code cannot be empty' }
    }

    const identity = this.store.getDeviceIdentity()
    const signing = this.store.getSigningKeyPair()

    try {
      const resp = await fetch(`${serverUrl}/v1/devices/enroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairing_code: pairingCode.trim(),
          device_id: identity.mmsDeviceId,
          installation_id: identity.installationId,
          public_key: identity.transportPublicKey,
          signing_key: identity.signingPublicKey
        })
      })

      if (resp.ok) {
        const data = (await resp.json()) as { device_token?: string }
        const creds: PlusAccountCredentials = {
          accountId: 'self-hosted',
          deviceEnrollmentToken: data.device_token || `sh-token-${randomUUID()}`,
          updatedAt: new Date().toISOString()
        }
        this.store.saveCredentials(creds)
        this.store.saveConfig({ mode: 'self-hosted', controlOrigin: serverUrl })
        this.relay.start()
        this.emit('control:status_changed', this.getStatus())
        return { ok: true }
      }

      const errData = (await resp.json().catch(() => ({}))) as { message?: string }
      return { ok: false, error: errData.message || `Enrollment failed with status ${resp.status}` }
    } catch (err) {
      return { ok: false, error: `Failed to connect to control server: ${(err as Error).message}` }
    }
  }

  /**
   * Disconnect relay without clearing enrollment credentials.
   */
  async disconnect(): Promise<void> {
    this.relay.stop()
    this.emit('control:status_changed', this.getStatus())
  }

  // --- Pairing Operations ---

  async createPairing(options?: { scopes?: RemoteScope[]; ttlMs?: number }): Promise<CreatePairingResult> {
    return this.pairing.createPairingAttempt({
      scopes: options?.scopes,
      ttlMs: options?.ttlMs,
      onRegisterWithServer: async (pairingId, expiresAt) => {
        const config = this.store.getConfig()
        const creds = this.store.getCredentials()
        if (config.mode === 'hosted' && creds?.accessToken) {
          try {
            await fetch(`${config.controlOrigin}/v1/pairing-attempts`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${creds.accessToken}`
              },
              body: JSON.stringify({
                pairing_id: pairingId,
                expires_at: expiresAt,
                device_id: this.store.getDeviceIdentity().mmsDeviceId
              })
            })
          } catch {
            // Ignore server registration failure; local pairing proceeds
          }
        }
      }
    })
  }

  listPairings(): PairingGrant[] {
    return this.store.listPairings()
  }

  async approvePairing(
    pairingId: string,
    scopes?: RemoteScope[]
  ): Promise<{ grant: PairingGrant; receipt: string; receiptSignature: string }> {
    const config = this.store.getConfig()
    const creds = this.store.getCredentials()

    const result = await this.pairing.approvePairing(
      pairingId,
      scopes,
      async (pId, signature) => {
        if (config.mode === 'hosted' && creds?.accessToken) {
          try {
            await fetch(`${config.controlOrigin}/v1/pairings/activate`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${creds.accessToken}`
              },
              body: JSON.stringify({
                pairing_id: pId,
                receipt_signature: signature
              })
            })
          } catch {
            // Reconciled locally
          }
        }
      }
    )

    return result
  }

  rejectPairing(pairingId: string): { ok: boolean } {
    this.pairing.rejectPairing(pairingId)
    return { ok: true }
  }

  async revokePairing(pairingIdOrDeviceId: string): Promise<{ ok: boolean; revoked: PairingGrant | null }> {
    const config = this.store.getConfig()
    const creds = this.store.getCredentials()

    const revoked = await this.pairing.revokePairing(pairingIdOrDeviceId, async (pId) => {
      if (config.mode === 'hosted' && creds?.accessToken) {
        try {
          await fetch(`${config.controlOrigin}/v1/pairings/${pId}/revoke`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${creds.accessToken}` }
          })
        } catch {
          // Ignored
        }
      }
    })
    return { ok: Boolean(revoked), revoked }
  }

  // --- E2E Encrypted Framing & Execution ---

  private handleRelayMessage(raw: Buffer): void {
    try {
      // Check if message is a JSON control frame (e.g. handshake initialization or direct message)
      if (raw[0] === 0x7b /* '{' */) {
        this.handleControlJsonMessage(raw.toString('utf-8'))
        return
      }

      // Otherwise, binary frame: parse header
      const chunk = parseChunk(raw)

      // Look up active session by msgId or default session
      const session = this.activeSessions.values().next().value as ActiveRemoteSession | undefined
      if (!session) {
        return
      }

      // Decrypt chunk payload
      const decryptedChunk = session.recvCipher.decryptWithAd(Buffer.alloc(0), chunk.payload)
      const completeMessage = session.reassembler.push({
        ...chunk,
        payload: decryptedChunk
      })

      if (completeMessage) {
        const envelope = JSON.parse(completeMessage.toString('utf-8')) as ControlEnvelope
        void session.dispatcher.handleEnvelope(envelope)
      }
    } catch (err) {
      this.emit('error', new Error(`Relay message handling error: ${(err as Error).message}`))
    }
  }

  private handleControlJsonMessage(jsonStr: string): void {
    try {
      const data = JSON.parse(jsonStr) as Record<string, unknown>

      // Mobile initiated Noise XXpsk0 pairing handshake
      if (data.kind === 'handshake_init_xx') {
        this.handleHandshakeInitXx(data)
        return
      }

      // Mobile initiated Noise IK reconnect handshake
      if (data.kind === 'handshake_init_ik') {
        this.handleHandshakeInitIk(data)
        return
      }

      // Handshake message 3 from mobile (finishing XXpsk0)
      if (data.kind === 'handshake_msg3_xx') {
        this.handleHandshakeMsg3Xx(data)
        return
      }
    } catch {
      // Invalid JSON control frame
    }
  }

  private handleHandshakeInitXx(data: Record<string, unknown>): void {
    const pairingId = String(data.pairingId)
    const pending = this.pairing.getPendingPairing()
    if (!pending || pending.pairingId !== pairingId) {
      this.sendJsonFrame({ kind: 'handshake_err', pairingId, message: 'Pairing expired or not found' })
      return
    }

    const msg1 = Buffer.from(String(data.msg1), 'base64')
    const config = this.store.getConfig()
    const identity = this.store.getDeviceIdentity()
    const transportKey = this.store.getTransportKeyPair()
    const creds = this.store.getCredentials()

    const prologue = buildPrologue({
      protocolMajor: PROTOCOL_MAJOR,
      installationId: identity.installationId,
      controlOrigin: config.controlOrigin,
      mode: config.mode,
      accountId: creds?.accountId,
      mmsDeviceId: identity.mmsDeviceId,
      pairingId,
      role: 'responder'
    })

    const responder = new NoiseXxPsk0Responder(
      transportKey,
      Buffer.from(pending.pairingSecret, 'base64url'),
      prologue
    )

    responder.processMessage1(msg1)

    // Create message 2
    const msg2 = responder.createMessage2()
    this.inFlightHandshakes.set(pairingId, responder)

    this.sendJsonFrame({
      kind: 'handshake_msg2_xx',
      pairingId,
      msg2: msg2.toString('base64')
    })
  }

  private handleHandshakeMsg3Xx(data: Record<string, unknown>): void {
    const pairingId = String(data.pairingId)
    const responder = this.inFlightHandshakes.get(pairingId) as NoiseXxPsk0Responder | undefined
    if (!responder) {
      this.sendJsonFrame({ kind: 'handshake_err', pairingId, message: 'Handshake state expired' })
      return
    }

    const msg3 = Buffer.from(String(data.msg3), 'base64')
    const { payload, result } = responder.processMessage3(msg3)
    this.inFlightHandshakes.delete(pairingId)

    // Parse claimed peer metadata from payload
    let peerMeta = { deviceId: `mobile-${randomUUID()}`, deviceName: 'Mobile Device' }
    if (payload.length > 0) {
      try {
        peerMeta = JSON.parse(payload.toString('utf-8'))
      } catch {
        // Fallback
      }
    }

    // Record claim with PairingManager
    const claimedInfo = this.pairing.recordClaim(
      pairingId,
      peerMeta.deviceId,
      result.remoteStaticKey,
      peerMeta.deviceName
    )

    // Store in-flight session waiting for local approval
    this.onPeerClaimedForSession(pairingId, claimedInfo.mobileDeviceId, result.sendCipher, result.recvCipher)
  }

  private onPeerClaimedForSession(
    pairingId: string,
    mobileDeviceId: string,
    sendCipher: CipherState,
    recvCipher: CipherState
  ): void {
    // When local user approves, activate session
    const onApproved = (grant: PairingGrant) => {
      if (grant.pairingId !== pairingId) return
      this.pairing.off('pairing:approved', onApproved)

      const reassembler = new MessageReassembler()
      const dispatcher = new RemoteSessionDispatcher({
        grant,
        executor: this.executor || { execute: async () => ({ ok: true }) },
        idempotencyStore: this.idempotency,
        eventBus: this.eventBus,
        instanceId: this.instanceId,
        sendEnvelope: (env) => this.sendSessionEnvelope(pairingId, env)
      })

      this.activeSessions.set(pairingId, {
        pairingId,
        mobileDeviceId,
        sendCipher,
        recvCipher,
        reassembler,
        dispatcher,
        nextMsgId: 1
      })

      // Send encrypted handshake confirmation / receipt
      this.sendJsonFrame({
        kind: 'handshake_complete',
        pairingId,
        receipt: grant.receiptSignature
      })
    }

    this.pairing.on('pairing:approved', onApproved)
  }

  private handleHandshakeInitIk(data: Record<string, unknown>): void {
    const pairingId = String(data.pairingId)
    const grant = this.store.getPairing(pairingId)
    if (!grant || grant.status !== 'active') {
      this.sendJsonFrame({ kind: 'handshake_err', pairingId, message: 'Pairing revoked or inactive' })
      return
    }

    const msg1 = Buffer.from(String(data.msg1), 'base64')
    const config = this.store.getConfig()
    const identity = this.store.getDeviceIdentity()
    const transportKey = this.store.getTransportKeyPair()
    const creds = this.store.getCredentials()
    const peerStaticKey = Buffer.from(grant.mobileStaticPublicKey, 'base64')

    const prologue = buildPrologue({
      protocolMajor: PROTOCOL_MAJOR,
      installationId: identity.installationId,
      controlOrigin: config.controlOrigin,
      mode: config.mode,
      accountId: creds?.accountId,
      mmsDeviceId: identity.mmsDeviceId,
      pairingId,
      role: 'responder'
    })

    const responder = new NoiseIkResponder(transportKey, peerStaticKey, prologue)
    responder.processMessage1(msg1)

    const { message: msg2, result } = responder.createMessage2()

    const reassembler = new MessageReassembler()
    const dispatcher = new RemoteSessionDispatcher({
      grant,
      executor: this.executor || { execute: async () => ({ ok: true }) },
      idempotencyStore: this.idempotency,
      eventBus: this.eventBus,
      instanceId: this.instanceId,
      sendEnvelope: (env) => this.sendSessionEnvelope(pairingId, env)
    })

    this.activeSessions.set(pairingId, {
      pairingId,
      mobileDeviceId: grant.mobileDeviceId,
      sendCipher: result.sendCipher,
      recvCipher: result.recvCipher,
      reassembler,
      dispatcher,
      nextMsgId: 1
    })

    this.sendJsonFrame({
      kind: 'handshake_msg2_ik',
      pairingId,
      msg2: msg2.toString('base64')
    })
  }

  private sendSessionEnvelope(pairingId: string, env: ControlEnvelope): void {
    const session = this.activeSessions.get(pairingId)
    if (!session) return

    const jsonStr = JSON.stringify(env)
    const plaintext = Buffer.from(jsonStr, 'utf-8')
    const msgId = session.nextMsgId++

    const chunks = chunkMessage(plaintext, msgId)
    for (const chunk of chunks) {
      const header = chunk.subarray(0, 8)
      const payload = chunk.subarray(8)
      const encryptedPayload = session.sendCipher.encryptWithAd(Buffer.alloc(0), payload)
      const encryptedFrame = Buffer.concat([header, encryptedPayload])
      this.relay.send(encryptedFrame)
    }
  }

  private sendJsonFrame(obj: Record<string, unknown>): void {
    this.relay.send(Buffer.from(JSON.stringify(obj), 'utf-8'))
  }

  private terminateSession(pairingId: string): void {
    const session = this.activeSessions.get(pairingId)
    if (session) {
      session.dispatcher.close()
      this.activeSessions.delete(pairingId)
    }
  }

  private terminateAllSessions(): void {
    for (const session of this.activeSessions.values()) {
      session.dispatcher.close()
    }
    this.activeSessions.clear()
    this.inFlightHandshakes.clear()
  }
}
