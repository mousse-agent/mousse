/**
 * Local framed duplex MMS client + narrow MmsClient interface.
 */

import { createConnection, type Socket } from 'net'
import { randomBytes } from 'crypto'
import { FrameDecoder, encodeFrame, FrameDecodeError, FrameTooLargeError } from './framing'
import { parseEnvelope } from './validators'
import {
  MMS_PROTOCOL_DEFAULT_REQUEST_TIMEOUT_MS,
  MMS_PROTOCOL_MAX_PENDING_REQUESTS,
  MMS_PROTOCOL_ORCHESTRATOR_SEND_TIMEOUT_MS,
  MMS_PROTOCOL_VERSION,
  type ProtocolClientType,
  type ProtocolEvent,
  type ProtocolHelloOk,
  type ProtocolResponse
} from './types'
import { resolveLocalEndpoint } from './endpoint'

export interface MmsClient {
  connect(): Promise<ProtocolHelloOk>
  close(): Promise<void>
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
  onEvent(handler: (event: ProtocolEvent) => void): () => void
  readonly connected: boolean
  readonly hello: ProtocolHelloOk | null
}

export interface LocalMmsClientOptions {
  homeDir: string
  ownerToken: string
  clientType?: ProtocolClientType
  clientBuild?: string
  /** Override endpoint path (tests). */
  endpoint?: string
  requestTimeoutMs?: number
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: string
}

export class LocalMmsClient implements MmsClient {
  private socket: Socket | null = null
  private decoder = new FrameDecoder()
  private pending = new Map<string, Pending>()
  private eventHandlers = new Set<(event: ProtocolEvent) => void>()
  private _hello: ProtocolHelloOk | null = null
  private _connected = false
  private closing = false
  private lastSequence = 0
  private needsResnapshot = false
  /** Prior connection identity for daemon-restart / sequence-regression detection. */
  private priorConnection: {
    instanceId: string
    protocolVersion: number
    serverBuild?: string
  } | null = null
  /** Buffer live events while a subscribe response is in flight (no-gap ordering). */
  private subscribeInFlight = 0
  private subscribeEventBuffer: ProtocolEvent[] = []

  constructor(private readonly opts: LocalMmsClientOptions) {}

  get connected(): boolean {
    return this._connected
  }

  get hello(): ProtocolHelloOk | null {
    return this._hello
  }

  get requiresResnapshot(): boolean {
    return this.needsResnapshot
  }

  get lastKnownSequence(): number {
    return this.lastSequence
  }

  clearResnapshotFlag(): void {
    this.needsResnapshot = false
  }

  async connect(): Promise<ProtocolHelloOk> {
    if (this._connected && this._hello && this.socket && !this.socket.destroyed) {
      return this._hello
    }

    // Reconnect-safe: clear prior socket/listeners/state before a new attempt.
    this.teardownSocket()
    this.closing = false
    this.decoder.reset()
    this._connected = false
    this._hello = null

    const path =
      this.opts.endpoint ?? resolveLocalEndpoint(this.opts.homeDir).path

    const helloRes = await new Promise<ProtocolHelloOk>((resolve, reject) => {
      const socket = createConnection(path)
      this.socket = socket
      let settled = false

      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          socket.removeAllListeners()
          socket.destroy()
        } catch {
          /* ignore */
        }
        if (this.socket === socket) {
          this.socket = null
        }
        this._hello = null
        this._connected = false
        reject(err)
      }

      const ok = (hello: ProtocolHelloOk): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.removeListener('connect', onConnect)
        socket.removeListener('data', onData)
        socket.removeListener('error', onError)
        socket.removeListener('close', onClose)
        // Install session handlers after hello.
        socket.on('data', (chunk) => this.onData(chunk))
        socket.on('error', (err) => this.onDisconnect(err))
        socket.on('close', () => this.onDisconnect(new Error('Connection closed')))
        resolve(hello)
      }

      const timer = setTimeout(() => fail(new Error('Hello timeout')), 10_000)

