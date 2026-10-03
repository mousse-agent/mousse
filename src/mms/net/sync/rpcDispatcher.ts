import { createHash } from 'node:crypto'
import type { NodeCapability, NodeDelegation, Roster, RpcId } from '../../../shared/net'
import { NetError, isNetErrorCode } from '../../../shared/net/errors'
import type { Clock, ExecutionLedger, ExecutionRecord, RpcContext, RpcDispatcher, RpcMethod, SyncSession } from '../contracts'
import type { NetDatabase } from '../store/database'
import { canonicalJson } from './codec'
import type { SessionRpcPort } from './session'

/** Durable request aliases share the execution ledger's database/transaction manager. */
export class DurableRpcDispatcher implements RpcDispatcher, SessionRpcPort {
  private registry = new Map<string, RpcMethod>()
  private running = new Map<string, AbortController>()
  private resultPublisher?: (result: unknown, context: RpcContext, method: RpcMethod) => { result: unknown; commit(): void }
  constructor(private readonly options: {
    db: NetDatabase
    executions: ExecutionLedger
    identity: import('../contracts').IdentityService
    clock: Clock
  }) {
    options.db.database.exec('CREATE TABLE IF NOT EXISTS net_rpc_aliases(caller TEXT NOT NULL,id TEXT NOT NULL,method TEXT NOT NULL,payload_hash TEXT NOT NULL,execution TEXT NOT NULL,PRIMARY KEY(caller,id)) STRICT')
    if (!options.db.database.prepare('PRAGMA table_info(net_rpc_aliases)').all().some(row => row.name === 'capability')) options.db.database.exec('ALTER TABLE net_rpc_aliases ADD COLUMN capability TEXT')
  }
  register(method: RpcMethod): void {
    if (this.registry.has(method.method)) throw new NetError('conflict')
    this.registry.set(method.method, method)
  }
  methods(): string[] { return [...this.registry.keys()].sort() }
  methodInfo(name: string): RpcMethod | undefined { return this.registry.get(name) }
  setResultPublisher(publish: NonNullable<DurableRpcDispatcher['resultPublisher']>): void {
    if (this.resultPublisher) throw new NetError('conflict')
    this.resultPublisher = publish
  }
  authorizedMethod(name: string, peer: SyncSession['peer']): RpcMethod { return this.authorize(name, peer) }
  originalRequest(id: RpcId, peer: SyncSession['peer'], method: string): RpcId | undefined {
    const alias = this.alias(id, peer)
    if (!alias) return undefined
    if (alias.method !== method) throw new NetError('conflict')
    this.authorize(method, peer)
    return this.options.db.database.prepare('SELECT id FROM net_rpc_aliases WHERE caller=? AND execution=? ORDER BY rowid LIMIT 1').get(peer.node, alias.execution)?.id as RpcId | undefined
  }
  request(message: Parameters<SessionRpcPort['request']>[0], peer: SyncSession['peer'], signal: AbortSignal, progress: (data: unknown) => void): Promise<unknown> {
    return this.dispatch(message.method, message.params, message.idem, { id: message.id, caller: peer, signal, deadlineAt: this.options.clock.now() + message.deadlineMs, progress })
  }
  async dispatch(name: string, params: unknown, idem: string | undefined, context: RpcContext): Promise<unknown> {
    const method = this.registry.get(name)
    if (!method) throw new NetError('forbidden')
    params = method.validate ? method.validate(params) : params
    const capability = method.capabilityFor?.(params) ?? method.capability
    this.authorize(name, context.caller, capability)
    method.authorize?.(params, context)
    if (method.mutating && (!idem || idem.length > 256)) throw new NetError('bad_request', 'Mutations need durable idempotency.')
    if (context.signal.aborted) throw new NetError('cancelled')
    const payloadHash = createHash('sha256').update(canonicalJson({ method: name, params })).digest('hex')
    const outcome = this.options.db.transaction(() => {
      const prior = this.alias(context.id, context.caller)
      if (prior && (prior.method !== name || prior.payload_hash !== payloadHash)) throw new NetError('conflict')
      const outcome = this.options.executions.admit({ scope: context.caller.node, target: name, trigger: idem ?? context.id }, payloadHash, this.options.clock.now())
      if (prior && prior.execution !== outcome.record.id) throw new NetError('conflict')
      this.options.db.database.prepare('INSERT OR IGNORE INTO net_rpc_aliases(caller,id,method,payload_hash,execution,capability) VALUES(?,?,?,?,?,?)').run(context.caller.node, context.id, name, payloadHash, outcome.record.id, capability)
      this.options.db.charge(1)
      return outcome
    })
    if (outcome.kind === 'duplicate') return this.terminal(outcome.record)
    const id = outcome.record.id, controller = new AbortController()
    const abort = (): void => controller.abort()
    context.signal.addEventListener('abort', abort, { once: true })
    this.running.set(id, controller)
    try {
      this.authorize(name, context.caller, capability)
      method.authorize?.(params, context)
      if (context.signal.aborted) throw new NetError('cancelled')
      this.options.executions.transition(id, 'running', this.options.clock.now())
      const returned = await method.handle(params, { ...context, signal: controller.signal })
      let result: unknown = returned === undefined ? null : returned
      const bytes = canonicalJson(result)
      if (controller.signal.aborted) {
        this.options.executions.transition(id, 'uncertain', this.options.clock.now(), { error: { code: 'outcome_uncertain', message: 'Cancellation did not prove rollback.' } })
        throw new NetError('outcome_uncertain')
      }
      this.authorize(name, context.caller, capability)
      let publication: { result: unknown; commit(): void } | undefined
      if (bytes.byteLength > 63 * 1024) {
        if (!this.resultPublisher) throw new NetError('too_large', 'Large RPC results require an authorized artifact publisher.')
        publication = this.resultPublisher(result, context, method)
        result = publication.result
        if (canonicalJson(result).byteLength > 63 * 1024) throw new NetError('too_large')
      }
      this.options.executions.transition(id, 'completed', this.options.clock.now(), { result }, () => publication?.commit())
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
    this.running.get(alias.execution)?.abort()
    // Missing live handler is not evidence that a persisted effect was rolled back.
  }
  private alias(id: RpcId, peer: SyncSession['peer']): { method: string; payload_hash: string; execution: string; capability?: NodeCapability } | undefined {
    return this.options.db.database.prepare('SELECT method,payload_hash,execution,capability FROM net_rpc_aliases WHERE caller=? AND id=?').get(peer.node, id) as { method: string; payload_hash: string; execution: string; capability?: NodeCapability } | undefined
  }
  private authorize(name: string, peer: SyncSession['peer'], capability?: NodeCapability): RpcMethod {
    const method = this.registry.get(name), identity = this.options.identity, self = identity.self()
    if (!method || !self || peer.user !== self.user) throw new NetError('forbidden')
    const root = identity.pinnedRootKey(peer.user), signed = identity.roster(peer.user)
    if (!root || !signed || identity.rosterState(peer.user) !== 'ok') throw new NetError('roster_conflict')
    const roster = identity.verifySigned<Roster>(signed, root)
    const current = roster.nodes.map(row => identity.verifySigned<NodeDelegation>(row, root)).filter(row => row.subject === peer.node).sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
    if (!current || current.keyEpoch !== peer.delegation.keyEpoch || current.expiresAt <= this.options.clock.now() || current.issuedAt > this.options.clock.now()) throw new NetError('bad_delegation')
    if (roster.revoked.some(row => row.subject === peer.node && row.throughKeyEpoch >= current.keyEpoch)) throw new NetError('revoked')
    if (!current.caps.includes(capability ?? method.capability)) throw new NetError('forbidden')
    return method
  }
  private terminal(record: ExecutionRecord): unknown {
    if (record.state === 'completed') return record.result
    if (record.state === 'failed' || record.state === 'cancelled' || record.state === 'expired') throw new NetError(isNetErrorCode(record.error?.code) ? record.error.code : 'outcome_uncertain')
    throw new NetError('outcome_uncertain')
  }
}
