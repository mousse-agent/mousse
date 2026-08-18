/**
 * Local framed duplex protocol server (named pipe / Unix socket).
 * No Electron imports.
 */

import { createServer, type Server, type Socket } from 'net'
import { chmodSync } from 'fs'
import { randomBytes } from 'crypto'
import type { MousseMainService } from '../MousseMainService'
import { FrameDecoder, encodeFrame, FrameDecodeError, FrameTooLargeError } from './framing'
import { EventSequenceRing } from './eventRing'
import { cleanupStaleUnixSocket, resolveLocalEndpoint, unlinkUnixSocketIfExists } from './endpoint'
import { dispatchMethod } from './handlers'
import { parseEnvelope, validateHello, validateRequest, asAfterSequence, isObject } from './validators'
import {
  MMS_PROTOCOL_MAX_COMPLETED_REQUEST_IDS,
  MMS_PROTOCOL_MAX_OUTBOUND_QUEUED_BYTES,
  MMS_PROTOCOL_MAX_PENDING_REQUESTS,
  MMS_PROTOCOL_VERSION,
  PROTOCOL_CAPABILITIES,
  type ProtocolEvent,
  type ProtocolHelloOk,
  type ProtocolResponse
} from './types'
import type { TurnState } from '../../shared/types'
import { PROCESS_INSTANCE_ID } from '../queue/processLiveness'

export interface ProtocolServerOptions {
  mms: MousseMainService
  ownerToken: string
  version?: string
  build?: string
}

interface ClientSession {
  id: string
  socket: Socket
  decoder: FrameDecoder
  authenticated: boolean
  pending: number
  /** Explicit subscription handshake: buffer live events until response is sent. */
  subscribeState: 'none' | 'buffering' | 'active'
  eventBuffer: ProtocolEvent[]
  lastSeq: number
  closed: boolean
  /**
   * Serializes frame decode + request *admission* (wire order).
   * Independent handlers run concurrently after admission; responses may complete out of order by id.
   */
  chain: Promise<void>
  /**
   * Serializes events.subscribe boundary mutation (buffering/replay/activate) so it stays atomic
   * even while other handlers run concurrently.
   */
  subscribeChain: Promise<void>
  /** In-flight request ids (same frame must not execute twice). */
  inFlightIds: Set<string>
  /** Bounded completed response cache for deterministic duplicate-id handling. */
  completedResponses: Map<string, ProtocolResponse>
  /** True while a drain listener is pending, so we never stack duplicate listeners. */
  awaitingDrain: boolean
}

export class MmsProtocolServer {
  private server: Server | null = null
  private readonly clients = new Map<string, ClientSession>()
  private readonly ring = new EventSequenceRing()
  private readonly disposers: Array<() => void> = []
  private accepting = false
  private endpointPath: string | null = null
  private stopping = false
  private stopped = false
  private readonly instanceId = PROCESS_INSTANCE_ID

  constructor(private readonly opts: ProtocolServerOptions) {}

  get endpoint(): string | null {
    return this.endpointPath
  }

  get globalSequence(): number {
    return this.ring.currentSequence
  }

  async start(): Promise<string> {
    if (this.server) {
      if (!this.endpointPath) throw new Error('Server started without endpoint')
      return this.endpointPath
    }

    const home = this.opts.mms.getHomeDir()
    const { path, platform } = resolveLocalEndpoint(home)
    if (platform === 'unix') {
      // Only remove sockets proven stale; never unlink a live peer's active socket.
      cleanupStaleUnixSocket(home)
    }

    this.stopped = false
    this.stopping = false
    this.wireOrchestratorEvents()
    this.accepting = true

    try {
      await new Promise<void>((resolve, reject) => {
        const server = createServer((socket) => this.onConnection(socket))
        const onError = (err: Error): void => {
          reject(err)
        }
        server.once('error', onError)
        server.listen(path, () => {
          server.off('error', onError)
          // Keep error handler for post-listen failures.
          server.on('error', (err) => {
            // Unexpected post-listen errors: stop accepting new clients.
            this.accepting = false
            void err
          })
          this.server = server
          this.endpointPath = path
          if (platform === 'unix') {
            try {
              chmodSync(path, 0o600)
            } catch {
              /* chmod not supported or racing */
            }
          }
          resolve()
        })
      })
    } catch (err) {
      // Dispose listeners, reset accepting/server; leave endpoint/socket untouched.
      this.accepting = false
      this.disposeOrchestratorEvents()
      this.server = null
      // Do not clear a pre-existing endpoint path we never owned.
      this.endpointPath = null
      throw err
    }

    return this.endpointPath!
  }

