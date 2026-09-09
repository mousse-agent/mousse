/**
 * Remote Session Dispatcher for Control Protocol 2.0.
 * Bridges remote encrypted channel requests to existing MMS protocol handlers / services.
 * Implements:
 * - Strict scope enforcement (mousse:read, chat, write, terminal, settings)
 * - Remote method allowlist (denies admin, secret, local-control, provider login)
 * - Mutation idempotency via IdempotencyStore
 * - Response & event secret redaction
 * - EventRing sequence cursors and snapshotRequired fallback
 * - Max 64 concurrent RPCs per session
 */

import type {
  ControlCancelEnvelope,
  ControlEnvelope,
  ControlEventEnvelope,
  ControlRequestEnvelope,
  ControlResponseEnvelope,
  ControlSnapshotRequiredEnvelope,
  PairingGrant,
  RemoteScope
} from '../../../shared/controlTypes'
import { MAX_CONCURRENT_RPCS } from '../constants'
import { IdempotencyConflictError, IdempotencyStore } from '../storage/idempotencyStore'
import { EventSequenceRing } from '../../protocol/eventRing'
import type { MmsEvent, MmsEventBus } from '../../events'

export interface RemoteMethodExecutionHandler {
  execute(method: string, params: unknown): Promise<unknown>
}

const SCOPE_REQUIREMENTS: Record<string, RemoteScope> = {
  // Read scope
  health: 'mousse:read',
  capabilities: 'mousse:read',
  'projects.list': 'mousse:read',
  'threads.list': 'mousse:read',
  'threads.get': 'mousse:read',
  'threads.search': 'mousse:read',
  'thread.snapshot': 'mousse:read',
  'workspace.getStatus': 'mousse:read',
  'agents.list': 'mousse:read',
  'tasks.list': 'mousse:read',
  'scheduled.list': 'mousse:read',
  'scheduled.get': 'mousse:read',
  'actions.list': 'mousse:read',
  'actions.getAffectedFiles': 'mousse:read',
  'operations.get': 'mousse:read',
  'activity.get': 'mousse:read',
  'activity.snapshot': 'mousse:read',
  'stats.usage': 'mousse:read',
  'files.read': 'mousse:read',
  'files.list': 'mousse:read',

  // Chat scope
  'orchestrator.send': 'mousse:chat',
  'orchestrator.steer': 'mousse:chat',
  'orchestrator.abort': 'mousse:chat',
  'orchestrator.retry': 'mousse:chat',
  'orchestrator.isTurnActive': 'mousse:chat',
  'orchestrator.contextUsage': 'mousse:chat',
  'orchestrator.answerQuestions': 'mousse:chat',
  'orchestrator.dismissQuestions': 'mousse:chat',
  'orchestrator.pendingQuestions': 'mousse:chat',
  'queue.list': 'mousse:chat',
  'queue.enqueue': 'mousse:chat',
  'queue.reorder': 'mousse:chat',
  'queue.remove': 'mousse:chat',
  'queue.promoteToSteer': 'mousse:chat',
  'mousseAgent.getMessages': 'mousse:chat',
  'mousseAgent.getAssignment': 'mousse:chat',
  'mousseAgent.send': 'mousse:chat',
  'mousseAgent.retry': 'mousse:chat',
  'mousseAgent.abort': 'mousse:chat',

  // Write scope
  'projects.open': 'mousse:write',
  'projects.remove': 'mousse:write',
  'projects.rename': 'mousse:write',
  'projects.pin': 'mousse:write',
  'projects.reorder': 'mousse:write',
  'threads.create': 'mousse:write',
  'threads.delete': 'mousse:write',
  'threads.rename': 'mousse:write',
  'threads.pin': 'mousse:write',
  'threads.settle': 'mousse:write',
  'threads.reorder': 'mousse:write',
  'threads.regenerateTitle': 'mousse:write',
  'threads.setModel': 'mousse:write',
  'threads.setWorktreeEnabled': 'mousse:write',
  'threads.trash': 'mousse:write',
  'threads.restore': 'mousse:write',
  'threads.purge': 'mousse:write',
  'tasks.create': 'mousse:write',
  'tasks.update': 'mousse:write',
  'actions.undoLatest': 'mousse:write',
  'actions.revertCode': 'mousse:write',
  'actions.redo': 'mousse:write',
  'actions.fork': 'mousse:write',
  'actions.activateBranch': 'mousse:write',
  'operations.abort': 'mousse:write',
  'publish.start': 'mousse:write',
  'files.write': 'mousse:write',

  // Terminal scope
  'pty.list': 'mousse:terminal',
  'pty.create': 'mousse:terminal',
  'pty.write': 'mousse:terminal',
  'pty.resize': 'mousse:terminal',
  'pty.kill': 'mousse:terminal',
  'pty.isAlive': 'mousse:terminal',
  'pty.lookup': 'mousse:terminal',
  'pty.scrollback': 'mousse:terminal',
  'pty.outputSince': 'mousse:terminal',

  // Settings scope (nonsecret allowlisted only)
  'settings.get': 'mousse:settings',
  'settings.set': 'mousse:settings'
}

