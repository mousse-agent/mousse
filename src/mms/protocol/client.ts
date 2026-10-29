import { ERROR_INFO_CAPABILITY, parseErrorInfo, type ErrorInfo } from '../../shared/errors'
/**
 * Local framed duplex MMS client + narrow MmsClient interface.
 */

import { createConnection, type Socket } from 'net'
import { randomBytes } from 'crypto'
import { EnvelopeAssembler } from './envelopeChunks'
import { FrameDecoder, encodeFrame, FrameDecodeError, FrameTooLargeError } from './framing'
import { parseEnvelope } from './validators'
import {
  GIT_OPERATIONS_CAPABILITY,
  MMS_PROTOCOL_CHUNK_CAPABILITY,
  MMS_PROTOCOL_DEFAULT_REQUEST_TIMEOUT_MS,
  MMS_PROTOCOL_GIT_OPERATION_TIMEOUT_MS,
  MMS_PROTOCOL_LOGIN_TIMEOUT_MS,
  MMS_PROTOCOL_MAX_OUTBOUND_QUEUED_BYTES,
  MMS_PROTOCOL_MAX_PENDING_REQUESTS,
  MMS_PROTOCOL_ORCHESTRATOR_SEND_TIMEOUT_MS,
  MMS_PROTOCOL_VERSION,
  type ProtocolClientType,
  type ProtocolEvent,
  type ProtocolConnectionEvent,
  type ProtocolHelloOk,
  type ProtocolResponse
} from './types'
import { resolveLocalEndpoint } from './endpoint'
import {
  ClientCommandReceiver,
  type AttachedBrowserCommandHandler
} from './connectionCommands'

export interface MmsClient {
  connect(): Promise<ProtocolHelloOk>
  close(): Promise<void>
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
  onEvent(handler: (event: ProtocolEvent, delivery?: { replay: boolean }) => void): () => void
  readonly connected: boolean
  readonly hello: ProtocolHelloOk | null
}

/** Git methods that change the repository and may run hooks or talk to a remote. */
const GIT_MUTATION_METHODS: ReadonlySet<string> = new Set([
  'git.checkout', 'git.commit', 'git.push', 'git.stage', 'git.unstage', 'git.discard', 'git.fetch', 'git.pull',
  'git.abortInProgress', 'git.createBranch', 'git.renameBranch', 'git.deleteBranch', 'git.init'
])

/** The service refused the hello; `code` says why (`protocol_version`: it speaks another protocol). */
export class ProtocolHelloError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`Hello rejected: ${code}: ${detail}`)
    this.name = 'ProtocolHelloError'
  }
}

/** Whether `error` is a hello the service refused because it speaks another protocol version. */
export function isProtocolVersionMismatch(error: unknown): boolean {
  return error instanceof ProtocolHelloError && error.code === 'protocol_version'
}

/**
 * How long a request may stay open when neither the call nor the client sets a timeout.
 * A client's blanket `requestTimeoutMs` still outranks this, and an explicit `timeoutMs` outranks both.
 */
export function requestTimeoutFor(method: string): number {
  if (method === 'orchestrator.send' || method === 'bridge.hub.send') return MMS_PROTOCOL_ORCHESTRATOR_SEND_TIMEOUT_MS
  if (method === 'mcp.beginAuth' || method === 'mcp.authenticate') return MMS_PROTOCOL_LOGIN_TIMEOUT_MS
  // Fetches the pull request's head from the network and builds a worktree.
  if (GIT_MUTATION_METHODS.has(method) || method === 'pullRequests.startThread') return MMS_PROTOCOL_GIT_OPERATION_TIMEOUT_MS
  return MMS_PROTOCOL_DEFAULT_REQUEST_TIMEOUT_MS
}

/** The capability a daemon must have advertised for a connection event type to be believed. */
function connectionEventCapability(type: ProtocolConnectionEvent['type']): string {
  if (type === 'mcp.auth-url') return 'integrations.lifecycle.v1'
  return type === 'git.operation' ? GIT_OPERATIONS_CAPABILITY : 'net.v1'
}

