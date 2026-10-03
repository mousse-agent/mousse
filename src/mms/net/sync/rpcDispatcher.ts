import { createHash } from 'node:crypto'
import type { NodeDelegation, Roster, RpcId } from '../../../shared/net'
import { NetError, isNetErrorCode } from '../../../shared/net/errors'
import type { Clock, ExecutionLedger, ExecutionRecord, RpcContext, RpcDispatcher, RpcMethod, SyncSession } from '../contracts'
import type { NetDatabase } from '../store/database'
import { canonicalJson } from './codec'
import type { SessionRpcPort } from './session'

/** Durable request aliases share the execution ledger's database/transaction manager. */
export class DurableRpcDispatcher implements RpcDispatcher, SessionRpcPort {
  private registry = new Map<string, RpcMethod>()
  private running = new Map<string, AbortController>()
  constructor(private readonly options: {
    db: NetDatabase
    executions: ExecutionLedger
    identity: import('../contracts').IdentityService
    clock: Clock
  }) {
    options.db.database.exec('CREATE TABLE IF NOT EXISTS net_rpc_aliases(caller TEXT NOT NULL,id TEXT NOT NULL,method TEXT NOT NULL,payload_hash TEXT NOT NULL,execution TEXT NOT NULL,PRIMARY KEY(caller,id)) STRICT')
  }
  register(method: RpcMethod): void {
    if (this.registry.has(method.method)) throw new NetError('conflict')
    this.registry.set(method.method, method)
  }
  methods(): string[] { return [...this.registry.keys()].sort() }
  request(message: Parameters<SessionRpcPort['request']>[0], peer: SyncSession['peer'], signal: AbortSignal, progress: (data: unknown) => void): Promise<unknown> {
    return this.dispatch(message.method, message.params, message.idem, { id: message.id, caller: peer, signal, deadlineAt: this.options.clock.now() + message.deadlineMs, progress })
  }
  async dispatch(name: string, params: unknown, idem: string | undefined, context: RpcContext): Promise<unknown> {
    const method = this.authorize(name, context.caller)
    if (method.mutating && (!idem || idem.length > 256)) throw new NetError('bad_request', 'Mutations need durable idempotency.')
    if (context.signal.aborted) throw new NetError('cancelled')
    const payloadHash = createHash('sha256').update(canonicalJson({ method: name, params })).digest('hex')
    const outcome = this.options.db.transaction(() => {
      const prior = this.alias(context.id, context.caller)
      if (prior && (prior.method !== name || prior.payload_hash !== payloadHash)) throw new NetError('conflict')
      const outcome = this.options.executions.admit({ scope: context.caller.node, target: name, trigger: idem ?? context.id }, payloadHash, this.options.clock.now())
      if (prior && prior.execution !== outcome.record.id) throw new NetError('conflict')
      this.options.db.database.prepare('INSERT OR IGNORE INTO net_rpc_aliases(caller,id,method,payload_hash,execution) VALUES(?,?,?,?,?)').run(context.caller.node, context.id, name, payloadHash, outcome.record.id)
      this.options.db.charge(1)
      return outcome
    })
    if (outcome.kind === 'duplicate') return this.terminal(outcome.record)
    const id = outcome.record.id, controller = new AbortController()
    const abort = (): void => controller.abort()
    context.signal.addEventListener('abort', abort, { once: true })
    this.running.set(id, controller)
    try {
      this.authorize(name, context.caller)
      if (context.signal.aborted) throw new NetError('cancelled')
      this.options.executions.transition(id, 'running', this.options.clock.now())
      const returned = await method.handle(params, { ...context, signal: controller.signal })
      const result = returned === undefined ? null : returned
      canonicalJson(result)
      if (controller.signal.aborted) {
        this.options.executions.transition(id, 'uncertain', this.options.clock.now(), { error: { code: 'outcome_uncertain', message: 'Cancellation did not prove rollback.' } })
        throw new NetError('outcome_uncertain')
      }
      this.options.executions.transition(id, 'completed', this.options.clock.now(), { result })
      return result
    } catch (error) {
      const record = this.options.executions.get(id)!
      if (record.state === 'accepted') this.options.executions.transition(id, 'failed', this.options.clock.now(), { error: { code: 'cancelled', message: 'Handler did not start.' } })
      else if (record.state === 'running') {
        // A thrown handler can have made an external effect; never claim rollback.
        this.options.executions.transition(id, 'uncertain', this.options.clock.now(), { error: { code: 'outcome_uncertain', message: 'Handler outcome is not durably proven.' } })
      }
      throw record.state === 'accepted' ? error : new NetError('outcome_uncertain', undefined, { cause: error })
    } finally { context.signal.removeEventListener('abort', abort); this.running.delete(id) }
  }
  async result(id: RpcId, peer: SyncSession['peer']): Promise<unknown> {
    const alias = this.alias(id, peer)
    if (!alias) throw new NetError('outcome_uncertain')
    this.authorize(alias.method, peer)
    const record = this.options.executions.get(alias.execution as ExecutionRecord['id'])
    if (!record) throw new NetError('outcome_uncertain')
    return this.terminal(record)
  }
  async cancel(id: RpcId, peer: SyncSession['peer']): Promise<void> {
    const alias = this.alias(id, peer)
    if (!alias) throw new NetError('outcome_uncertain')
    this.authorize(alias.method, peer)
    this.running.get(alias.execution)?.abort()
    // Missing live handler is not evidence that a persisted effect was rolled back.
  }
  private alias(id: RpcId, peer: SyncSession['peer']): { method: string; payload_hash: string; execution: string } | undefined {
    return this.options.db.database.prepare('SELECT method,payload_hash,execution FROM net_rpc_aliases WHERE caller=? AND id=?').get(peer.node, id) as { method: string; payload_hash: string; execution: string } | undefined
  }
  private authorize(name: string, peer: SyncSession['peer']): RpcMethod {
    const method = this.registry.get(name), identity = this.options.identity, self = identity.self()
    if (!method || !self || peer.user !== self.user) throw new NetError('forbidden')
    const root = identity.pinnedRootKey(peer.user), signed = identity.roster(peer.user)
    if (!root || !signed || identity.rosterState(peer.user) !== 'ok') throw new NetError('roster_conflict')
    const roster = identity.verifySigned<Roster>(signed, root)
    const current = roster.nodes.map(row => identity.verifySigned<NodeDelegation>(row, root)).filter(row => row.subject === peer.node).sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
    if (!current || current.keyEpoch !== peer.delegation.keyEpoch || current.expiresAt <= this.options.clock.now() || current.issuedAt > this.options.clock.now()) throw new NetError('bad_delegation')
    if (roster.revoked.some(row => row.subject === peer.node && row.throughKeyEpoch >= current.keyEpoch)) throw new NetError('revoked')
    if (!current.caps.includes(method.capability)) throw new NetError('forbidden')
    return method
  }
  private terminal(record: ExecutionRecord): unknown {
    if (record.state === 'completed') return record.result
    if (record.state === 'failed' || record.state === 'cancelled' || record.state === 'expired') throw new NetError(isNetErrorCode(record.error?.code) ? record.error.code : 'outcome_uncertain')
    throw new NetError('outcome_uncertain')
  }
}
