import { AgentDefinitionError } from '../../shared/agents/errors'
import { ERROR_INFO_CAPABILITY, errorDiagnostic, knownAppError, normalizeAppError, serializeAppError } from '../../shared/errors'
/**
 * Local framed duplex protocol server (named pipe / Unix socket).
 * No Electron imports.
 */

import { createServer, type Server, type Socket } from 'net'
import { chmodSync } from 'fs'
import { randomBytes, timingSafeEqual } from 'crypto'
import type { MousseMainService } from '../MousseMainService'
import type { MmsProfileServices } from '../MmsProfileServices'
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
  type ProtocolClientType,
  type ProtocolHelloOk,
  type ProtocolResponse
} from './types'
import type { TurnState } from '../../shared/types'
import { PROCESS_INSTANCE_ID } from '../queue/processLiveness'
import { DomainRpcError, type TrustedProfileBinding } from './domainRegistry'
import { PROFILES_V1_CAPABILITY } from '../../shared/profiles/types'
import { BROWSER_ATTACHED_V1_CAPABILITY } from '../../shared/browser/connectionCommands'
import { ProfileError } from '../../shared/profiles/errors'
import type { ConnectionCommandRouter } from './connectionCommands'
import { NET_LOCAL_CAPABILITY } from '../../shared/net/local'
import { writeConnectionEventFrame } from './connectionEventWriter'
import { MMS_PROTOCOL_MAX_CONNECTION_EVENT_BYTES } from './types'


export interface ProtocolServerOptions {
  mms: MousseMainService
  ownerToken: string
  version?: string
  build?: string
  /**
   * Optional reverse-command router. Root injects this and later composes it
   * with the attached browser backend. Absence means browser-attached-v1 is
   * neither advertised nor granted.
   */
  commandRouter?: ConnectionCommandRouter
}