/** The message of an overload refusal, from this client's own limit or the service's. */
export const PENDING_REQUESTS_FULL_MESSAGE = 'Too many pending requests'

/**
 * Waits before each retry of a request that was refused because too many requests were in flight.
 * The refusal comes before the request runs (the service turned it away on arrival, or too many were
 * already waiting here), so retrying is safe for every method. About 1.5 s in total; a longer overload
 * fails. Below that, a call past this client's in-flight limit waits for a slot instead.
 */
export const OVERLOAD_RETRY_DELAYS_MS: readonly number[] = [50, 150, 400, 900]

/**
 * How many requests may wait for a free slot once `MMS_PROTOCOL_MAX_PENDING_REQUESTS` are in flight.
 * A request past this is refused with the overload error; one that waits keeps its own timeout.
 */
export const MMS_CLIENT_MAX_WAITING_REQUESTS = 1_024

/**
 * Reads that only return state (a lookup may restore a retired worktree, which is the same work twice).
 * With `shareIdenticalReads`, a call while the same method with the same params is in flight gets that
 * request's answer instead of sending another. Opening a thread asks several of these more than once at
 * the same moment (`files.root` three times, `projects.list` and `settings.get` from several views),
 * and each switch to another thread asks again while the earlier answers are still on their way. Any
 * other method ends sharing for the reads already in flight, so a read after a change is a new request.
 */
export const SHARED_READ_METHODS: ReadonlySet<string> = new Set([
  'actions.list',
  'agentDefinitions.list',
  'bridge.editorAsks',
  'browser.access.status',
  'capabilities',
  'chats.snapshot',
  'files.root',
  'git.branches',
  'git.diffStats',
  'git.log',
  'git.status',
  'integrations.snapshot',
  'net.status',
  'orchestrator.contextUsage',
  'orchestrator.isTurnActive',
  'profiles.list',
  'profiles.status',
  'projects.list',
  'providers.snapshots',
  'pullRequests.get',
  'queue.list',
  'settings.get',
  'settings.getOptions',
  'skills.list',
  'storage.policy',
  'subagents.list',
  'thread.snapshot',
  'threads.approvalRules',
  'threads.get',
  'threads.list',
  'workflows.list',
  'workspace.getStatus'
])

/** Calls that change nothing a read returns, so they leave shared reads in flight (a long wait, the event cursor). */
const SHARING_NEUTRAL_METHODS: ReadonlySet<string> = new Set(['events.subscribe', 'speech.host.wait'])

/**
 * Whether `error` is an overload refusal: too many requests in flight on the connection, from
 * this client's limit or the service's `backpressure` reply.
 */
export function isPendingRequestLimitError(error: unknown): boolean {
  return error instanceof MmsProtocolError && error.code === 'backpressure' && error.message === PENDING_REQUESTS_FULL_MESSAGE
}

/** Structured daemon rejection preserved across every local client caller. */
export class MmsProtocolError extends Error {
  readonly code: string
  readonly details?: unknown
  readonly errorInfo?: ErrorInfo

  constructor(code: string, message: string, details?: unknown, errorInfo?: ErrorInfo) {
    super(message)
    this.name = 'MmsProtocolError'
    this.code = code
    this.details = details
    this.errorInfo = parseErrorInfo(errorInfo)
    // Electron's structured clone only carries enumerable own properties for
    // custom Error fields on some supported versions.
    Object.defineProperty(this, 'code', { value: code, enumerable: true, writable: false })
    if (details !== undefined) {
      Object.defineProperty(this, 'details', { value: details, enumerable: true, writable: false })
    }
  }
}

