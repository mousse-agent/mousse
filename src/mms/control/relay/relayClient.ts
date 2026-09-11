/**
 * Outbound WebSocket Relay Client for MMS daemon.
 * Connects outbound to Control Server over WSS / port 443.
 * Aligned with docs/WIRE_PROTOCOL.md §5.
 *
 * Implements:
 * - GET /v1/relay (no query params, no tokens in URL)
 * - First-message authenticated admission within 5s
 * - Monotonic heartbeat every 20s (marks offline after 60s)
 * - Route authorization lease renewal every 60s
 * - Outbound queue limit (2 MiB max)
 * - Exponential backoff with jitter (1s - 30s)
 */

import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { ControlStore } from '../storage/controlStore'
import {
  AUTH_DEADLINE_MS,
  AUTHORIZATION_LEASE_MS,
  HEARTBEAT_INTERVAL_MS,
  MAX_OUTBOUND_QUEUED_BYTES,
  OFFLINE_AFTER_MS,
  PROTOCOL_MAJOR,
  RECONNECT_BACKOFF_MAX_MS,
  RECONNECT_BACKOFF_MIN_MS
} from '../constants'
import type {
  AdmissionCredential,
  RelayAuthFailMessage,
  RelayAuthMessage,
  RelayAuthOkMessage
} from '../../../shared/controlTypes'

export interface RelayClientEvents {
  connected: () => void
  disconnected: (reason?: string) => void
  error: (err: Error) => void
  message: (data: Buffer) => void
  revoked: () => void
}

export type RelayConnectionStatus = 'disconnected' | 'connecting' | 'authenticated' | 'reconnecting'

export interface RelayClientOptions {
  admissionProvider?: () => Promise<AdmissionCredential>
  admission?: AdmissionCredential
}

export function buildRelayAuthMessage(input: {
  admission: AdmissionCredential
  connectorEpoch?: number
  challengeResponse?: string
  protocolMinor?: number
}): RelayAuthMessage {
  return {
    type: 'auth',
    admission: input.admission,
    ...(input.connectorEpoch !== undefined ? { connectorEpoch: input.connectorEpoch } : {}),
    ...(input.challengeResponse !== undefined ? { challengeResponse: input.challengeResponse } : {}),
    protocolMajor: PROTOCOL_MAJOR,
    ...(input.protocolMinor !== undefined ? { protocolMinor: input.protocolMinor } : {})
  }
}

export class RelayClient extends EventEmitter {
  private store: ControlStore
  private options?: RelayClientOptions
  private ws: WebSocket | null = null
  private status: RelayConnectionStatus = 'disconnected'
  private stopped = true

  private heartbeatTimer: NodeJS.Timeout | null = null
  private leaseTimer: NodeJS.Timeout | null = null
  private authTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null

  private lastSeenAt = 0
  private reconnectAttempts = 0
  private queuedBytes = 0
  private epoch = 1
  private readonly inflight = new Set<Promise<unknown>>()
  private readonly closingSockets = new Map<WebSocket, { promise: Promise<void>; resolve: () => void }>()

  constructor(store: ControlStore, options?: RelayClientOptions) {
    super()
    this.store = store
    this.options = options
  }

  getStatus(): RelayConnectionStatus {
    return this.status
  }

  isConnected(): boolean {
    return this.status === 'authenticated'
  }

  setAdmission(admission: AdmissionCredential): void {
    if (!this.options) this.options = {}
    this.options.admission = admission
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.reconnectAttempts = 0
    this.connect()
  }

  stop(): void {
    const alreadyStopped = this.stopped
    this.stopped = true
    this.cleanupTimers()
    const ws = this.ws
    this.ws = null
    if (ws) this.beginSocketClose(ws)
    this.status = 'disconnected'
    if (!alreadyStopped) this.emit('disconnected', 'Client stopped')
  }

  getActiveCount(): number {
    return this.inflight.size + this.closingSockets.size
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([
      ...this.inflight,
      ...[...this.closingSockets.values()].map(({ promise }) => promise)
    ])
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inflight.add(work)
    return work.finally(() => {
      this.inflight.delete(work)
    })
  }