  /**
   * Idempotent stop. Shutdown event delivery is best-effort and must not hang
   * waiting for slow clients.
   */
  async stop(): Promise<void> {
    if (this.stopped || this.stopping) return
    this.stopping = true
    this.accepting = false

    // Best-effort shutdown notice — never await drain.
    try {
      const shutdown = this.ring.push('server.shutdown', { reason: 'stop' })
      for (const client of this.clients.values()) {
        this.trySendRaw(client, shutdown)
      }
    } catch {
      /* ignore */
    }

    for (const client of this.clients.values()) {
      this.closeClient(client)
    }
    this.clients.clear()

    this.disposeOrchestratorEvents()

    if (this.server) {
      const server = this.server
      this.server = null
      await new Promise<void>((resolve) => {
        // Bound close wait so a stuck handle cannot hang shutdown forever.
        const timer = setTimeout(() => resolve(), 2_000)
        try {
          server.close(() => {
            clearTimeout(timer)
            resolve()
          })
        } catch {
          clearTimeout(timer)
          resolve()
        }
      })
    }

    if (this.endpointPath && process.platform !== 'win32') {
      unlinkUnixSocketIfExists(this.opts.mms.getHomeDir())
    }
    this.endpointPath = null
    this.stopping = false
    this.stopped = true
  }

  private disposeOrchestratorEvents(): void {
    for (const d of this.disposers) {
      try {
        d()
      } catch {
        /* ignore */
      }
    }
    this.disposers.length = 0
  }