      const onConnect = (): void => {
        try {
          socket.write(
            encodeFrame({
              kind: 'hello',
              protocolVersion: MMS_PROTOCOL_VERSION,
              ownerToken: this.opts.ownerToken,
              clientType: this.opts.clientType ?? 'cli',
              clientBuild: this.opts.clientBuild
            })
          )
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)))
        }
      }

      const onData = (chunk: Buffer): void => {
        if (settled) {
          this.onData(chunk)
          return
        }
        try {
          this.decoder.push(chunk)
          const frames = this.decoder.shiftAll()
          let helloFrame: ProtocolHelloOk | null = null
          const afterHello: unknown[] = []
          for (const frame of frames) {
            if (helloFrame) {
              afterHello.push(frame)
              continue
            }
            const env = parseEnvelope(frame)
            if (!env) continue
            if (env.kind === 'hello_ok') {
              helloFrame = env
              continue
            }
            if (env.kind === 'hello_err') {
              fail(new Error(`Hello rejected: ${env.code}: ${env.message}`))
              return
            }
          }
          if (helloFrame) {
            ok(helloFrame)
            // Process every remaining decoded envelope in order after hello_ok.
            for (const frame of afterHello) {
              this.handleEnvelope(frame)
            }
          }
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)))
        }
      }

      const onError = (err: Error): void => {
        fail(err)
      }
      const onClose = (): void => {
        if (!settled) {
          fail(new Error('Connection closed before hello'))
        }
      }

      socket.on('connect', onConnect)
      socket.on('data', onData)
      socket.on('error', onError)
      socket.on('close', onClose)
    })

    this._hello = helloRes
    this._connected = true

    // Compare to prior connection for daemon restart / sequence regression.
    if (this.priorConnection) {
      if (
        helloRes.instanceId !== this.priorConnection.instanceId ||
        helloRes.protocolVersion !== this.priorConnection.protocolVersion ||
        (this.priorConnection.serverBuild !== undefined &&
          helloRes.serverBuild !== undefined &&
          helloRes.serverBuild !== this.priorConnection.serverBuild)
      ) {
        this.needsResnapshot = true
      }
      // Sequence regression against a new ring must not silently accept old afterSequence.
      if (helloRes.globalSequence < this.lastSequence) {
        this.needsResnapshot = true
        this.lastSequence = helloRes.globalSequence
      } else {
        this.lastSequence = Math.max(this.lastSequence, helloRes.globalSequence)
      }
    } else {
      this.lastSequence = helloRes.globalSequence
    }

    this.priorConnection = {
      instanceId: helloRes.instanceId,
      protocolVersion: helloRes.protocolVersion,
      serverBuild: helloRes.serverBuild
    }

    return helloRes
  }

  async close(): Promise<void> {
    this.closing = true
    this.rejectAllPending(new Error('Client closed'))
    this.teardownSocket()
    this._connected = false
    // Keep priorConnection / lastSequence for reconnect identity checks.
  }

  onEvent(handler: (event: ProtocolEvent) => void): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<T> {
    const effectiveTimeoutMs =
      timeoutMs ??
      this.opts.requestTimeoutMs ??
      (method === 'orchestrator.send'
        ? MMS_PROTOCOL_ORCHESTRATOR_SEND_TIMEOUT_MS
        : MMS_PROTOCOL_DEFAULT_REQUEST_TIMEOUT_MS)
    if (!this._connected || !this.socket || this.socket.destroyed) {
      throw new Error('Not connected')
    }
    if (this.pending.size >= MMS_PROTOCOL_MAX_PENDING_REQUESTS) {
      throw new Error('Too many pending requests')
    }
    const id = randomBytes(8).toString('hex')
    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Request timeout: ${method}`))
      }, effectiveTimeoutMs)
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
        method
      })
    })
    try {
      this.write({ kind: 'req', id, method, params })
    } catch (err) {
      // Remove/reject pending immediately — do not wait for timeout.
      // Reject the pending promise (do not also throw) so callers get one rejection.
      const p = this.pending.get(id)
      if (p) {
        clearTimeout(p.timer)
        this.pending.delete(id)
        p.reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    return result
  }

  async subscribe(afterSequence = 0): Promise<{
    sequence: number
    gap: boolean
    replay: ProtocolEvent[]
  }> {
    // Explicit buffered handshake: hold live events until replay is delivered.
    this.subscribeInFlight += 1
    try {
      const result = await this.request<{
        sequence: number
        gap: boolean
        replay: ProtocolEvent[]
      }>('events.subscribe', { afterSequence })

      if (result.gap) this.needsResnapshot = true

      // Deliver replay before any newer live events from the same receive batch.
      const replay = Array.isArray(result.replay) ? result.replay : []
      for (const ev of replay) {
        const parsed = parseEnvelope(ev)
        if (parsed?.kind === 'event') {
          this.deliverEvent(parsed, { fromReplay: true })
        }
      }

      // Never lower lastSequence after a live event; floor at response boundary.
      this.lastSequence = Math.max(this.lastSequence, result.sequence)

      // Flush live events buffered while subscribe was in flight (seq > boundary only).
      const buffered = this.subscribeEventBuffer
      this.subscribeEventBuffer = []
      for (const ev of buffered) {
        if (ev.sequence <= result.sequence) continue
        this.deliverEvent(ev)
      }

      return result
    } finally {
      this.subscribeInFlight = Math.max(0, this.subscribeInFlight - 1)
      if (this.subscribeInFlight === 0 && this.subscribeEventBuffer.length > 0) {
        const leftover = this.subscribeEventBuffer
        this.subscribeEventBuffer = []
        for (const ev of leftover) {
          this.deliverEvent(ev)
        }
      }
    }
  }

  private onData(chunk: Buffer): void {
    try {
      this.decoder.push(chunk)
      for (const frame of this.decoder.shiftAll()) {
        this.handleEnvelope(frame)
      }
    } catch (err) {
      if (err instanceof FrameTooLargeError || err instanceof FrameDecodeError) {
        this.onDisconnect(err)
      } else {
        this.onDisconnect(err instanceof Error ? err : new Error(String(err)))
      }
    }
  }

  private handleEnvelope(raw: unknown): void {
    const env = parseEnvelope(raw)
    if (!env) return
    if (env.kind === 'res') {
      this.handleResponse(env)
      return
    }
    if (env.kind === 'event') {
      if (this.subscribeInFlight > 0) {
        this.subscribeEventBuffer.push(env)
        return
      }
      this.deliverEvent(env)
      return
    }
    if (env.kind === 'error') {
      return
    }
  }

  private handleResponse(env: ProtocolResponse): void {
    const p = this.pending.get(env.id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(env.id)
    if (env.ok) p.resolve(env.result)
    else p.reject(new Error(env.error?.message ?? 'Request failed'))
  }

  private deliverEvent(
    event: ProtocolEvent,
    opts?: { fromReplay?: boolean }
  ): void {
    if (!Number.isFinite(event.sequence) || event.sequence < 0) return

    if (this.lastSequence > 0 && event.sequence > this.lastSequence + 1) {
      this.needsResnapshot = true
    }

    if (event.sequence >= this.lastSequence) {
      this.lastSequence = event.sequence
    } else if (!opts?.fromReplay) {
      // Stale live event after cursor advanced — do not re-deliver or lower cursor.
      return
    }

    for (const h of this.eventHandlers) {
      try {
        h(event)
      } catch {
        /* isolate handlers */
      }
    }
  }

  private write(value: unknown): void {
    if (!this._connected || !this.socket || this.socket.destroyed) {
      throw new Error('Socket not writable')
    }
    this.socket.write(encodeFrame(value))
  }

  private onDisconnect(err: Error): void {
    if (this.closing) {
      this.rejectAllPending(new Error('Client closed'))
      this.teardownSocket()
      this._connected = false
      return
    }
    // Idempotent: only reject pending once when first disconnect is observed.
    if (!this._connected && !this.socket) {
      return
    }
    this._connected = false
    this.rejectAllPending(err)
    this.teardownSocket()
    // Keep priorConnection / lastSequence / needsResnapshot for reconnect decisions.
    this._hello = null
  }

  private teardownSocket(): void {
    if (!this.socket) return
    const s = this.socket
    this.socket = null
    try {
      s.removeAllListeners()
      if (!s.destroyed) s.destroy()
    } catch {
      /* ignore */
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }
}

export function createLocalMmsClient(opts: LocalMmsClientOptions): MmsClient {
  return new LocalMmsClient(opts)
}
