/**
 * MMS Control Service:
 * Daemon-owned service orchestrating Plus authentication, device key management,
 * QR v2 pairing, outbound WebSocket relay, and E2E encrypted remote execution.
 */

import { EventEmitter } from 'node:events'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes, randomUUID } from 'node:crypto'
import { OwnedWorkBarrier } from '../execution/OwnedWorkBarrier'
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
import { authRecord, authRequest, authString } from './auth/authTransport'
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
  NoiseXxPsk0Responder,
  PairingHandshake,
  ReconnectHandshake,
  SecureSession
} from './crypto/noise'
import {
  FRAME_FLAG_CONTROL,
  FRAME_FLAG_FIN,
  FRAME_HEADER_BYTES,
  FRAME_MAGIC,
  decodeFrame,
  encodeFrame
} from './crypto/framing'
import { encodePrologue, type PrologueContext } from './crypto/prologue'
import {
  encodeEnvelopeBytes,
  decodeEnvelopeBytes,
  responseResultEnvelope,
  responseErrorEnvelope
} from './relay/envelopes'
import type { MmsEventBus } from '../events'
import { PROTOCOL_MAJOR } from './constants'
import { signEd25519 } from './crypto/keys'

export interface MmsControlOptions {
  homeDir: string
  instanceId?: string
  eventBus?: MmsEventBus
  executor?: RemoteMethodExecutionHandler
  openExternal?: (url: string) => Promise<void>
  store?: ControlStore
}

interface ActiveRemoteSession {
  pairingId: string
  mobileDeviceId: string
  session: SecureSession
  dispatcher: RemoteSessionDispatcher
  sendCipher?: CipherState
  recvCipher?: CipherState
}

export class MmsControlService extends EventEmitter {
  readonly store: ControlStore
  readonly pairing: PairingManager
  readonly idempotency: IdempotencyStore
  readonly relay: RelayClient

  private desktopAuth: DesktopPkceAuth
  private authGeneration = 0
  private selfHostedAuth?: AbortController
  private headlessAuth: CliHeadlessAuth

  private instanceId: string
  private eventBus?: MmsEventBus
  private executor?: RemoteMethodExecutionHandler
  private openExternalFn?: (url: string) => Promise<void>

  private activeSessions = new Map<string, ActiveRemoteSession>()
  private inFlightHandshakes = new Map<string, PairingHandshake | ReconnectHandshake | NoiseXxPsk0Responder | NoiseIkResponder>()
  private nextMsgIdCounter = 1
  private readonly drainingDispatchers = new Set<RemoteSessionDispatcher>()

  private started = false
  private readonly lifecycle = new OwnedWorkBarrier()
  private readonly executors = new Map<symbol, Promise<unknown>>()
  private readonly executorAls = new AsyncLocalStorage<symbol>()
  private readonly relayWork = new Map<symbol, Promise<unknown>>()
  private readonly relayAls = new AsyncLocalStorage<symbol>()
  private userExecutor?: RemoteMethodExecutionHandler
  private readonly boundExecutor: RemoteMethodExecutionHandler = {
    execute: (method, params) => this.runExecutor(method, params)
  }

  constructor(options: MmsControlOptions) {
    super()
    this.store = options.store || new ControlStore(options.homeDir)
    this.instanceId = options.instanceId || this.store.getDeviceIdentity().mmsDeviceId
    this.eventBus = options.eventBus
    this.userExecutor = options.executor
    this.executor = this.boundExecutor
    this.openExternalFn = options.openExternal

    this.pairing = new PairingManager(this.store)
    this.idempotency = new IdempotencyStore()
    this.relay = new RelayClient(this.store)

    this.desktopAuth = new DesktopPkceAuth(this.store)
    this.headlessAuth = new CliHeadlessAuth(this.store)

    this.wireInternalEvents()
  }

  setExecutor(executor: RemoteMethodExecutionHandler): void {
    this.userExecutor = executor
    this.executor = this.boundExecutor
  }