  private wireOrchestratorEvents(): void {
    // Avoid double-wiring if start is retried after partial failure.
    this.disposeOrchestratorEvents()
    const orch = this.opts.mms.orchestrator
    const onOrch = (event: string, handler: (...args: any[]) => void): void => {
      orch.on(event, handler)
      this.disposers.push(() => orch.off(event, handler))
    }
    const onEmitter = (
      target: { on: Function; off: Function },
      event: string,
      handler: (...args: any[]) => void
    ): void => {
      target.on(event, handler)
      this.disposers.push(() => target.off(event, handler))
    }

    const pushThreadsUpdated = (threadId: string): void => {
      this.emitToSubscribers(
        this.ring.push(
          'threads.updated',
          { threads: this.opts.mms.threads.listAllThreads() },
          threadId
        )
      )
    }
    // Some daemon-owned producers (Telegram/Discord/webhooks and scheduled jobs)
    // create threads directly rather than through a protocol request. Fan those
    // creations out through the same sequenced event consumed by the GUI.
    onEmitter(
      this.opts.mms.threads,
      'created',
      (thread: { id: string }) => pushThreadsUpdated(thread.id)
    )
    // First-send and title rename both need a full list push so the sidebar
    // can show/hide and rename without a rescan.
    onOrch('thread-started', (payload: { threadId: string }) => {
      pushThreadsUpdated(payload.threadId)
    })
    onOrch('thread-title-updated', (payload: { threadId: string }) => {
      pushThreadsUpdated(payload.threadId)
    })
    onOrch(
      'thread-title-generation-failed',
      (payload: { threadId: string; error?: string }) => {
        const message = payload?.error ?? 'Title generation failed'
        console.error(`[title] generation failed for ${payload?.threadId}: ${message}`)
        this.emitToSubscribers(
          this.ring.push('thread.title-generation-failed', payload, payload.threadId)
        )
      }
    )

    onOrch('thread-message', (payload: { threadId: string; message: unknown }) => {
      this.emitToSubscribers(
        this.ring.push('thread.message', { message: payload.message }, payload.threadId)
      )
    })

    onOrch('thread-message-updated', (payload: { threadId: string; message: unknown }) => {
      this.emitToSubscribers(
        this.ring.push(
          'thread.message-updated',
          { message: payload.message },
          payload.threadId
        )
      )
    })

    onOrch('thread-messages', (payload: { threadId: string; messages: unknown }) => {
      this.emitToSubscribers(
        this.ring.push('thread.messages', { messages: payload.messages }, payload.threadId)
      )
    })

    onOrch('queue-updated', (payload: { threadId: string; items: unknown }) => {
      this.emitToSubscribers(
        this.ring.push('queue.updated', { items: payload.items }, payload.threadId)
      )
    })

    onOrch('turn-started', (payload: { threadId?: string }) => {
      if (payload.threadId) {
        this.opts.mms.threadRuntimes.setActivity(payload.threadId, 'processing')
      }
      this.emitToSubscribers(this.ring.push('turn.started', payload, payload.threadId))
    })

    onOrch('turn-completed', (payload: { threadId?: string }) => {
      if (payload.threadId) {
        this.opts.mms.threadRuntimes.setActivity(payload.threadId, 'completed')
      }
      this.emitToSubscribers(this.ring.push('turn.completed', payload, payload.threadId))
    })

    onOrch('turn-interrupted', (payload: { threadId?: string }) => {
      if (payload.threadId) {
        this.opts.mms.threadRuntimes.setActivity(payload.threadId, 'idle')
      }
      this.emitToSubscribers(this.ring.push('turn.interrupted', payload, payload.threadId))
    })

    onOrch('turn-aborted', (payload: { threadId?: string }) => {
      if (payload.threadId) {
        this.opts.mms.threadRuntimes.setActivity(payload.threadId, 'idle')
      }
      this.emitToSubscribers(this.ring.push('turn.aborted', payload, payload.threadId))
    })

    onOrch('turn-state', (state: TurnState) => {
      this.emitToSubscribers(this.ring.push('turn.state', state, state.threadId))
    })

    onOrch('turn-steered', (payload: { threadId: string; text: string }) => {
      this.emitToSubscribers(
        this.ring.push('turn.steered', { text: payload.text }, payload.threadId)
      )
    })

    onOrch('connection-failed', (payload: { threadId: string }) => {
      this.opts.mms.threadRuntimes.getOrHydrate(payload.threadId).setConnectionFailed(true)
      this.emitToSubscribers(
        this.ring.push('connection.failed', payload, payload.threadId)
      )
    })

    // Mousse subagent events
    onOrch(
      'mousse-agent-message',
      (payload: { threadId: string; agentId: string; message: unknown }) => {
        this.emitToSubscribers(this.ring.push('mousse-agent.message', payload, payload.threadId))
      }
    )
    onOrch(
      'mousse-agent-message-updated',
      (payload: { threadId: string; agentId: string; message: unknown }) => {
        this.emitToSubscribers(
          this.ring.push('mousse-agent.message-updated', payload, payload.threadId)
        )
      }
    )
    onOrch(
      'mousse-agent-messages-sync',
      (payload: { threadId: string; agentId: string; messages: unknown }) => {
        this.emitToSubscribers(
          this.ring.push('mousse-agent.messages-sync', payload, payload.threadId)
        )
      }
    )
    onOrch(
      'mousse-agent-complete',
      (payload: { threadId: string; agentId: string; summary?: string }) => {
        this.emitToSubscribers(this.ring.push('mousse-agent.complete', payload, payload.threadId))
      }
    )
    onOrch(
      'mousse-agent-connection-failed',
      (payload: { threadId: string; agentId: string }) => {
        this.emitToSubscribers(
          this.ring.push('mousse-agent.connection-failed', payload, payload.threadId)
        )
      }
    )

    // UI capability intents (Electron decides focus/open/notify)
    onOrch('document-opened', (payload: unknown) => {
      this.emitToSubscribers(this.ring.push('ui.document-open', payload, undefined))
    })

    // Questions (daemon-owned)
    const questions = this.opts.mms.questions
    onEmitter(questions, 'pending', (payload: { requestId: string; threadId: string }) => {
      this.opts.mms.threadRuntimes
        .getOrHydrate(payload.threadId)
        .pendingQuestionIds.add(payload.requestId)
      this.opts.mms.orchestrator.setAwaitingInput(payload.threadId)
      this.emitToSubscribers(
        this.ring.push('questions.pending', payload, payload.threadId)
      )
    })
    onEmitter(
      questions,
      'cleared',
      (payload: { requestId: string; threadId: string }) => {
        this.opts.mms.threadRuntimes
          .getOrHydrate(payload.threadId)
          .pendingQuestionIds.delete(payload.requestId)
        this.emitToSubscribers(
          this.ring.push('questions.cleared', payload, payload.threadId)
        )
      }
    )

    // PTY streaming with per-PTY sequence
    const pty = this.opts.mms.ptyManager
    onEmitter(
      pty,
      'data',
      (payload: {
        ptyId: string
        data: string
        sequence: number
        threadId: string
        agentId: string
      }) => {
        this.emitToSubscribers(
          this.ring.push('pty.data', payload, payload.threadId)
        )
      }
    )
    onEmitter(
      pty,
      'exit',
      (payload: { ptyId: string; agentId: string; threadId: string }) => {
        this.emitToSubscribers(this.ring.push('pty.exit', payload, payload.threadId))
      }
    )
    onEmitter(
      pty,
      'created',
      (payload: { ptyId: string; agentId: string; threadId: string }) => {
        this.emitToSubscribers(this.ring.push('pty.created', payload, payload.threadId))
      }
    )
    onEmitter(pty, 'focus-intent', () => {
      this.emitToSubscribers(this.ring.push('ui.focus-intent', {}, undefined))
    })

    // Activity + agent/task registry fan-out from multi-tenant runtimes
    const runtimes = this.opts.mms.threadRuntimes
    onEmitter(
      runtimes,
      'activity',
      (payload: {
        threadId: string
        state: string
        activity?: Record<string, string>
      }) => {
        this.emitToSubscribers(this.ring.push('activity', payload, payload.threadId))
        if (payload.activity) {
          this.emitToSubscribers(
            this.ring.push('activity.snapshot', { activity: payload.activity }, undefined)
          )
        }
      }
    )
    onEmitter(
      runtimes,
      'agents.updated',
      (payload: { threadId: string; agents: unknown }) => {
        this.emitToSubscribers(
          this.ring.push('agents.updated', payload, payload.threadId)
        )
      }
    )
    onEmitter(
      runtimes,
      'tasks.updated',
      (payload: { threadId: string; tasks: unknown }) => {
        this.emitToSubscribers(
          this.ring.push('tasks.updated', payload, payload.threadId)
        )
      }
    )

    // Orchestrator agent lifecycle → sequenced protocol events
    onOrch(
      'agent-spawned',
      (payload: { agent?: unknown; threadId?: string } | { id?: string }) => {
        const threadId =
          (payload as { threadId?: string }).threadId ??
          this.opts.mms.orchestrator.getBoundThreadId() ??
          undefined
        const agent =
          (payload as { agent?: unknown }).agent !== undefined
            ? (payload as { agent: unknown }).agent
            : payload
        this.emitToSubscribers(
          this.ring.push('agent.spawned', { agent, threadId }, threadId)
        )
      }
    )
    onOrch(
      'agent-activated',
      (payload: { agentId: string; threadId?: string }) => {
        const threadId =
          payload.threadId ?? this.opts.mms.orchestrator.getBoundThreadId() ?? undefined
        this.emitToSubscribers(
          this.ring.push('agent.activated', payload, threadId)
        )
      }
    )
    onOrch(
      'terminal-activated',
      (payload: { ptyId: string; threadId?: string }) => {
        const threadId =
          payload.threadId ?? this.opts.mms.orchestrator.getBoundThreadId() ?? undefined
        this.emitToSubscribers(
          this.ring.push('terminal.activated', payload, threadId)
        )
      }
    )

    // Scheduler / channels (daemon-owned)
    onEmitter(this.opts.mms.scheduled, 'updated', (jobs: unknown) => {
      this.emitToSubscribers(this.ring.push('scheduled.updated', { jobs }, undefined))
    })
    onEmitter(this.opts.mms.scheduled, 'status', (status: unknown) => {
      this.emitToSubscribers(this.ring.push('scheduled.status', { status }, undefined))
    })
    onEmitter(this.opts.mms.channels, 'updated', (snapshot: unknown) => {
      this.emitToSubscribers(this.ring.push('channels.updated', { snapshot }, undefined))
    })
    onEmitter(this.opts.mms.channels, 'activity', (event: unknown) => {
      this.emitToSubscribers(this.ring.push('channels.activity', { event }, undefined))
    })
  }