  private connect(): void {
    if (this.stopped) return

    this.cleanupTimers()
    const config = this.store.getConfig()

    const wsUrl = this.resolveWsUrl(config.controlOrigin)
    this.status = this.reconnectAttempts === 0 ? 'connecting' : 'reconnecting'

    try {
      const ws = new WebSocket(wsUrl)
      this.ws = ws
      this.lastSeenAt = Date.now()

      // Enforce 5s auth deadline
      this.authTimer = setTimeout(() => {
        if (this.status !== 'authenticated') {
          this.handleSocketClose(ws, 'Authentication deadline exceeded')
        }
      }, AUTH_DEADLINE_MS)

      ws.onopen = () => {
        void this.track(this.handleSocketOpen(ws))
      }

      ws.onmessage = (event) => {
        this.handleSocketMessage(ws, event.data)
      }

      ws.onclose = (event) => {
        this.settleSocketClose(ws)
        this.handleSocketClose(ws, `Socket closed (code ${event.code}: ${event.reason || 'no reason'})`)
      }

      ws.onerror = (err) => {
        if (this.listenerCount('error') > 0) {
          this.emit('error', new Error(`WebSocket error: ${String(err)}`))
        }
      }
    } catch (err) {
      this.handleSocketClose(undefined, `Failed to create WebSocket: ${(err as Error).message}`)
    }
  }

  private resolveWsUrl(origin: string): string {
    const url = new URL(origin)
    const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    // WIRE_PROTOCOL.md §5.1: Client opens GET /v1/relay WebSocket. No tokens or role in URL query!
    return `${protocol}//${url.host}/v1/relay`
  }

  private async handleSocketOpen(ws: WebSocket): Promise<void> {
    if (this.ws !== ws || this.stopped) return

    try {
      let admission = this.options?.admission
      if (!admission && this.options?.admissionProvider) {
        admission = await this.options.admissionProvider()
      }
      if (this.stopped || this.ws !== ws) return

      if (!admission) {
        // Build admission only from a server-issued enrollment credential.
        const identity = this.store.getDeviceIdentity()
        const creds = this.store.getCredentials()
        if (!creds?.deviceEnrollmentToken) {
          throw new Error('Device is not enrolled with the control server')
        }
        const nonce = randomBytes(16).toString('hex')
        admission = {
          admissionId: nonce,
          installationId: identity.installationId,
          deviceId: identity.mmsDeviceId,
          pairingId: 'default',
          role: 'mms',
          nonce,
          expiresAt: Date.now() + 30_000,
          protocolMajor: 2,
          token: creds.deviceEnrollmentToken
        }
      }

      const authMsg = buildRelayAuthMessage({
        admission,
        connectorEpoch: this.epoch
      })

      if (this.stopped || this.ws !== ws) return
      ws.send(JSON.stringify(authMsg))
    } catch (err) {
      if (this.stopped) return
      this.handleSocketClose(ws, `Failed to send auth: ${(err as Error).message}`)
    }
  }

  private handleSocketMessage(ws: WebSocket, data: unknown): void {
    if (this.ws !== ws || this.stopped) return
    this.lastSeenAt = Date.now()

    if (typeof data === 'string') {
      try {
        const json = JSON.parse(data) as Record<string, unknown>
        if (json.type === 'authOk') {
          const authOk = json as unknown as RelayAuthOkMessage
          if (this.authTimer) {
            clearTimeout(this.authTimer)
            this.authTimer = null
          }
          this.status = 'authenticated'
          this.reconnectAttempts = 0
          if (typeof authOk.epoch === 'number') {
            this.epoch = authOk.epoch
          }
          this.startHeartbeat()
          this.startLeaseRenewal()
          this.emit('connected')
          return
        }

        if (json.type === 'authFail') {
          const authFail = json as unknown as RelayAuthFailMessage
          this.emit('revoked')
          this.handleSocketClose(ws, `Auth failed: ${authFail.code} - ${authFail.message}`)
          return
        }

        if (json.type === 'ping') {
          if (this.ws && this.status === 'authenticated') {
            this.ws.send(JSON.stringify({ type: 'pong' }))
          }
          return
        }

        if (json.type === 'pong') {
          return
        }
      } catch {
        // Fall through to binary message processing
      }
    }

    let buffer: Buffer
    if (typeof data === 'string') {
      buffer = Buffer.from(data, 'utf-8')
    } else if (data instanceof ArrayBuffer) {
      buffer = Buffer.from(data)
    } else if (Buffer.isBuffer(data)) {
      buffer = data
    } else {
      return
    }

    if (this.status === 'authenticated') {
      this.emit('message', buffer)
    }
  }

