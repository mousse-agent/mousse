import { createHash } from 'node:crypto'
import type { NodeCapability, NodeDelegation, NodeId, Roster, RpcId } from '../../../shared/net'
import { NetError, isNetErrorCode } from '../../../shared/net/errors'
import type {
  Clock,
  ExecutionLedger,
  ExecutionRecord,
  RpcContext,
  RpcDispatcher,
  RpcMethod,
  SyncSession
} from '../contracts'
import type { NetDatabase } from '../store/database'
import { canonicalJson } from './codec'
import type { SessionRpcPort } from './session'

/** Settled request rows and their aliases are kept this long; no retry window comes close. */
export const LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** Pruning runs at start and then at most this often while requests arrive. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000
const PRUNE_BATCH = 100
/** One pass stops after this long, so a first backlog never blocks the daemon. */
const PRUNE_BUDGET_MS = 200
/** A pass that left a backlog runs again after this long. */
const PRUNE_RETRY_MS = 60 * 1000

interface OmittedResult {
  $ledger: 'omitted'
  sha256: string
  bytes: number
}
const isOmittedResult = (value: unknown): value is OmittedResult =>
  typeof value === 'object' &&
  value !== null &&
  (value as { $ledger?: unknown }).$ledger === 'omitted'

/** Durable request aliases share the execution ledger's database/transaction manager. */
export class DurableRpcDispatcher implements RpcDispatcher, SessionRpcPort {
  private registry = new Map<string, RpcMethod>()
  private running = new Map<string, { controller: AbortController; caller: NodeId }>()
  private lastPruneAt = Number.NEGATIVE_INFINITY
  private resultPublisher?: (
    result: unknown,
    context: RpcContext,
    method: RpcMethod
  ) => { result: unknown; commit(): void }
  constructor(
    private readonly options: {
      db: NetDatabase
      executions: ExecutionLedger
      identity: import('../contracts').IdentityService
      clock: Clock
      /** How long settled requests are kept (default 7 days). */
      ledgerRetentionMs?: number
      /** Parameter-independent current policy, including retained aliases and artifact bindings. */
      authorizeMethod?(
        method: RpcMethod,
        peer: SyncSession['peer'],
        capability: NodeCapability
      ): void
    }
  ) {
    options.db.database.exec(
      'CREATE TABLE IF NOT EXISTS net_rpc_aliases(caller TEXT NOT NULL,id TEXT NOT NULL,method TEXT NOT NULL,payload_hash TEXT NOT NULL,execution TEXT NOT NULL,PRIMARY KEY(caller,id)) STRICT'
    )
    if (
      !options.db.database
        .prepare('PRAGMA table_info(net_rpc_aliases)')
        .all()
        .some((row) => row.name === 'capability')
    )
      options.db.database.exec('ALTER TABLE net_rpc_aliases ADD COLUMN capability TEXT')
    // Pruning deletes aliases by execution, and retries look them up by it; both need the index
    // before the first pass, or each deleted request scans the whole table.
    options.db.database.exec(
      'CREATE INDEX IF NOT EXISTS net_rpc_aliases_execution ON net_rpc_aliases(execution)'
    )
    this.pruneLedger()
  }
  /**
   * Drops settled requests and their aliases after the retention window. Best effort and bounded:
   * a failure or a long backlog is picked up by the next run.
   */
  pruneLedger(): number {
    const now = this.options.clock.now(),
      started = this.options.clock.monotonic()
    this.lastPruneAt = now
    let removed = 0
    try {
      for (;;) {
        const count = this.options.executions.prune(
          now - (this.options.ledgerRetentionMs ?? LEDGER_RETENTION_MS),
          PRUNE_BATCH,
          (ids) => {
            const drop = this.options.db.database.prepare(
              'DELETE FROM net_rpc_aliases WHERE execution=?'
            )
            for (const id of ids) drop.run(id)
          }
        )
        removed += count
        if (count < PRUNE_BATCH) break
        if (this.options.clock.monotonic() - started >= PRUNE_BUDGET_MS) {
          // More is waiting: come back soon instead of in an hour.
          this.lastPruneAt = now - PRUNE_INTERVAL_MS + PRUNE_RETRY_MS
          break
        }
      }
    } catch {
      // The ledger stays correct without pruning; try again at the next interval.
    }
    return removed
  }
  private pruneIfDue(): void {
    if (this.options.clock.now() - this.lastPruneAt >= PRUNE_INTERVAL_MS) this.pruneLedger()
  }
  register(method: RpcMethod): void {
    if (this.registry.has(method.method)) throw new NetError('conflict')
    if (method.ephemeral && (method.mutating || method.uploadEnabled))
      throw new NetError('bad_request', 'Only read-only methods can run outside the ledger.')
    this.registry.set(method.method, method)
  }
  methods(): string[] {
    return [...this.registry.keys()].sort()
  }
  methodInfo(name: string): RpcMethod | undefined {
    return this.registry.get(name)
  }
  setResultPublisher(publish: NonNullable<DurableRpcDispatcher['resultPublisher']>): void {
    if (this.resultPublisher) throw new NetError('conflict')
    this.resultPublisher = publish
  }
  authorizedMethod(name: string, peer: SyncSession['peer']): RpcMethod {
    return this.authorize(name, peer)
  }
  originalRequest(id: RpcId, peer: SyncSession['peer'], method: string): RpcId | undefined {
    const alias = this.alias(id, peer)
    if (!alias) return undefined
    if (alias.method !== method) throw new NetError('conflict')
    this.authorize(method, peer)
    return this.options.db.database
      .prepare(
        'SELECT id FROM net_rpc_aliases WHERE caller=? AND execution=? ORDER BY rowid LIMIT 1'
      )
      .get(peer.node, alias.execution)?.id as RpcId | undefined
  }
  request(
    message: Parameters<SessionRpcPort['request']>[0],
    peer: SyncSession['peer'],
    signal: AbortSignal,
    progress: (data: unknown) => void | Promise<void>,
    session?: { carrier?: string }
  ): Promise<unknown> {
    return this.dispatch(message.method, message.params, message.idem, {
      id: message.id,
      caller: peer,
      ...(session?.carrier ? { carrier: session.carrier } : {}),
      signal,
      deadlineAt: this.options.clock.now() + message.deadlineMs,
      progress
    })
  }
  async dispatch(
    name: string,
    params: unknown,
    idem: string | undefined,
    context: RpcContext
  ): Promise<unknown> {
    const method = this.registry.get(name)
    if (!method) throw new NetError('forbidden')
    params = method.validate ? method.validate(params) : params
    const capability = method.capabilityFor?.(params) ?? method.capability
    this.authorize(name, context.caller, capability)
    method.authorize?.(params, context)
    if (method.mutating && (!idem || idem.length > 256))
      throw new NetError('bad_request', 'Mutations need durable idempotency.')
    if (context.signal.aborted) throw new NetError('cancelled')
    if (method.ephemeral) {
      const returned = await method.handle(params, context)
      this.authorize(name, context.caller, capability)
      const result = returned === undefined ? null : returned
      if (canonicalJson(result).byteLength > 63 * 1024) throw new NetError('too_large')
      return result
    }
    this.pruneIfDue()
    const payloadHash = createHash('sha256')
      .update(canonicalJson({ method: name, params }))
      .digest('hex')
    const outcome = this.options.db.transaction(() => {
      const prior = this.alias(context.id, context.caller)
      if (prior && (prior.method !== name || prior.payload_hash !== payloadHash))
        throw new NetError('conflict')
      const outcome = this.options.executions.admit(
        { scope: context.caller.node, target: name, trigger: idem ?? context.id },
        payloadHash,
        this.options.clock.now()
      )
      if (prior && prior.execution !== outcome.record.id) throw new NetError('conflict')
      this.options.db.database
        .prepare(
          'INSERT OR IGNORE INTO net_rpc_aliases(caller,id,method,payload_hash,execution,capability) VALUES(?,?,?,?,?,?)'
        )
        .run(context.caller.node, context.id, name, payloadHash, outcome.record.id, capability)
      this.options.db.charge(1)
      return outcome
    })
    if (outcome.kind === 'duplicate') return this.terminal(outcome.record)
    const id = outcome.record.id,
      controller = new AbortController()
    const terminalEffects: Array<() => void> = []
    const abort = (): void => controller.abort()
    context.signal.addEventListener('abort', abort, { once: true })
    this.running.set(id, { controller, caller: context.caller.node })
    try {
      this.authorize(name, context.caller, capability)
      method.authorize?.(params, context)
      method.authorizeNew?.(params, context)
      if (context.signal.aborted) throw new NetError('cancelled')
      this.options.executions.transition(id, 'running', this.options.clock.now())
      const returned = await method.handle(params, {
        ...context,
        execution: id,
        signal: controller.signal,
        onTerminalCommit: (work) => terminalEffects.push(work)
      })
      let result: unknown = returned === undefined ? null : returned
      const bytes = canonicalJson(result)
      if (controller.signal.aborted) {
        this.options.executions.transition(id, 'uncertain', this.options.clock.now(), {
          error: { code: 'outcome_uncertain', message: 'Cancellation did not prove rollback.' }
        })
        throw new NetError('outcome_uncertain')
      }
      this.authorize(name, context.caller, capability)
      let publication: { result: unknown; commit(): void } | undefined
      if (bytes.byteLength > 63 * 1024) {
        if (!this.resultPublisher)
          throw new NetError(
            'too_large',
            'Large RPC results require an authorized artifact publisher.'
          )
        publication = this.resultPublisher(result, context, method)
        result = publication.result
        if (canonicalJson(result).byteLength > 63 * 1024) throw new NetError('too_large')
      }
      const settled = canonicalJson(result)
      this.options.executions.transition(
        id,
        'completed',
        this.options.clock.now(),
        {
          result:
            method.ledgerResultMaxBytes !== undefined &&
            settled.byteLength > method.ledgerResultMaxBytes
              ? ({
                  $ledger: 'omitted',
                  sha256: createHash('sha256').update(settled).digest('hex'),
                  bytes: settled.byteLength
                } satisfies OmittedResult)
              : result
        },
        () => {
          for (const work of terminalEffects) {
            const returned: unknown = work()
            if (returned && typeof (returned as { then?: unknown }).then === 'function')
              throw new NetError('bad_request', 'Terminal effects must be synchronous.')
          }
          publication?.commit()
        }
      )
      return result
    } catch (error) {
      const record = this.options.executions.get(id)!
      if (record.state === 'accepted')
        this.options.executions.transition(id, 'failed', this.options.clock.now(), {
          error: {
            code: error instanceof NetError ? error.code : 'cancelled',
            message: 'Handler did not start.'
          }
        })
      else if (record.state === 'running') {
        // A thrown handler can have made an external effect; never claim rollback.
        this.options.executions.transition(id, 'uncertain', this.options.clock.now(), {
          error: { code: 'outcome_uncertain', message: 'Handler outcome is not durably proven.' }
        })
      }
      throw record.state === 'accepted'
        ? error
        : new NetError('outcome_uncertain', undefined, { cause: error })
    } finally {
      context.signal.removeEventListener('abort', abort)
      this.running.delete(id)
    }
  }
  async result(id: RpcId, peer: SyncSession['peer']): Promise<unknown> {
    const alias = this.alias(id, peer)
    if (!alias) throw new NetError('outcome_uncertain')
    this.authorize(alias.method, peer, alias.capability)
    const record = this.options.executions.get(alias.execution as ExecutionRecord['id'])
    if (!record) throw new NetError('outcome_uncertain')
    return this.terminal(record)
  }
  async cancel(id: RpcId, peer: SyncSession['peer']): Promise<void> {
    const alias = this.alias(id, peer)
    // A cancelled unsent request may never have been admitted. Cancel is idempotent.
    if (!alias) return
    this.authorize(alias.method, peer, alias.capability)
    this.running.get(alias.execution)?.controller.abort()
    // Missing live handler is not evidence that a persisted effect was rolled back.
  }
  /**
   * Asks every handler that is running for `node` to stop, as a block does. A handler that has
   * already made its effect still ends `outcome_uncertain`: stopping is a request, not a rollback.
   */
  abortCaller(node: NodeId): number {
    let aborted = 0
    for (const entry of this.running.values())
      if (entry.caller === node) {
        entry.controller.abort()
        aborted++
      }
    return aborted
  }
  private alias(
    id: RpcId,
    peer: SyncSession['peer']
  ):
    | { method: string; payload_hash: string; execution: string; capability?: NodeCapability }
    | undefined {
    return this.options.db.database
      .prepare(
        'SELECT method,payload_hash,execution,capability FROM net_rpc_aliases WHERE caller=? AND id=?'
      )
      .get(peer.node, id) as
      | { method: string; payload_hash: string; execution: string; capability?: NodeCapability }
      | undefined
  }
  private authorize(
    name: string,
    peer: SyncSession['peer'],
    capability?: NodeCapability
  ): RpcMethod {
    const method = this.registry.get(name),
      identity = this.options.identity,
      self = identity.self()
    if (!method || !self || peer.user !== self.user) throw new NetError('forbidden')
    const root = identity.pinnedRootKey(peer.user),
      signed = identity.roster(peer.user)
    if (!root || !signed || identity.rosterState(peer.user) !== 'ok')
      throw new NetError('roster_conflict')
    const roster = identity.verifySigned<Roster>(signed, root)
    const current = roster.nodes
      .map((row) => identity.verifySigned<NodeDelegation>(row, root))
      .filter((row) => row.subject === peer.node)
      .sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
    // The live roster drops revoked delegations but keeps their revocation evidence.
    if (!current && roster.revoked.some((row) => row.subject === peer.node))
      throw new NetError('revoked')
    if (
      !current ||
      current.keyEpoch !== peer.delegation.keyEpoch ||
      current.expiresAt <= this.options.clock.now() ||
      current.issuedAt > this.options.clock.now()
    )
      throw new NetError('bad_delegation')
    if (
      roster.revoked.some(
        (row) => row.subject === peer.node && row.throughKeyEpoch >= current.keyEpoch
      )
    )
      throw new NetError('revoked')
    const required = capability ?? method.capability
    if (!current.caps.includes(required)) throw new NetError('forbidden')
    // The grant that marks a computer (a phone never holds it), also checked when a result is asked for later.
    if (method.requires?.some((extra) => !current.caps.includes(extra)))
      throw new NetError('forbidden', undefined, { details: { reason: 'capability' } })
    this.options.authorizeMethod?.(method, peer, required)
    return method
  }
  private terminal(record: ExecutionRecord): unknown {
    if (record.state === 'completed') {
      // A large result was not kept; the request did complete, but its answer cannot be replayed.
      if (isOmittedResult(record.result))
        throw new NetError(
          'outcome_uncertain',
          'The request completed; its large result was not kept.'
        )
      return record.result
    }
    if (record.state === 'failed' || record.state === 'cancelled' || record.state === 'expired')
      throw new NetError(
        isNetErrorCode(record.error?.code) ? record.error.code : 'outcome_uncertain'
      )
    throw new NetError('outcome_uncertain')
  }
}