export interface LocalMmsClientOptions {
  homeDir: string
  ownerToken: string
  clientType?: ProtocolClientType
  clientBuild?: string
  requestedCapabilities?: string[]
  /** Override endpoint path (tests). */
  endpoint?: string
  requestTimeoutMs?: number
  /** Identical concurrent calls of a `SHARED_READ_METHODS` method share one request (GUI windows). */
  shareIdenticalReads?: boolean
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: string
}

/** A request waiting for a free slot; `send` takes the slot and writes it at once. */
interface SlotWaiter {
  send: () => void
  fail: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** The key two calls must share to be answered by one request; null when the params cannot be compared. */
function sharedReadKey(method: string, params: unknown, timeoutMs: number | undefined): string | null {
  if (!SHARED_READ_METHODS.has(method)) return null
  try {
    return `${method}\u0000${timeoutMs ?? ''}\u0000${JSON.stringify(params ?? null)}`
  } catch {
    return null
  }
}

export class LocalMmsClient implements MmsClient {
  private socket: Socket | null = null
  private decoder = new FrameDecoder()
  private assembler = new EnvelopeAssembler(() => this.onDisconnect(new FrameDecodeError('Envelope transfer timed out')))
  private pending = new Map<string, Pending>()
  /** Requests waiting, in call order, for one of the in-flight slots. */
  private slotWaiters: SlotWaiter[] = []
  /** In-flight shared reads by `sharedReadKey`. */
  private sharedReads = new Map<string, Promise<unknown>>()
  private eventHandlers = new Set<(event: ProtocolEvent, delivery?: { replay: boolean }) => void>()
  private connectionEventHandlers = new Set<(event: ProtocolConnectionEvent) => void>()
  private connectionClosedHandlers = new Set<(error: Error) => void>()
  private readonly commands = new ClientCommandReceiver()
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

  /** A resnapshot that was started failed; the next event asks for one again. */
  markResnapshotNeeded(): void {
    this.needsResnapshot = true
  }