  private onConnection(socket: Socket): void {
    if (!this.accepting || this.stopping || this.stopped) {
      socket.destroy()
      return
    }
    const session: ClientSession = {
      id: randomBytes(8).toString('hex'),
      socket,
      decoder: new FrameDecoder(),
      authenticated: false,
      pending: 0,
      subscribeState: 'none',
      eventBuffer: [],
      lastSeq: 0,
      closed: false,
      chain: Promise.resolve(),
      subscribeChain: Promise.resolve(),
      inFlightIds: new Set(),
      completedResponses: new Map(),
      awaitingDrain: false
    }
    this.clients.set(session.id, session)

    // Serialize decode + admission only. Disconnect cancels remaining chain work.
    socket.on('data', (chunk) => {
      session.chain = session.chain
        .then(() => this.onData(session, chunk))
        .catch(() => {
          /* errors handled inside onData / closeClient */
        })
    })
    socket.on('error', () => this.closeClient(session))
    socket.on('close', () => this.closeClient(session))
  }

  private async onData(session: ClientSession, chunk: Buffer): Promise<void> {
    if (session.closed) return
    try {
      session.decoder.push(chunk)
      for (const frame of session.decoder.shiftAll()) {
        if (session.closed) return
        // Admit in wire order; independent handlers continue concurrently after admission.
        await this.admitFrame(session, frame)
      }
    } catch (err) {
      if (session.closed) return
      if (err instanceof FrameTooLargeError || err instanceof FrameDecodeError) {
        this.trySendRaw(session, {
          kind: 'error',
          code: err.name,
          message: err.message
        })
      }
      this.closeClient(session)
    }
  }