  getAdmittedExecutor(): RemoteMethodExecutionHandler {
    return this.boundExecutor
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
      void this.acceptRelayMessage(buffer)
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
    this.lifecycle.assertAccepting()
    if (this.started) return
    this.started = true

    const config = this.store.getConfig()
    if (config.autoconnect && this.store.getCredentials()?.deviceEnrollmentToken) {
      this.relay.start()
    }
  }

  async stop(): Promise<void> {
    this.started = false
    this.cancelAuthentication()
    this.pairing.cancelPending()
    this.terminateAllSessions()
    this.relay.stop()
  }

  beginShutdown(): void {
    const already = this.lifecycle.stopping
    this.lifecycle.beginShutdown()
    this.started = false
    if (already) return
    this.cancelAuthentication()
    this.pairing.cancelPending('shutdown')
    this.terminateAllSessions()
    this.relay.stop()
  }

  getActiveCount(): number {
    const dispatchers = new Set(this.drainingDispatchers)
    for (const session of this.activeSessions.values()) dispatchers.add(session.dispatcher)
    let dispatcherActive = 0
    for (const dispatcher of dispatchers) dispatcherActive += dispatcher.getActiveCount()
    return (
      this.lifecycle.count +
      this.executors.size +
      this.relayWork.size +
      dispatcherActive +
      this.relay.getActiveCount()
    )
  }