  async connect(): Promise<ProtocolHelloOk> {
    if (this._connected && this._hello && this.socket && !this.socket.destroyed) {
      return this._hello
    }

    // Reconnect-safe: clear prior socket/listeners/state before a new attempt.
    this.commands.unbindWriter()
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
        // Install session handlers after hello. Command writer must be live
        // before residual same-chunk frames are processed.
        this._connected = true
        this._hello = hello
        this.commands.bindWriter((envelope) => {
          try {
            this.write(envelope, MMS_PROTOCOL_MAX_OUTBOUND_QUEUED_BYTES)
          } catch (error) {
            this.onDisconnect(error instanceof Error ? error : new Error(String(error)))
          }
        })
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
              clientBuild: this.opts.clientBuild,
              requestedCapabilities: [...new Set([...(this.opts.requestedCapabilities ?? [ERROR_INFO_CAPABILITY]), MMS_PROTOCOL_CHUNK_CAPABILITY])]
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
              fail(new ProtocolHelloError(env.code, env.message))
              return
            }
          }
          if (helloFrame) {
            ok(helloFrame)
            // Process every remaining decoded envelope in order after hello_ok.
            for (const frame of afterHello) {
              if (!this._connected) break
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
    const wasConnected = this._connected
    this.closing = true
    this.commands.unbindWriter()
    this.rejectAllPending(new Error('Client closed'))
    this.teardownSocket()
    this._connected = false
    if (wasConnected) this.notifyConnectionClosed(new Error('Client closed'))
    // Keep priorConnection / lastSequence for reconnect identity checks.
  }

  /**
   * Electron-main-only reverse-command handler. CLI/base clients must not
   * install one; absence rejects `server_req` without dispatch.
   */
  setAttachedBrowserCommandHandler(handler: AttachedBrowserCommandHandler | null): void {
    this.commands.setHandler(handler)
  }

  beginCommandShutdown(): void {
    this.commands.beginShutdown()
  }

  getActiveCommandCount(): number {
    return this.commands.getActiveCount()
  }

  awaitCommandShutdown(timeoutMs?: number): Promise<void> {
    return this.commands.shutdown(timeoutMs)
  }

  onEvent(handler: (event: ProtocolEvent, delivery?: { replay: boolean }) => void): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  onConnectionEvent(handler: (event: ProtocolConnectionEvent) => void): () => void {
    this.connectionEventHandlers.add(handler)
    return () => this.connectionEventHandlers.delete(handler)
  }

  onConnectionClosed(handler: (error: Error) => void): () => void {
    this.connectionClosedHandlers.add(handler)
    return () => this.connectionClosedHandlers.delete(handler)
  }

  private notifyConnectionClosed(error: Error): void {
    for (const handler of this.connectionClosedHandlers) {
      try {
        handler(error)
      } catch {
        /* isolate lifecycle consumers */
      }
    }
  }

  /**
   * Sends a request. Past the in-flight limit it waits for a free slot; a refused one (the service's
   * overload reply, or too many waiting here) is retried quietly with backoff. With
   * `shareIdenticalReads`, an identical read already in flight answers this call too.
   */
  async request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<T> {
    const key = this.opts.shareIdenticalReads ? sharedReadKey(method, params, timeoutMs) : null
    if (key === null) {
      // Any other call may change state (a profile binding changes what every read returns): a read
      // asked after it is sent must not take the answer of one asked before it.
      if (!SHARED_READ_METHODS.has(method) && !SHARING_NEUTRAL_METHODS.has(method)) this.sharedReads.clear()
      return this.requestWithRetry<T>(method, params, timeoutMs)
    }
    const inFlight = this.sharedReads.get(key)
    // Each later caller gets its own copy, so one caller changing its answer cannot change another's.
    if (inFlight) return inFlight.then((value) => structuredClone(value) as T)
    const request = this.requestWithRetry<T>(method, params, timeoutMs)
    this.sharedReads.set(key, request)
    const forget = (): void => {
      if (this.sharedReads.get(key) === request) this.sharedReads.delete(key)
    }
    request.then(forget, forget)
    return request
  }

  /** Requests waiting for a free slot (tests and diagnostics). */
  get waitingRequestCount(): number {
    return this.slotWaiters.length
  }

  private async requestWithRetry<T>(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestOnce<T>(method, params, timeoutMs)
      } catch (error) {
        const delay = OVERLOAD_RETRY_DELAYS_MS[attempt]
        if (delay === undefined || !isPendingRequestLimitError(error) || this.closing) throw error
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  private async requestOnce<T>(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<T> {
    const effectiveTimeoutMs = timeoutMs ?? this.opts.requestTimeoutMs ?? requestTimeoutFor(method)
    if (!this._connected || !this.socket || this.socket.destroyed) {
      throw new Error('Not connected')
    }
    // Earlier waiters go first, so a free slot never lets a later call overtake them.
    const full = this.pending.size >= MMS_PROTOCOL_MAX_PENDING_REQUESTS || this.slotWaiters.length > 0
    if (full && this.slotWaiters.length >= MMS_CLIENT_MAX_WAITING_REQUESTS) {
      throw new MmsProtocolError('backpressure', PENDING_REQUESTS_FULL_MESSAGE, undefined, { category: 'unavailable', retryable: true })
    }
    const calledAt = Date.now()
    return new Promise<T>((resolve, reject) => {
      // Takes a slot and writes the request in one step; the timeout counts from the call, waiting included.
      const send = (): void => {
        if (!this._connected || !this.socket || this.socket.destroyed) {
          reject(new Error('Not connected'))
          return
        }
        const id = randomBytes(8).toString('hex')
        const timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`Request timeout: ${method}`))
          this.admitWaiters()
        }, Math.max(1, effectiveTimeoutMs - (Date.now() - calledAt)))
        this.pending.set(id, {
          resolve: (v) => resolve(v as T),
          reject,
          timer,
          method
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
      }
      if (!full) {
        send()
        return
      }
      const waiter: SlotWaiter = {
        send,
        fail: reject,
        timer: setTimeout(() => {
          const index = this.slotWaiters.indexOf(waiter)
          if (index >= 0) this.slotWaiters.splice(index, 1)
          reject(new Error(`Request timeout: ${method}`))
        }, effectiveTimeoutMs)
      }
      this.slotWaiters.push(waiter)
    })
  }

  /** Sends waiting requests, oldest first, into the slots that are free. */
  private admitWaiters(): void {
    while (this.pending.size < MMS_PROTOCOL_MAX_PENDING_REQUESTS && this.slotWaiters.length > 0) {
      const waiter = this.slotWaiters.shift()!
      clearTimeout(waiter.timer)
      waiter.send()
    }
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
        if (!this._connected) break
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
    let env = parseEnvelope(raw)
    if (env?.kind === 'envelope_chunk') {
      if (!this._hello?.capabilities.includes(MMS_PROTOCOL_CHUNK_CAPABILITY)) throw new FrameDecodeError('Unnegotiated envelope chunk')
      const complete = this.assembler.accept(env)
      if (complete === null) return
      env = parseEnvelope(complete)
      if (!env || !['res', 'event'].includes(env.kind)) throw new FrameDecodeError('Invalid assembled envelope')
    } else if (this.assembler.active) {
      throw new FrameDecodeError('Interrupted envelope transfer')
    }
    if (!env) {
      if (raw && typeof raw === 'object' && (raw as { kind?: unknown }).kind === 'envelope_chunk') throw new FrameDecodeError('Malformed envelope chunk')
      this.commands.rejectMalformed(raw)
      return
    }
    if (env.kind === 'server_req') {
      this.commands.handleServerRequest(env)
      return
    }
    if (env.kind === 'connection_event') {
      if (!this._hello?.capabilities.includes(connectionEventCapability(env.type))) return
      for (const handler of this.connectionEventHandlers) {
        try {
          handler(env)
        } catch {
          /* isolate display consumers */
        }
      }
      return
    }
    if (env.kind === 'server_cancel') {
      this.commands.handleCancel(env)
      return
    }
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
      if (env.code === 'event_too_large') {
        this.needsResnapshot = true
        this.onDisconnect(new MmsProtocolError(env.code, env.message, undefined, { category: 'unsupported', retryable: false }))
      }
      return
    }
  }