  /**
   * Admit one frame in stream order:
   * - Hello is synchronous
   * - Request admission (duplicate id / pending cap) is synchronous
   * - events.subscribe boundary mutation is awaited (serialized atomic)
   * - Other handlers start concurrently; responses complete out-of-order by id
   */
  private async admitFrame(session: ClientSession, raw: unknown): Promise<void> {
    if (session.closed) return

    if (!session.authenticated) {
      const v = validateHello(raw)
      if (!v.ok) {
        this.trySendRaw(session, { kind: 'hello_err', code: v.code, message: v.message })
        this.closeClient(session)
        return
      }
      if (v.hello.ownerToken !== this.opts.ownerToken) {
        this.trySendRaw(session, {
          kind: 'hello_err',
          code: 'auth',
          message: 'Invalid owner fencing token'
        })
        this.closeClient(session)
        return
      }
      session.authenticated = true
      const ok: ProtocolHelloOk = {
        kind: 'hello_ok',
        protocolVersion: MMS_PROTOCOL_VERSION,
        serverVersion: this.opts.version,
        serverBuild: this.opts.build,
        instanceId: this.instanceId,
        capabilities: [...PROTOCOL_CAPABILITIES],
        globalSequence: this.ring.currentSequence
      }
      this.sendRaw(session, ok)
      return
    }

    const env = parseEnvelope(raw)
    if (!env) {
      this.sendRaw(session, {
        kind: 'error',
        code: 'invalid_envelope',
        message: 'Invalid envelope'
      })
      return
    }

    if (env.kind !== 'req') {
      this.sendRaw(session, {
        kind: 'error',
        code: 'unexpected',
        message: `Unexpected kind after auth: ${env.kind}`
      })
      return
    }

    const v = validateRequest(env)
    if (!v.ok) {
      this.sendRaw(session, {
        kind: 'res',
        id: typeof (env as { id?: string }).id === 'string' ? (env as { id: string }).id : 'unknown',
        ok: false,
        error: { code: v.code, message: v.message }
      })
      return
    }

    // Deterministic duplicate-id handling: replay completed, reject in-flight.
    const cached = session.completedResponses.get(v.req.id)
    if (cached) {
      this.sendRaw(session, cached)
      return
    }
    if (session.inFlightIds.has(v.req.id)) {
      const dup: ProtocolResponse = {
        kind: 'res',
        id: v.req.id,
        ok: false,
        error: {
          code: 'duplicate_request',
          message: 'Request id is already in flight'
        }
      }
      this.sendRaw(session, dup)
      return
    }

    if (session.pending >= MMS_PROTOCOL_MAX_PENDING_REQUESTS) {
      const res: ProtocolResponse = {
        kind: 'res',
        id: v.req.id,
        ok: false,
        error: { code: 'backpressure', message: 'Too many pending requests' }
      }
      this.sendRaw(session, res)
      this.cacheCompleted(session, res)
      return
    }

    // Admitted — count against backpressure before execution starts.
    session.pending += 1
    session.inFlightIds.add(v.req.id)

    if (v.req.method === 'events.subscribe') {
      // Atomic subscribe boundary: serialize against other subscribe mutations on this client.
      const run = session.subscribeChain.then(() => {
        if (session.closed) return
        let response: ProtocolResponse | null = null
        try {
          response = this.handleSubscribe(session, v.req.id, v.req.params)
        } catch (err) {
          if (session.closed) return
          const message = err instanceof Error ? err.message : String(err)
          response = {
            kind: 'res',
            id: v.req.id,
            ok: false,
            error: { code: 'handler_error', message }
          }
          this.sendRaw(session, response)
        } finally {
          session.inFlightIds.delete(v.req.id)
          session.pending = Math.max(0, session.pending - 1)
          if (response && !session.closed) {
            this.cacheCompleted(session, response)
          }
        }
      })
      session.subscribeChain = run.catch(() => {})
      // Await so admission of subsequent frames cannot interleave with boundary mutation.
      await run
      return
    }

    // Independent handlers: fire concurrently; do not block admission of later frames.
    void this.executeAdmittedRequest(session, v.req.id, v.req.method, v.req.params)
  }