  async shutdown(options?: { timeoutMs?: number }): Promise<void> {
    this.beginShutdown()
    const timeoutMs = options?.timeoutMs ?? 30_000
    const selfExecutor = this.executorAls.getStore()
    const selfRelay = this.relayAls.getStore()
    const executorWaits = [...this.executors.entries()]
      .filter(([id]) => id !== selfExecutor)
      .map(([, work]) => work)
    const relayWaits = [...this.relayWork.entries()]
      .filter(([id]) => id !== selfRelay)
      .map(([, work]) => work)
    const dispatcherWaits = [...this.drainingDispatchers].map((dispatcher) => dispatcher.waitForIdle())
    const results = await Promise.allSettled([
      this.lifecycle.waitForIdle(timeoutMs),
      this.waitOwned(
        Promise.allSettled([
          ...executorWaits,
          ...relayWaits,
          this.relay.waitForIdle(),
          ...dispatcherWaits
        ]),
        timeoutMs
      )
    ])
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (rejected) throw rejected.reason
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
      enrolled: Boolean(credentials?.deviceEnrollmentToken),
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
    this.lifecycle.assertAccepting()
    this.cancelAuthentication()
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

  private runExecutor(method: string, params: unknown): Promise<unknown> {
    const nested = this.executorAls.getStore()
    const execute = (): Promise<unknown> =>
      Promise.resolve((this.userExecutor ?? { execute: async () => ({ ok: true }) }).execute(method, params))
    if (nested !== undefined) return execute()
    this.lifecycle.assertAccepting()
    const identity = Symbol('executor')
    const work = execute().finally(() => {
      this.executors.delete(identity)
    })
    this.executors.set(identity, work)
    return this.executorAls.run(identity, () => work)
  }

  private waitOwned(work: Promise<unknown>, timeoutMs: number): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(new Error('Invalid shutdown timeout'))
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          Object.assign(new Error('Profile work did not finish before the shutdown deadline'), {
            code: 'profile_busy',
            details: {
              ...this.lifecycle.snapshot(),
              executor: this.executors.size,
              relay: this.relayWork.size + this.relay.getActiveCount()
            }
          })
        )
      }, timeoutMs)
      work.then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        }
      )
    })
  }

  private acceptRelayMessage(buffer: Buffer): Promise<void> {
    if (this.lifecycle.stopping) return Promise.resolve()
    const nested = this.relayAls.getStore()
    const work = this.handleRelayMessage(buffer)
    if (nested !== undefined) return work
    const identity = Symbol('relay')
    const tracked = work.finally(() => {
      this.relayWork.delete(identity)
    })
    this.relayWork.set(identity, tracked)
    return this.relayAls.run(identity, () => tracked)
  }

  // --- Authentication Flows ---

  private cancelAuthentication(): number {
    this.authGeneration += 1
    this.desktopAuth.cancel()
    this.headlessAuth.cancel()
    this.selfHostedAuth?.abort()
    this.selfHostedAuth = undefined
    return this.authGeneration
  }

  /**
   * Start desktop loopback PKCE login.
   */
  async loginDesktop(openExternal?: (url: string) => Promise<void>): Promise<{ ok: boolean; error?: string }> {
    return this.lifecycle.run('login', async () => {
      const generation = this.cancelAuthentication()
      const fn = openExternal || this.openExternalFn
      if (!fn) {
        return { ok: false, error: 'openExternal handler not available' }
      }

      try {
        const res = await this.desktopAuth.startLogin({ openExternal: fn })
        if (generation !== this.authGeneration || this.lifecycle.stopping) {
          return { ok: false, error: 'Login cancelled' }
        }
        if (res.ok) {
          this.relay.start()
          this.emit('control:status_changed', this.getStatus())
        }
        return res
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    })
  }

  /**
   * Start headless CLI login.
   */
  async loginHeadless(
    onPrompt: (info: LoginTransactionInit) => void
  ): Promise<{ ok: boolean; error?: string }> {
    return this.lifecycle.run('login', async () => {
      const generation = this.cancelAuthentication()
      try {
        const res = await this.headlessAuth.startLogin({ onPrompt })
        if (generation !== this.authGeneration || this.lifecycle.stopping) {
          return { ok: false, error: 'Login cancelled' }
        }
        if (res.ok) {
          this.relay.start()
          this.emit('control:status_changed', this.getStatus())
        }
        return res
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    })
  }

  /**
   * Logout from Plus: clears local credentials and closes relay.
   */
  async logout(): Promise<void> {
    this.lifecycle.assertAccepting()
    this.cancelAuthentication()
    this.store.clearCredentials()
    this.terminateAllSessions()
    this.relay.stop()
    this.emit('control:status_changed', this.getStatus())
  }

  /**
   * Self-hosted operator pairing code enrollment.
   */
  async enrollSelfHosted(serverUrl: string, pairingCode: string): Promise<{ ok: boolean; error?: string }> {
    return this.lifecycle.run('login', () => this.enrollSelfHostedOwned(serverUrl, pairingCode))
  }

  private async enrollSelfHostedOwned(serverUrl: string, pairingCode: string): Promise<{ ok: boolean; error?: string }> {
    if (!pairingCode.trim()) {
      return { ok: false, error: 'Pairing code cannot be empty' }
    }

    const generation = this.cancelAuthentication()
    const controller = new AbortController()
    this.selfHostedAuth = controller

    const identity = this.store.getDeviceIdentity()
    const signing = this.store.getSigningKeyPair()

    try {
      const resp = await authRequest(fetch, `${serverUrl.replace(/\/$/, '')}/v1/devices/enroll`, {
          pairing_code: pairingCode.trim(),
          device_id: identity.mmsDeviceId,
          installation_id: identity.installationId,
          public_key: identity.transportPublicKey,
          signing_key: identity.signingPublicKey
      }, controller.signal)

      if (resp.ok) {
        const data = authRecord(await resp.json())
        controller.signal.throwIfAborted()
        if (generation !== this.authGeneration || this.lifecycle.stopping) {
          return { ok: false, error: 'Enrollment cancelled' }
        }
        const creds: PlusAccountCredentials = {
          accountId: 'self-hosted',
          deviceEnrollmentToken: authString(data.device_token, 'device_token')!,
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
    } finally {
      if (this.selfHostedAuth === controller) this.selfHostedAuth = undefined
      controller.abort()
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
    return this.lifecycle.run('pairing', () => this.pairing.createPairingAttempt({
      scopes: options?.scopes,
      ttlMs: options?.ttlMs,
      onRegisterWithServer: async (pairingId, expiresAt) => {
        const config = this.store.getConfig()
        const creds = this.store.getCredentials()
        if (config.mode === 'hosted' && creds?.accessToken && !this.lifecycle.stopping) {
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
              }),
              signal: this.lifecycle.signal
            })
          } catch {
            // Ignore server registration failure; local pairing proceeds
          }
        }
      }
    }))
  }

  listPairings(): PairingGrant[] {
    return this.store.listPairings()
  }

  async approvePairing(
    pairingId: string,
    scopes?: RemoteScope[]
  ): Promise<{ grant: PairingGrant; receipt: string; receiptSignature: string }> {
    return this.lifecycle.run('pairing', () => this.approvePairingOwned(pairingId, scopes))
  }

  private async approvePairingOwned(
    pairingId: string,
    scopes?: RemoteScope[]
  ): Promise<{ grant: PairingGrant; receipt: string; receiptSignature: string }> {
    const config = this.store.getConfig()
    const creds = this.store.getCredentials()

    return this.pairing.approvePairing(
      pairingId,
      scopes,
      async (pId, signature) => {
        if (this.lifecycle.stopping) return
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
              }),
              signal: this.lifecycle.signal
            })
          } catch {
            // Reconciled locally
          }
        }
      }
    )
  }

  rejectPairing(pairingId: string): { ok: boolean } {
    this.lifecycle.assertAccepting()
    this.pairing.rejectPairing(pairingId)
    return { ok: true }
  }

  async revokePairing(pairingIdOrDeviceId: string): Promise<{ ok: boolean; revoked: PairingGrant | null }> {
    return this.lifecycle.run('pairing', () => this.revokePairingOwned(pairingIdOrDeviceId))
  }

  private async revokePairingOwned(
    pairingIdOrDeviceId: string
  ): Promise<{ ok: boolean; revoked: PairingGrant | null }> {
    const config = this.store.getConfig()
    const creds = this.store.getCredentials()

    const revoked = await this.pairing.revokePairing(pairingIdOrDeviceId, async (pId) => {
      if (this.lifecycle.stopping) return
      if (config.mode === 'hosted' && creds?.accessToken) {
        try {
          await fetch(`${config.controlOrigin}/v1/pairings/${pId}/revoke`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${creds.accessToken}` },
            signal: this.lifecycle.signal
          })
        } catch {
          // Ignored
        }
      }
    })
    return { ok: Boolean(revoked), revoked }
  }

  // --- E2E Encrypted Framing & Execution ---

  private async handleRelayMessage(raw: Buffer): Promise<void> {
    if (this.lifecycle.stopping) return
    try {
      // Check if message is a JSON control frame (e.g. legacy handshake initialization or direct message)
      if (raw[0] === 0x7b /* '{' */) {
        this.handleControlJsonMessage(raw.toString('utf-8'))
        return
      }

      // Check for binary relay frame (0x4D50)
      if (raw.length >= FRAME_HEADER_BYTES && raw.readUInt16BE(0) === FRAME_MAGIC) {
        const frame = decodeFrame(raw)

        // Handshake CONTROL frame
        if ((frame.flags & FRAME_FLAG_CONTROL) !== 0) {
          this.handleHandshakeControlFrame(raw, frame.payload)
          return
        }

        // Transport DATA frame
        const session = this.activeSessions.values().next().value as ActiveRemoteSession | undefined
        if (!session) {
          return
        }

        const plaintext = session.session.decrypt(raw)
        const envelope = decodeEnvelopeBytes(plaintext) as ControlEnvelope
        await session.dispatcher.handleEnvelope(envelope)
        return
      }
    } catch (err) {
      this.emit('error', new Error(`Relay message handling error: ${(err as Error).message}`))
    }
  }

  private handleHandshakeControlFrame(raw: Buffer, _payload: Uint8Array): void {
    if (this.lifecycle.stopping) return
    // 1. Check if an in-flight PairingHandshake is waiting for message 3
    for (const [pairingId, inFlight] of this.inFlightHandshakes.entries()) {
      if (inFlight instanceof PairingHandshake) {
        try {
          const msg3Payload = inFlight.read(raw)
          const result = inFlight.finish()
          this.inFlightHandshakes.delete(pairingId)

          let peerMeta = { deviceId: `mobile-${randomUUID()}`, deviceName: 'Mobile Device' }
          if (msg3Payload.byteLength > 0) {
            try {
              peerMeta = { ...peerMeta, ...JSON.parse(Buffer.from(msg3Payload).toString('utf-8')) }
            } catch {
              // fallback
            }
          }

          const claimedInfo = this.pairing.recordClaim(
            pairingId,
            peerMeta.deviceId,
            result.remoteStaticPublicKey,
            peerMeta.deviceName
          )

          this.onPeerClaimedForSession(pairingId, claimedInfo.mobileDeviceId, result.session)
          return
        } catch {
          // Not message 3 for this handshake
        }
      }
    }

    // 2. Check if this is message 1 of a pairing attempt (Noise XXpsk0)
    const pending = this.pairing.getPendingPairing()
    if (pending) {
      try {
        const config = this.store.getConfig()
        const identity = this.store.getDeviceIdentity()
        const transportKey = this.store.getTransportKeyPair()
        const creds = this.store.getCredentials()

        const prologue: PrologueContext = {
          protocolMajor: PROTOCOL_MAJOR,
          protocolMinor: 0,
          installationId: identity.installationId,
          controlOrigin: config.controlOrigin,
          mode: config.mode === 'self-hosted' ? 'self-hosted' : 'hosted',
          accountId: config.mode === 'hosted' ? (creds?.accountId || '') : '',
          mmsDeviceId: identity.mmsDeviceId,
          mobileDeviceId: pending.claimedPeer?.mobileDeviceId || 'mobile',
          pairingId: pending.pairingId,
          initiatorRole: 'mobile',
          responderRole: 'mms'
        }

        const responder = PairingHandshake.responder({
          prologue,
          identity: { keyPair: transportKey },
          pairingSecret: Buffer.from(pending.pairingSecret, 'base64url')
        })

        responder.read(raw)
        const msg2Frame = responder.write(Buffer.from('mms-ok'))
        this.inFlightHandshakes.set(pending.pairingId, responder)
        this.relay.send(Buffer.from(msg2Frame))
        return
      } catch {
        // Not XXpsk0 message 1
      }
    }

    // 3. Check if this is message 1 of reconnect (Noise IK)
    const activePairings = this.store.listPairings().filter((p) => p.status === 'active')
    for (const grant of activePairings) {
      try {
        const config = this.store.getConfig()
        const identity = this.store.getDeviceIdentity()
        const transportKey = this.store.getTransportKeyPair()
        const creds = this.store.getCredentials()

        const prologue: PrologueContext = {
          protocolMajor: PROTOCOL_MAJOR,
          protocolMinor: 0,
          installationId: identity.installationId,
          controlOrigin: config.controlOrigin,
          mode: config.mode === 'self-hosted' ? 'self-hosted' : 'hosted',
          accountId: config.mode === 'hosted' ? (creds?.accountId || '') : '',
          mmsDeviceId: identity.mmsDeviceId,
          mobileDeviceId: grant.mobileDeviceId,
          pairingId: grant.pairingId,
          initiatorRole: 'mobile',
          responderRole: 'mms'
        }

        const responder = ReconnectHandshake.responder({
          prologue,
          identity: { keyPair: transportKey },
          expectedInitiatorStatic: Buffer.from(grant.mobileStaticPublicKey, 'base64')
        })

        responder.read(raw)
        const msg2Frame = responder.write(Buffer.from('mms-ok'))
        this.relay.send(Buffer.from(msg2Frame))

        const result = responder.finish()

        const dispatcher = new RemoteSessionDispatcher({
          grant,
          executor: this.executor || { execute: async () => ({ ok: true }) },
          idempotencyStore: this.idempotency,
          eventBus: this.eventBus,
          instanceId: this.instanceId,
          sendEnvelope: (env) => this.sendSessionEnvelope(grant.pairingId, env)
        })

        this.rememberSession({
          pairingId: grant.pairingId,
          mobileDeviceId: grant.mobileDeviceId,
          session: result.session,
          sendCipher: result.session.send,
          recvCipher: result.session.recv,
          dispatcher
        })
        return
      } catch {
        // Try next grant
      }
    }
  }

  private handleControlJsonMessage(jsonStr: string): void {
    if (this.lifecycle.stopping) return
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
    sessionOrSend: SecureSession | CipherState,
    recvCipherOpt?: CipherState
  ): void {
    // When local user approves, activate session
    const onApproved = (grant: PairingGrant) => {
      if (grant.pairingId !== pairingId) return
      this.pairing.off('pairing:approved', onApproved)

      const session = sessionOrSend instanceof SecureSession
        ? sessionOrSend
        : new SecureSession(
            sessionOrSend,
            recvCipherOpt!,
            new Uint8Array(32),
            Buffer.from(grant.mobileStaticPublicKey, 'base64')
          )

      const dispatcher = new RemoteSessionDispatcher({
        grant,
        executor: this.executor || { execute: async () => ({ ok: true }) },
        idempotencyStore: this.idempotency,
        eventBus: this.eventBus,
        instanceId: this.instanceId,
        sendEnvelope: (env) => this.sendSessionEnvelope(pairingId, env)
      })

      this.rememberSession({
        pairingId,
        mobileDeviceId,
        session,
        sendCipher: session.send,
        recvCipher: session.recv,
        dispatcher
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

    const session = new SecureSession(
      result.sendCipher,
      result.recvCipher,
      new Uint8Array(32),
      peerStaticKey
    )

    const dispatcher = new RemoteSessionDispatcher({
      grant,
      executor: this.executor || { execute: async () => ({ ok: true }) },
      idempotencyStore: this.idempotency,
      eventBus: this.eventBus,
      instanceId: this.instanceId,
      sendEnvelope: (env) => this.sendSessionEnvelope(pairingId, env)
    })

    this.rememberSession({
      pairingId,
      mobileDeviceId: grant.mobileDeviceId,
      session,
      sendCipher: result.sendCipher,
      recvCipher: result.recvCipher,
      dispatcher
    })

    this.sendJsonFrame({
      kind: 'handshake_msg2_ik',
      pairingId,
      msg2: msg2.toString('base64')
    })
  }

  private sendSessionEnvelope(pairingId: string, env: ControlEnvelope): void {
    if (this.lifecycle.stopping) return
    const session = this.activeSessions.get(pairingId)
    if (!session) return

    const plainBytes = encodeEnvelopeBytes(env)
    const frame = session.session.encrypt(plainBytes)
    this.relay.send(Buffer.from(frame))
  }

  private sendJsonFrame(obj: Record<string, unknown>): void {
    if (this.lifecycle.stopping) return
    this.relay.send(Buffer.from(JSON.stringify(obj), 'utf-8'))
  }

  private rememberSession(session: ActiveRemoteSession): void {
    if (this.lifecycle.stopping) {
      session.session.close()
      session.dispatcher.close()
      this.drainingDispatchers.add(session.dispatcher)
      return
    }
    this.activeSessions.set(session.pairingId, session)
  }

  private terminateSession(pairingId: string): void {
    const session = this.activeSessions.get(pairingId)
    if (session) {
      session.session.close()
      session.dispatcher.close()
      this.drainingDispatchers.add(session.dispatcher)
      this.activeSessions.delete(pairingId)
    }
  }

  private terminateAllSessions(): void {
    for (const session of this.activeSessions.values()) {
      session.session.close()
      session.dispatcher.close()
      this.drainingDispatchers.add(session.dispatcher)
    }
    this.activeSessions.clear()
    this.inFlightHandshakes.clear()
  }
}