/** Explicitly forbidden methods for remote execution in v1. */
const FORBIDDEN_REMOTE_METHODS = new Set([
  'provider.login',
  'providers.setApiKey',
  'mcp.authenticate',
  'control.status',
  'control.enroll',
  'control.disconnect',
  'pairing.create',
  'pairing.approve',
  'pairing.reject',
  'pairing.revoke',
  'service.restart',
  'service.stop'
])

export class RemoteSessionDispatcher {
  private grant: PairingGrant
  private executor: RemoteMethodExecutionHandler
  private idempotencyStore: IdempotencyStore
  private eventRing: EventSequenceRing
  private instanceId: string
  private sendEnvelope: (env: ControlEnvelope) => void

  private inFlight = new Map<string, AbortController>()

  constructor(options: {
    grant: PairingGrant
    executor: RemoteMethodExecutionHandler
    idempotencyStore: IdempotencyStore
    eventBus?: MmsEventBus
    instanceId: string
    sendEnvelope: (env: ControlEnvelope) => void
  }) {
    this.grant = options.grant
    this.executor = options.executor
    this.idempotencyStore = options.idempotencyStore
    this.instanceId = options.instanceId
    this.sendEnvelope = options.sendEnvelope
    this.eventRing = new EventSequenceRing(512)

    if (options.eventBus) {
      this.wireEvents(options.eventBus)
    }
  }

  private wireEvents(eventBus: MmsEventBus): void {
    eventBus.onAny((channel: string, data: unknown) => {
      const redactedData = redactSecrets(data)
      const ringEvent = this.eventRing.push(channel, redactedData)

      // Send to remote peer if read scope granted
      if (this.grant.grantedScopes.includes('mousse:read')) {
        const env: ControlEventEnvelope = {
          kind: 'event',
          instanceId: this.instanceId,
          sequence: ringEvent.sequence,
          type: channel,
          data: redactedData,
          ts: new Date().toISOString()
        }
        this.sendEnvelope(env)
      }
    })
  }

  /**
   * Dispatch an incoming Control Protocol 2.0 envelope from remote peer.
   */
  async handleEnvelope(env: ControlEnvelope): Promise<void> {
    if (this.grant.status === 'revoked') {
      this.sendEnvelope({
        kind: 'response',
        id: (env as ControlRequestEnvelope).id || 'unknown',
        ok: false,
        error: { code: 'DEVICE_REVOKED', message: 'Device pairing has been revoked' }
      })
      return
    }

    if (env.kind === 'ping') {
      this.sendEnvelope({ kind: 'pong', ts: env.ts })
      return
    }

    if (env.kind === 'cancel') {
      this.handleCancel(env)
      return
    }

    if (env.kind === 'request') {
      await this.handleRequest(env)
      return
    }
  }

  private handleCancel(env: ControlCancelEnvelope): void {
    const controller = this.inFlight.get(env.requestId)
    if (controller) {
      controller.abort()
      this.inFlight.delete(env.requestId)
    }
  }