  private async executeAdmittedRequest(
    session: ClientSession,
    reqId: string,
    method: string,
    params: unknown
  ): Promise<void> {
    let response: ProtocolResponse | null = null
    try {
      // All methods including daemon.shutdown go through dispatch (shared stop-request write).
      // Response is sent before service stop polling closes this server.
      const result = await dispatchMethod(
        {
          mms: this.opts.mms,
          ownerToken: this.opts.ownerToken,
          globalSequence: () => this.ring.currentSequence,
          emitEvent: (type, data, threadId) => {
            this.emitToSubscribers(this.ring.push(type, data, threadId))
          }
        },
        method,
        params
      )
      if (session.closed) return
      response = { kind: 'res', id: reqId, ok: true, result }
      this.sendRaw(session, response)
    } catch (err) {
      if (session.closed) return
      const message = err instanceof Error ? err.message : String(err)
      response = {
        kind: 'res',
        id: reqId,
        ok: false,
        error: { code: 'handler_error', message }
      }
      this.sendRaw(session, response)
    } finally {
      session.inFlightIds.delete(reqId)
      session.pending = Math.max(0, session.pending - 1)
      if (response && !session.closed) {
        this.cacheCompleted(session, response)
      }
    }
  }

  /**
   * Subscribe handshake with no-gap ordering:
   * 1. Enter buffering so live events during the boundary are held.
   * 2. Capture sequence boundary + ring replay.
   * 3. Send response (replay in body).
   * 4. Activate subscription and flush buffered live events with seq > boundary.
   */
  private handleSubscribe(
    session: ClientSession,
    reqId: string,
    params: unknown
  ): ProtocolResponse {
    const p = isObject(params) ? params : {}
    let after = 0
    try {
      after = asAfterSequence(p.afterSequence)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const res: ProtocolResponse = {
        kind: 'res',
        id: reqId,
        ok: false,
        error: { code: 'invalid_params', message }
      }
      this.sendRaw(session, res)
      return res
    }

    session.subscribeState = 'buffering'
    session.eventBuffer = []

    const currentSeq = this.ring.currentSequence
    const replay = this.ring.replayAfter(after)
    const res: ProtocolResponse = {
      kind: 'res',
      id: reqId,
      ok: true,
      result: {
        sequence: currentSeq,
        gap: replay.gap,
        replay: replay.events
      }
    }
    this.sendRaw(session, res)

    session.subscribeState = 'active'
    session.lastSeq = currentSeq

    // Flush events that landed during buffering with sequence after the boundary.
    const buffered = session.eventBuffer
    session.eventBuffer = []
    for (const ev of buffered) {
      if (session.closed) break
      if (ev.sequence <= currentSeq) continue
      this.deliverEventToClient(session, ev)
    }

    return res
  }