/** Constant-time comparison so hello auth cannot be probed via timing. */
export function ownerTokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf-8')
  const b = Buffer.from(expected, 'utf-8')
  if (a.length !== b.length) {
    // Still burn a comparison to keep the fast path indistinguishable.
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

interface ClientSession {
  id: string
  socket: Socket
  decoder: FrameDecoder
  authenticated: boolean
  clientType?: ProtocolClientType
  pending: number
  binding?: TrustedProfileBinding
  capabilities: Set<string>
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
  /** Serializes trusted profile-binding mutations in wire order. */
  bindingChain: Promise<void>
  /** In-flight request ids (same frame must not execute twice). */
  inFlightIds: Set<string>
  /** Bounded completed response cache for deterministic duplicate-id handling. */
  completedResponses: Map<string, ProtocolResponse>
  /** True while a drain listener is pending, so we never stack duplicate listeners. */
  awaitingDrain: boolean
  connectionEventChain: Promise<void>
  connectionEventPending: number
  connectionEventLifetime: AbortController
}

export class MmsProtocolServer {
  private server: Server | null = null
  private readonly clients = new Map<string, ClientSession>()
  /**
   * Event cursors are scoped to the profile audience. A single installation-wide
   * cursor would expose another profile's activity as sequence gaps and force
   * otherwise healthy clients to resnapshot.
   */
  private readonly audienceRings = new Map<string, EventSequenceRing>()
  private readonly ring = new EventSequenceRing()
  private readonly profileEventDisposers = new Map<string, Array<() => void>>()
  private profileLifecycleUnsubscribe: (() => void) | null = null
  private catalogChangedUnsubscribe: (() => void) | null = null
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
    return this.ringFor(this.opts.mms.profileId).currentSequence
  }

  private ringFor(profileId: string): EventSequenceRing {
    let ring = this.audienceRings.get(profileId)
    if (!ring) {
      ring = new EventSequenceRing()
      this.audienceRings.set(profileId, ring)
    }
    return ring
  }

  async start(): Promise<string> {
    this.opts.mms.domains?.seal()
    if (this.server) {
      if (!this.endpointPath) throw new Error('Server started without endpoint')
      return this.endpointPath
    }

    const home = this.opts.mms.getHomeDir()
    const { path, platform } = resolveLocalEndpoint(home)
    if (platform === 'unix') {
      // Only remove sockets proven stale; never unlink a live peer's active socket.
      await cleanupStaleUnixSocket(home, this.opts.ownerToken)
    }

    this.stopped = false
    this.stopping = false
    this.wireOrchestratorEvents(this.opts.mms)
    const host = this.opts.mms.getInstallationHost()
    if (host) {
      for (const record of host.manager.list()) {
        const services = host.getLive(record.id)
        if (services) this.wireOrchestratorEvents(services)
      }
      this.profileLifecycleUnsubscribe = this.opts.mms.domains?.onProfileDisposed((profileId) => {
        this.opts.commandRouter?.revokeProfile(profileId)
        for (const client of this.clients.values()) {
          if (client.binding?.profileId === profileId) client.connectionEventLifetime.abort()
        }
        this.disposeProfileEvents(profileId)
      }) ?? null
    }
    // Catalogs refresh in the background after startup; push results to every client.
    this.catalogChangedUnsubscribe?.()
    this.catalogChangedUnsubscribe = this.opts.mms.providerAuth?.onCatalogChanged?.(() => {
      if (this.stopping || this.stopped) return
      const providers = this.opts.mms.providerAuth.getConfiguredProviders()
      this.emitToSubscribers(this.ring.push('providers.changed', { providers }), null)
    }) ?? null
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
    this.profileLifecycleUnsubscribe?.()
    this.profileLifecycleUnsubscribe = null
    this.catalogChangedUnsubscribe?.()
    this.catalogChangedUnsubscribe = null
    for (const profileId of [...this.profileEventDisposers.keys()]) {
      this.disposeProfileEvents(profileId)
    }
  }

  private disposeProfileEvents(profileId: string): void {
    const disposers = this.profileEventDisposers.get(profileId)
    if (!disposers) return
    this.profileEventDisposers.delete(profileId)
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
  }

  private wireLiveProfileEvents(): void {
    const host = this.opts.mms.getInstallationHost()
    if (!host) return
    for (const record of host.manager.list()) {
      const services = host.getLive(record.id)
      if (services) this.wireOrchestratorEvents(services)
    }
  }

  private wireOrchestratorEvents(services: MmsProfileServices): void {
    if (this.profileEventDisposers.has(services.profileId)) return
    const disposers: Array<() => void> = []
    this.profileEventDisposers.set(services.profileId, disposers)
    const emitToSubscribers = (event: ProtocolEvent): void => {
      this.emitToSubscribers(event, services.profileId)
    }
    const orch = services.orchestrator
    const onOrch = (event: string, handler: (...args: any[]) => void): void => {
      orch.on(event, handler)
      disposers.push(() => orch.off(event, handler))
    }
    const onEmitter = (
      target: { on: Function; off: Function },
      event: string,
      handler: (...args: any[]) => void
    ): void => {
      target.on(event, handler)
      disposers.push(() => target.off(event, handler))
    }

    const pushThreadsUpdated = (threadId: string): void => {
      emitToSubscribers(
        this.ring.push(
          'threads.updated',
          { threads: services.threads.listAllThreads() },
          threadId
        )
      )
    }
    onEmitter(services.events, 'net:updated', (status: import('../../shared/net').NetStatus) => {
      emitToSubscribers(this.ring.push('net.updated', status))
    })
    // Some daemon-owned producers (Telegram/Discord/webhooks and scheduled jobs)
    // create threads directly rather than through a protocol request. Fan those
    // creations out through the same sequenced event consumed by the GUI.
    onEmitter(
      services.threads,
      'created',
      (thread: { id: string }) => pushThreadsUpdated(thread.id)
    )
    onEmitter(
      services.threads,
      'updated',
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
        emitToSubscribers(
          this.ring.push('thread.title-generation-failed', payload, payload.threadId)
        )
      }
    )

    onOrch('thread-message', (payload: { threadId: string; message: unknown }) => {
      emitToSubscribers(
        this.ring.push('thread.message', { message: payload.message }, payload.threadId)
      )
    })

    onOrch('thread-message-updated', (payload: { threadId: string; message: unknown }) => {
      emitToSubscribers(
        this.ring.push(
          'thread.message-updated',
          { message: payload.message },
          payload.threadId
        )
      )
    })

    onOrch('thread-messages', (payload: { threadId: string; messages: unknown; replace?: boolean }) => {
      emitToSubscribers(
        this.ring.push('thread.messages', { messages: payload.messages, ...(payload.replace ? { replace: true } : {}) }, payload.threadId)
      )
    })

    onOrch('queue-updated', (payload: { threadId: string; items: unknown }) => {
      emitToSubscribers(
        this.ring.push('queue.updated', { items: payload.items }, payload.threadId)
      )
    })

    onOrch('turn-started', (payload: { threadId?: string }) => {
      if (payload.threadId) {
        services.threadRuntimes.setActivity(payload.threadId, 'processing')
      }
      emitToSubscribers(this.ring.push('turn.started', payload, payload.threadId))
    })

    onOrch('turn-completed', (payload: { threadId?: string }) => {
      if (payload.threadId) {
        services.threadRuntimes.setActivity(payload.threadId, 'completed')
      }
      emitToSubscribers(this.ring.push('turn.completed', payload, payload.threadId))
    })

    onOrch('turn-interrupted', (payload: { threadId?: string }) => {
      if (payload.threadId) {
        services.threadRuntimes.setActivity(payload.threadId, 'idle')
      }
      emitToSubscribers(this.ring.push('turn.interrupted', payload, payload.threadId))
    })

    onOrch('turn-failed', (payload: { threadId?: string }) => {
      if (payload.threadId) {
        services.threadRuntimes.setActivity(payload.threadId, 'idle')
      }
    })

    onOrch('turn-aborted', (payload: { threadId?: string }) => {
      if (payload.threadId) {
        services.threadRuntimes.setActivity(payload.threadId, 'idle')
      }
      emitToSubscribers(this.ring.push('turn.aborted', payload, payload.threadId))
    })

    onOrch('turn-state', (state: TurnState) => {
      emitToSubscribers(this.ring.push('turn.state', state, state.threadId))
    })

    onOrch('turn-steered', (payload: { threadId: string; text: string }) => {
      emitToSubscribers(
        this.ring.push('turn.steered', { text: payload.text }, payload.threadId)
      )
    })

    onOrch('connection-failed', (payload: { threadId: string }) => {
      services.threadRuntimes.getOrHydrate(payload.threadId).setConnectionFailed(true)
      emitToSubscribers(
        this.ring.push('connection.failed', payload, payload.threadId)
      )
    })

    // Mousse subagent events
    onOrch(
      'mousse-agent-message',
      (payload: { threadId: string; agentId: string; message: unknown }) => {
        emitToSubscribers(this.ring.push('mousse-agent.message', payload, payload.threadId))
      }
    )
    onOrch(
      'mousse-agent-message-updated',
      (payload: { threadId: string; agentId: string; message: unknown }) => {
        emitToSubscribers(
          this.ring.push('mousse-agent.message-updated', payload, payload.threadId)
        )
      }
    )
    onOrch(
      'mousse-agent-messages-sync',
      (payload: { threadId: string; agentId: string; messages: unknown }) => {
        emitToSubscribers(
          this.ring.push('mousse-agent.messages-sync', payload, payload.threadId)
        )
      }
    )
    onOrch(
      'mousse-agent-complete',
      (payload: { threadId: string; agentId: string; summary?: string }) => {
        emitToSubscribers(this.ring.push('mousse-agent.complete', payload, payload.threadId))
      }
    )
    onOrch(
      'mousse-agent-connection-failed',
      (payload: { threadId: string; agentId: string }) => {
        emitToSubscribers(
          this.ring.push('mousse-agent.connection-failed', payload, payload.threadId)
        )
      }
    )

    // UI capability intents (Electron decides focus/open/notify)
    onOrch('document-opened', (payload: unknown) => {
      emitToSubscribers(this.ring.push('ui.document-open', payload, undefined))
    })
    onOrch('quick-action-created', (payload: unknown) => {
      emitToSubscribers(this.ring.push('ui.quick-action-created', payload, undefined))
    })

    // Questions (daemon-owned)
    const questions = services.questions
    onEmitter(questions, 'pending', (payload: { requestId: string; threadId: string }) => {
      services.threadRuntimes
        .getOrHydrate(payload.threadId)
        .pendingQuestionIds.add(payload.requestId)
      services.orchestrator.setAwaitingInput(payload.threadId)
      emitToSubscribers(
        this.ring.push('questions.pending', payload, payload.threadId)
      )
    })
    onEmitter(
      questions,
      'cleared',
      (payload: { requestId: string; threadId: string }) => {
        services.threadRuntimes
          .getOrHydrate(payload.threadId)
          .pendingQuestionIds.delete(payload.requestId)
        emitToSubscribers(
          this.ring.push('questions.cleared', payload, payload.threadId)
        )
      }
    )

    // PTY streaming with per-PTY sequence
    const pty = services.ptyManager
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
        emitToSubscribers(
          this.ring.push('pty.data', payload, payload.threadId)
        )
      }
    )
    onEmitter(
      pty,
      'exit',
      (payload: { ptyId: string; agentId: string; threadId: string }) => {
        emitToSubscribers(this.ring.push('pty.exit', payload, payload.threadId))
      }
    )
    onEmitter(
      pty,
      'created',
      (payload: { ptyId: string; agentId: string; threadId: string }) => {
        emitToSubscribers(this.ring.push('pty.created', payload, payload.threadId))
      }
    )
    onEmitter(pty, 'focus-intent', () => {
      emitToSubscribers(this.ring.push('ui.focus-intent', {}, undefined))
    })

    // Activity + agent/task registry fan-out from multi-tenant runtimes
    const runtimes = services.threadRuntimes
    onEmitter(
      runtimes,
      'activity',
      (payload: {
        threadId: string
        state: string
        activity?: Record<string, string>
      }) => {
        emitToSubscribers(this.ring.push('activity', payload, payload.threadId))
        if (payload.activity) {
          emitToSubscribers(
            this.ring.push('activity.snapshot', { activity: payload.activity }, undefined)
          )
        }
      }
    )
    onEmitter(
      runtimes,
      'agents.updated',
      (payload: { threadId: string; agents: unknown }) => {
        emitToSubscribers(
          this.ring.push('agents.updated', payload, payload.threadId)
        )
      }
    )
    onEmitter(
      runtimes,
      'tasks.updated',
      (payload: { threadId: string; tasks: unknown }) => {
        emitToSubscribers(
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
          services.orchestrator.getBoundThreadId() ??
          undefined
        const agent =
          (payload as { agent?: unknown }).agent !== undefined
            ? (payload as { agent: unknown }).agent
            : payload
        emitToSubscribers(
          this.ring.push('agent.spawned', { agent, threadId }, threadId)
        )
      }
    )
    onOrch(
      'agent-activated',
      (payload: { agentId: string; threadId?: string }) => {
        const threadId =
          payload.threadId ?? services.orchestrator.getBoundThreadId() ?? undefined
        emitToSubscribers(
          this.ring.push('agent.activated', payload, threadId)
        )
      }
    )
    onOrch(
      'terminal-activated',
      (payload: { ptyId: string; threadId?: string }) => {
        const threadId =
          payload.threadId ?? services.orchestrator.getBoundThreadId() ?? undefined
        emitToSubscribers(
          this.ring.push('terminal.activated', payload, threadId)
        )
      }
    )

    // Scheduler / channels (daemon-owned)
    onEmitter(services.lineEditStats, 'updated', (snapshot: unknown) => {
      emitToSubscribers(this.ring.push('stats.lineEdits.updated', { snapshot }, undefined))
    })
    onEmitter(services.scheduled, 'updated', (jobs: unknown) => {
      emitToSubscribers(this.ring.push('scheduled.updated', { jobs }, undefined))
    })
    onEmitter(services.scheduled, 'status', (status: unknown) => {
      emitToSubscribers(this.ring.push('scheduled.status', { status }, undefined))
    })
    onEmitter(services.channels, 'updated', (snapshot: unknown) => {
      emitToSubscribers(this.ring.push('channels.updated', { snapshot }, undefined))
    })
    onEmitter(services.channels, 'activity', (event: unknown) => {
      emitToSubscribers(this.ring.push('channels.activity', { event }, undefined))
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
      capabilities: new Set(),
      subscribeState: 'none',
      eventBuffer: [],
      lastSeq: 0,
      closed: false,
      chain: Promise.resolve(),
      subscribeChain: Promise.resolve(),
      bindingChain: Promise.resolve(),
      inFlightIds: new Set(),
      completedResponses: new Map(),
      awaitingDrain: false,
      connectionEventChain: Promise.resolve(),
      connectionEventPending: 0,
      connectionEventLifetime: new AbortController()
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
      if (!ownerTokensMatch(v.hello.ownerToken, this.opts.ownerToken)) {
        this.trySendRaw(session, {
          kind: 'hello_err',
          code: 'auth',
          message: 'Invalid owner fencing token'
        })
        this.closeClient(session)
        return
      }
      session.authenticated = true
      session.clientType = v.hello.clientType
      const advertised = [...PROTOCOL_CAPABILITIES, ...(this.opts.mms.domains?.capabilities() ?? [])].filter(
        (capability) => capability !== BROWSER_ATTACHED_V1_CAPABILITY || Boolean(this.opts.commandRouter)
      )
      if (
        this.opts.commandRouter &&
        !advertised.includes(BROWSER_ATTACHED_V1_CAPABILITY)
      ) {
        advertised.push(BROWSER_ATTACHED_V1_CAPABILITY)
      }
      const requested = new Set(v.hello.requestedCapabilities ?? [])
      session.capabilities = new Set(
        advertised.filter(
          (capability) =>
            capability !== PROFILES_V1_CAPABILITY &&
            capability !== ERROR_INFO_CAPABILITY &&
            capability !== BROWSER_ATTACHED_V1_CAPABILITY
        )
      )
      if (requested.has(ERROR_INFO_CAPABILITY)) session.capabilities.add(ERROR_INFO_CAPABILITY)
      if (requested.has(PROFILES_V1_CAPABILITY) && advertised.includes(PROFILES_V1_CAPABILITY)) {
        session.capabilities.add(PROFILES_V1_CAPABILITY)
      }
      if (
        this.opts.commandRouter &&
        v.hello.clientType === 'gui' &&
        requested.has(BROWSER_ATTACHED_V1_CAPABILITY) &&
        advertised.includes(BROWSER_ATTACHED_V1_CAPABILITY)
      ) {
        session.capabilities.add(BROWSER_ATTACHED_V1_CAPABILITY)
      }
      const ok: ProtocolHelloOk = {
        kind: 'hello_ok',
        protocolVersion: MMS_PROTOCOL_VERSION,
        serverVersion: this.opts.version,
        serverBuild: this.opts.build,
        instanceId: this.instanceId,
        capabilities: advertised,
        globalSequence: this.ring.currentSequence
      }
      this.attachCommandConnection(session)
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

    if (env.kind === 'client_res') {
      if (!this.opts.commandRouter) {
        this.sendRaw(session, {
          kind: 'error',
          code: 'unexpected',
          message: 'Unexpected kind after auth: client_res'
        })
        return
      }
      this.opts.commandRouter.acceptClientResponse(session.id, env)
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

    const v = validateRequest(env, this.opts.mms.domains?.methods())
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
            error: serializeAppError(normalizeAppError(err, 'handler_error'))
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

    if (v.req.method === 'profiles.bind') {
      const admittedBinding = session.binding ? { ...session.binding } : undefined
      const admittedCapabilities = new Set(session.capabilities)
      const run = session.bindingChain.then(() =>
        this.executeAdmittedRequest(
          session,
          v.req.id,
          v.req.method,
          v.req.params,
          admittedBinding,
          admittedCapabilities
        )
      )
      session.bindingChain = run.catch(() => {})
      // Later frames must observe the result of this binding mutation.
      await run
      return
    }

    // Capture binding at admission so a later profiles.bind cannot steal this request.
    const admittedBinding = session.binding ? { ...session.binding } : undefined
    const admittedCapabilities = new Set(session.capabilities)
    void this.executeAdmittedRequest(
      session,
      v.req.id,
      v.req.method,
      v.req.params,
      admittedBinding,
      admittedCapabilities
    )
  }

  private async executeAdmittedRequest(
    session: ClientSession,
    reqId: string,
    method: string,
    params: unknown,
    admittedBinding?: TrustedProfileBinding,
    admittedCapabilities?: Set<string>
  ): Promise<void> {
    let response: ProtocolResponse | null = null
    try {
      const { isInstallationMethod, resolveBoundServices } = await import('../profiles/admission')
      const resolved = await resolveBoundServices({
        installation: this.opts.mms,
        method,
        binding: admittedBinding,
        capabilities: admittedCapabilities ?? session.capabilities
      })
      this.wireOrchestratorEvents(resolved.services)
      const connectionEventLifetime = session.connectionEventLifetime
      const connection = {
        id: session.id,
        clientType: session.clientType,
        binding: resolved.binding,
        capabilities: admittedCapabilities ?? session.capabilities,
        emitConnectionEvent: (type: 'bridge.hub.thread', data: unknown, signal?: AbortSignal) =>
          this.emitConnectionEvent(
            session,
            resolved.binding,
            connectionEventLifetime,
            type,
            data,
            signal
          ),
        bind: (value: TrustedProfileBinding) => {
          if (
            session.binding &&
            (session.binding.profileId !== value.profileId || session.binding.epoch !== value.epoch)
          ) {
            // Cancel in-flight reverse commands for the old binding before
            // domain listeners observe the close, then before new work.
            this.opts.commandRouter?.revoke(session.id, 'rebind')
            session.connectionEventLifetime.abort()
            session.connectionEventLifetime = new AbortController()
            // Give profile-owned integrations a chance to close the old
            // connection before its binding is replaced.
            this.opts.mms.domains?.notifyConnectionClosed(session.id)
          }
          session.binding = value
          // A profile switch changes the event cursor namespace. Pause delivery
          // until the client establishes a fresh replay boundary for that profile.
          session.subscribeState = 'none'
          session.eventBuffer = []
          session.lastSeq = 0
        }
      }
      const result = await dispatchMethod(
        {
          mms: resolved.services,
          connection,
          ownerToken: this.opts.ownerToken,
          globalSequence: () => this.ringFor(resolved.services.profileId).currentSequence,
          emitEvent: (type, data, threadId) => {
            const profileId = isInstallationMethod(method) ? undefined : resolved.services.profileId
            this.emitToSubscribers(
              this.ring.push(type, data, threadId, profileId),
              profileId ?? null
            )
          }
        },
        method,
        params
      )
      // Profile creation/restore starts a new service while dispatch is in
      // flight. Attach its producers before acknowledging the lifecycle call.
      if (isInstallationMethod(method)) this.wireLiveProfileEvents()
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
        error: serializeAppError(err instanceof DomainRpcError
          ? knownAppError({ code: err.code, message, details: err.details })
          : err instanceof AgentDefinitionError
            ? knownAppError({ code: err.code, message, details: { ...err.details, ...(err.pointer ? { pointer: err.pointer } : {}) } }, { category: err.code === 'SETTINGS_UNSUPPORTED' ? 'unsupported' : 'invalid', retryable: err.retryable })
          : err instanceof ProfileError
            ? knownAppError({ code: err.code.toLowerCase(), message, details: err.details }, { category: 'invalid', retryable: false })
            : normalizeAppError(err, 'handler_error'))
      }
      if (response.error) console.error('MMS request failed', errorDiagnostic(response.error, method))
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

    const audience = session.binding?.profileId ?? this.opts.mms.profileId
    const ring = this.ringFor(audience)
    const currentSeq = ring.currentSequence
    const replay = ring.replayAfter(after)
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

  private emitToSubscribers(
    event: ProtocolEvent,
    sourceProfileId: string | null = this.opts.mms.profileId
  ): void {
    if (sourceProfileId) {
      const scoped = this.ringFor(sourceProfileId).push(
        event.type,
        event.data,
        event.threadId,
        sourceProfileId
      )
      this.broadcastEvent(scoped)
      return
    }

    // Installation events are safe shared data, but each profile receives its
    // own cursor so private traffic in another profile cannot create gaps.
    const audiences = new Set<string>([this.opts.mms.profileId])
    for (const client of this.clients.values()) {
      if (client.binding?.profileId) audiences.add(client.binding.profileId)
    }
    const host = this.opts.mms.getInstallationHost()
    if (host) {
      for (const record of host.manager.list()) {
        if (record.status === 'active') audiences.add(record.id)
      }
    }
    for (const audience of audiences) {
      const scoped = this.ringFor(audience).push(event.type, event.data, event.threadId)
      this.broadcastEvent(scoped, audience)
    }
  }

  private broadcastEvent(event: ProtocolEvent, audienceProfileId?: string): void {
    for (const client of this.clients.values()) {
      if (!client.authenticated || client.closed) continue
      if (audienceProfileId) {
        const boundId = client.binding?.profileId ?? this.opts.mms.profileId
        if (boundId !== audienceProfileId) continue
      }
      if (!this.clientAcceptsEvent(client, event)) continue
      if (client.subscribeState === 'buffering') {
        client.eventBuffer.push(event)
        continue
      }
      if (client.subscribeState !== 'active') continue
      this.deliverEventToClient(client, event)
    }
  }

  private clientAcceptsEvent(session: ClientSession, event: ProtocolEvent): boolean {
    if (!event.profileId || event.type === 'server.shutdown') return true
    const boundId = session.binding?.profileId ?? this.opts.mms.profileId
    return event.profileId === boundId
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
    if (!session.capabilities.has(ERROR_INFO_CAPABILITY)) value = stripErrorInfo(value)
    return this.writeFrame(session, value, true)
  }

  private emitConnectionEvent(
    session: ClientSession,
    binding: TrustedProfileBinding | undefined,
    lifetime: AbortController,
    type: 'bridge.hub.thread',
    data: unknown,
    signal?: AbortSignal
  ): Promise<void> {
    const valid = (): boolean =>
      !session.closed &&
      session.authenticated &&
      session.capabilities.has(NET_LOCAL_CAPABILITY) &&
      !!binding &&
      session.binding?.profileId === binding.profileId &&
      session.binding.epoch === binding.epoch &&
      session.connectionEventLifetime === lifetime &&
      !lifetime.signal.aborted &&
      !signal?.aborted
    if (!valid()) {
      return Promise.reject(
        new DomainRpcError(
          'connection_closed',
          'Display requires the current authenticated profile binding'
        )
      )
    }
    if (type !== 'bridge.hub.thread') {
      return Promise.reject(new DomainRpcError('invalid_params', 'Unsupported connection event'))
    }
    if (session.connectionEventPending >= 8) {
      return Promise.reject(
        new DomainRpcError('resource_limit', 'Too many pending display frames')
      )
    }
    let frame: Buffer
    try {
      frame = encodeFrame(
        {
          kind: 'connection_event',
          type,
          profileId: binding!.profileId,
          profileEpoch: binding!.epoch,
          data
        },
        MMS_PROTOCOL_MAX_CONNECTION_EVENT_BYTES
      )
    } catch (error) {
      return Promise.reject(error)
    }
    session.connectionEventPending++
    const combined = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal
    const operation = session.connectionEventChain
      .then(async () => {
        if (!valid()) throw new DomainRpcError('connection_closed', 'Display profile binding changed')
        if (session.socket.writableLength + frame.length > MMS_PROTOCOL_MAX_OUTBOUND_QUEUED_BYTES) {
          this.closeClient(session)
          throw new DomainRpcError('connection_closed', 'Display write backlog exceeded')
        }
        await writeConnectionEventFrame(session.socket, frame, combined)
      })
      .finally(() => {
        session.connectionEventPending--
      })
    session.connectionEventChain = operation.catch(() => {})
    return operation
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

  private attachCommandConnection(session: ClientSession): void {
    const router = this.opts.commandRouter
    if (!router) return
    const connectionId = session.id
    router.attach({
      connectionId,
      clientType: session.clientType ?? 'unknown',
      capabilities: new Set(session.capabilities),
      currentBinding: () =>
        session.binding
          ? Object.freeze({ profileId: session.binding.profileId, epoch: session.binding.epoch })
          : undefined,
      send: (envelope) => {
        if (session.closed || session.id !== connectionId) return false
        return this.sendRaw(session, envelope)
      }
    })
  }

  private closeClient(session: ClientSession): void {
    if (session.closed) return
    session.closed = true
    session.connectionEventLifetime.abort()
    session.subscribeState = 'none'
    session.eventBuffer = []
    session.inFlightIds.clear()
    session.completedResponses.clear()
    this.clients.delete(session.id)
    this.opts.commandRouter?.revoke(session.id, 'close')
    this.opts.mms.domains?.notifyConnectionClosed(session.id)
    try {
      session.socket.removeAllListeners('data')
      session.socket.destroy()
    } catch {
      /* ignore */
    }
  }
}

/** Additive classification is sent only to peers requesting errors.v1. */
function stripErrorInfo(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== 'object' || depth >= 64) return value
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value
  let changed = false
  if (Array.isArray(value)) {
    const result = value.map((item) => { const next = stripErrorInfo(item, depth + 1); changed ||= next !== item; return next })
    return changed ? result : value
  }
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === 'errorInfo' && 'code' in value && 'message' in value) { changed = true; continue }
    const next = stripErrorInfo(item, depth + 1)
    changed ||= next !== item
    result[key] = next
  }
  return changed ? result : value
}