  private async handleRequest(req: ControlRequestEnvelope): Promise<void> {
    if (this.inFlight.size >= MAX_CONCURRENT_RPCS) {
      this.sendEnvelope({
        kind: 'response',
        id: req.id,
        ok: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Max concurrent requests (${MAX_CONCURRENT_RPCS}) reached`
        }
      })
      return
    }

    // 1. Check method allowlist
    if (FORBIDDEN_REMOTE_METHODS.has(req.method) || !SCOPE_REQUIREMENTS[req.method]) {
      this.sendEnvelope({
        kind: 'response',
        id: req.id,
        ok: false,
        error: {
          code: 'METHOD_FORBIDDEN',
          message: `Method ${req.method} is forbidden for remote execution`
        }
      })
      return
    }

    // 2. Check required scope
    const requiredScope = SCOPE_REQUIREMENTS[req.method]
    if (!this.grant.grantedScopes.includes(requiredScope)) {
      this.sendEnvelope({
        kind: 'response',
        id: req.id,
        ok: false,
        error: {
          code: 'PERMISSION_DENIED',
          message: `Required scope ${requiredScope} not granted to this pairing`
        }
      })
      return
    }

    // 3. Check idempotency if key provided
    let payloadHash = ''
    if (req.idempotencyKey) {
      payloadHash = IdempotencyStore.hashPayload(req.method, req.params)
      try {
        const cached = this.idempotencyStore.get(this.grant.pairingId, req.idempotencyKey, payloadHash)
        if (cached !== null) {
          this.sendEnvelope({
            kind: 'response',
            id: req.id,
            ok: true,
            result: cached
          })
          return
        }
      } catch (err) {
        if (err instanceof IdempotencyConflictError) {
          this.sendEnvelope({
            kind: 'response',
            id: req.id,
            ok: false,
            error: {
              code: 'IDEMPOTENCY_CONFLICT',
              message: 'Idempotency key re-used with conflicting parameters'
            }
          })
          return
        }
        throw err
      }
    }

    // 4. Handle subscribe cursor replay
    if (req.method === 'subscribe') {
      this.handleSubscribe(req)
      return
    }

    // 5. Execute method with cancellation support
    const abortController = new AbortController()
    this.inFlight.set(req.id, abortController)

    try {
      const sanitizedParams = sanitizeRemoteParams(req.method, req.params)
      const rawResult = await this.executor.execute(req.method, sanitizedParams)
      const redactedResult = redactSecrets(rawResult)

      // Save to idempotency store if requested
      if (req.idempotencyKey) {
        this.idempotencyStore.save(
          this.grant.pairingId,
          req.idempotencyKey,
          req.method,
          payloadHash,
          redactedResult
        )
      }

      this.sendEnvelope({
        kind: 'response',
        id: req.id,
        ok: true,
        result: redactedResult
      })
    } catch (err) {
      this.sendEnvelope({
        kind: 'response',
        id: req.id,
        ok: false,
        error: {
          code: 'EXECUTION_ERROR',
          message: (err as Error).message || 'Execution error'
        }
      })
    } finally {
      this.inFlight.delete(req.id)
    }
  }

  private handleSubscribe(req: ControlRequestEnvelope): void {
    const params = req.params as { afterSeq?: number } | undefined
    const afterSeq = typeof params?.afterSeq === 'number' ? params.afterSeq : 0

    const replay = this.eventRing.replayAfter(afterSeq)
    if (replay.gap) {
      this.sendEnvelope({
        kind: 'snapshotRequired',
        reason: 'Event sequence gap detected or cursor too old',
        lastKnownSequence: afterSeq
      })
      this.sendEnvelope({
        kind: 'response',
        id: req.id,
        ok: true,
        result: { subscribed: true, sequence: this.eventRing.currentSequence, gap: true }
      })
      return
    }

    // Replay missed events
    for (const evt of replay.events) {
      this.sendEnvelope({
        kind: 'event',
        instanceId: this.instanceId,
        sequence: evt.sequence,
        type: evt.type,
        data: evt.data,
        ts: new Date().toISOString()
      })
    }

    this.sendEnvelope({
      kind: 'response',
      id: req.id,
      ok: true,
      result: { subscribed: true, sequence: this.eventRing.currentSequence, replayed: replay.events.length }
    })
  }

  close(): void {
    for (const controller of this.inFlight.values()) {
      controller.abort()
    }
    this.inFlight.clear()
  }
}

/** Sanitize and reject dangerous parameters for remote execution. */
function sanitizeRemoteParams(method: string, params: unknown): unknown {
  if (method === 'settings.set' && params && typeof params === 'object') {
    const p = params as { partial?: Record<string, unknown> }
    if (p.partial) {
      // Disallow remote mutation of providers / API keys
      delete p.partial.provider
      delete p.partial.providers
    }
  }
  return params
}

/** Redact sensitive credentials and internal tokens from responses and events. */
export function redactSecrets(data: unknown): unknown {
  if (data === null || data === undefined) return data
  if (typeof data !== 'object') return data

  if (Array.isArray(data)) {
    return data.map((item) => redactSecrets(item))
  }

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    const lower = k.toLowerCase()
    if (
      lower.includes('apikey') ||
      lower.includes('secret') ||
      lower.includes('ownertoken') ||
      lower === 'accesstoken' ||
      lower === 'refreshtoken' ||
      lower === 'pairingsecret'
    ) {
      out[k] = '***REDACTED***'
    } else {
      out[k] = redactSecrets(v)
    }
  }
  return out
}