  send(data: Buffer | Uint8Array): boolean {
    if (this.status !== 'authenticated' || !this.ws) {
      return false
    }

    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (this.queuedBytes + payload.length > MAX_OUTBOUND_QUEUED_BYTES) {
      if (this.listenerCount('error') > 0) {
        this.emit('error', new Error('Outbound queue limit exceeded, dropping frame'))
      }
      return false
    }

    try {
      this.ws.send(payload)
      return true
    } catch (err) {
      if (this.listenerCount('error') > 0) {
        this.emit('error', new Error(`Send error: ${(err as Error).message}`))
      }
      return false
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      if (this.status !== 'authenticated' || !this.ws) return

      const elapsed = Date.now() - this.lastSeenAt
      if (elapsed > OFFLINE_AFTER_MS) {
        this.handleSocketClose(this.ws, `Proof of life expired (${elapsed}ms without message)`)
        return
      }

      try {
        this.ws.send(JSON.stringify({ type: 'ping' }))
      } catch {
        // Handled on close/error
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  private startLeaseRenewal(): void {
    if (this.leaseTimer) clearInterval(this.leaseTimer)
    this.leaseTimer = setInterval(() => {
      if (this.status !== 'authenticated' || this.stopped) return
      void this.track(this.renewAuthorizationLease())
    }, AUTHORIZATION_LEASE_MS)
  }

  private async renewAuthorizationLease(): Promise<void> {
    if (this.stopped) return
    const config = this.store.getConfig()
    const creds = this.store.getCredentials()

    if (config.mode !== 'hosted' || !creds?.accessToken) {
      return
    }

    try {
      const resp = await fetch(`${config.controlOrigin}/v1/me`, {
        headers: { Authorization: `Bearer ${creds.accessToken}` }
      })
      if (resp.status === 401 || resp.status === 403) {
        this.emit('revoked')
        this.handleSocketClose(this.ws, 'Hosted authorization lease revoked or expired')
      }
    } catch {
      // Temporary network failure during check
    }
  }

  private handleSocketClose(ws: WebSocket | null | undefined, reason: string): void {
    if (ws && this.ws !== ws) return
    this.cleanupTimers()
    const current = this.ws
    this.ws = null
    if (current) this.beginSocketClose(current)

    this.status = 'disconnected'
    this.emit('disconnected', reason)

    if (!this.stopped) {
      this.scheduleReconnect()
    }
  }

  private beginSocketClose(ws: WebSocket): void {
    if (this.closingSockets.has(ws)) return
    let resolve!: () => void
    const promise = new Promise<void>((done) => { resolve = done })
    this.closingSockets.set(ws, { promise, resolve })
    if (ws.readyState === WebSocket.CLOSED) {
      this.settleSocketClose(ws)
      return
    }
    try {
      ws.close()
    } catch {
      // A synchronous close failure means no close event can be awaited.
      this.settleSocketClose(ws)
    }
  }

  private settleSocketClose(ws: WebSocket): void {
    const closing = this.closingSockets.get(ws)
    if (!closing) return
    this.closingSockets.delete(ws)
    closing.resolve()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return

    this.reconnectAttempts++
    const exp = Math.min(
      RECONNECT_BACKOFF_MIN_MS * Math.pow(1.5, Math.min(this.reconnectAttempts, 8)),
      RECONNECT_BACKOFF_MAX_MS
    )
    const jitter = Math.random() * 1000
    const delay = Math.round(exp + jitter)

    this.status = 'reconnecting'
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private cleanupTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.leaseTimer) {
      clearInterval(this.leaseTimer)
      this.leaseTimer = null
    }
    if (this.authTimer) {
      clearTimeout(this.authTimer)
      this.authTimer = null
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}