  private cacheCompleted(session: ClientSession, res: ProtocolResponse): void {
    session.completedResponses.set(res.id, res)
    while (session.completedResponses.size > MMS_PROTOCOL_MAX_COMPLETED_REQUEST_IDS) {
      const first = session.completedResponses.keys().next().value
      if (first === undefined) break
      session.completedResponses.delete(first)
    }
  }

  private emitToSubscribers(event: ProtocolEvent): void {
    this.broadcastEvent(event)
  }

  private broadcastEvent(event: ProtocolEvent): void {
    for (const client of this.clients.values()) {
      if (!client.authenticated || client.closed) continue
      if (client.subscribeState === 'buffering') {
        client.eventBuffer.push(event)
        continue
      }
      if (client.subscribeState !== 'active') continue
      this.deliverEventToClient(client, event)
    }
  }

  private deliverEventToClient(session: ClientSession, event: ProtocolEvent): void {
    if (!this.sendRaw(session, event)) return
    session.lastSeq = event.sequence
  }

  /**
   * Write a frame. Returns false if the client was closed (including slow-client
   * disconnect under outbound backpressure). Does not block on drain.
   */
  private sendRaw(session: ClientSession, value: unknown): boolean {
    return this.writeFrame(session, value, true)
  }

  /** Best-effort write that never disconnects solely for backpressure (shutdown path). */
  private trySendRaw(session: ClientSession, value: unknown): void {
    this.writeFrame(session, value, false)
  }

  private writeFrame(
    session: ClientSession,
    value: unknown,
    enforceBackpressure: boolean
  ): boolean {
    if (session.closed || session.socket.destroyed) return false
    try {
      const frame = encodeFrame(value)
      const queued = typeof session.socket.writableLength === 'number'
        ? session.socket.writableLength
        : 0
      if (
        enforceBackpressure &&
        session.authenticated &&
        queued + frame.length > MMS_PROTOCOL_MAX_OUTBOUND_QUEUED_BYTES
      ) {
        // Slow authenticated client — disconnect without affecting MMS.
        this.closeClient(session)
        return false
      }
      const ok = session.socket.write(frame)
      if (!ok && !session.awaitingDrain) {
        session.awaitingDrain = true
        session.socket.pause()
        session.socket.once('drain', () => {
          session.awaitingDrain = false
          if (!session.closed) session.socket.resume()
        })
      }
      // Post-write backlog check (writableLength may update after write returns false).
      const after = typeof session.socket.writableLength === 'number'
        ? session.socket.writableLength
        : 0
      if (
        enforceBackpressure &&
        session.authenticated &&
        after > MMS_PROTOCOL_MAX_OUTBOUND_QUEUED_BYTES
      ) {
        this.closeClient(session)
        return false
      }
      return true
    } catch {
      this.closeClient(session)
      return false
    }
  }

  private closeClient(session: ClientSession): void {
    if (session.closed) return
    session.closed = true
    session.subscribeState = 'none'
    session.eventBuffer = []
    session.inFlightIds.clear()
    session.completedResponses.clear()
    this.clients.delete(session.id)
    try {
      session.socket.removeAllListeners('data')
      session.socket.destroy()
    } catch {
      /* ignore */
    }
  }
}