  private handleResponse(env: ProtocolResponse): void {
    const p = this.pending.get(env.id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(env.id)
    this.admitWaiters()
    if (env.ok) p.resolve(env.result)
    else {
      const error = env.error
      p.reject(new MmsProtocolError(
        error?.code ?? 'request_failed',
        error?.message ?? 'Request failed',
        error?.details,
        error?.errorInfo
      ))
    }
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
        h(event, { replay: opts?.fromReplay === true })
      } catch {
        /* isolate handlers */
      }
    }
  }

  private write(value: unknown, maxQueuedBytes?: number): void {
    if (!this._connected || !this.socket || this.socket.destroyed) {
      throw new Error('Socket not writable')
    }
    const frame = encodeFrame(value)
    if (maxQueuedBytes !== undefined && this.socket.writableLength + frame.length > maxQueuedBytes) {
      throw new Error('Command response outbound backlog exceeded')
    }
    this.socket.write(frame)
    if (maxQueuedBytes !== undefined && this.socket.writableLength > maxQueuedBytes) {
      throw new Error('Command response outbound backlog exceeded')
    }
  }

  private onDisconnect(err: Error): void {
    const wasConnected = this._connected
    this.commands.unbindWriter()
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
    if (wasConnected) this.notifyConnectionClosed(err)
    this.rejectAllPending(err)
    this.teardownSocket()
    // Keep priorConnection / lastSequence / needsResnapshot for reconnect decisions.
    this._hello = null
  }

  private teardownSocket(): void {
    this.assembler.reset()
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
    const waiters = this.slotWaiters
    this.slotWaiters = []
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.fail(err)
    }
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
