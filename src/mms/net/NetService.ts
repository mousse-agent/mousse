import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import type { NodeDelegation, NodeId, Roster, RoutesRecord, Signed, StoredRecord, StreamId } from '../../shared/net'
import { NetError, NET_ERRORS, DIAL_TLS_DEADLINE_MS, NODE_CAPABILITIES, newId } from '../../shared/net'
import type { NetDoctor, NetInitInput, NetLocalMethod, NetStatus } from '../../shared/net/local'
import type { Clock, Mux, SecureChannel, SyncSession } from './contracts'
import { systemClock } from './clock'
import { NetDatabase } from './store/database'
import { SqliteStreamStore } from './store/streams'
import { SqliteExecutionLedger } from './store/executions'
import { SqliteBudgetLedger } from './store/budgets'
import { SqliteOutbox } from './store/outbox'
import { SqliteQuotaRateLedger } from './store/limits'
import { FileBlobStore } from './store/blobs'
import { FileKeyStore, NetIdentityService } from './identity'
import { DirectTransport } from './transports/direct'
import { RouteManagerImpl } from './link/routeManager'
import { openSecureChannel } from './link/secureChannel'
import { NetSyncSession } from './sync/session'
import { NodeStreamAuthority } from './sync/nodeAuthority'
import { SyncSupervisor } from './sync/supervisor'
import { DurableRpcDispatcher } from './sync/rpcDispatcher'
import { canonicalJson, parseProtocolJson } from './sync/codec'
import { EnrollmentService, EnrollmentGateway, EnrollmentQuarantine, AuthorityTransferDelivery, type AuthorityTransferStatus, type GatewayNormalContext } from './enrollment'

interface NetConfiguration {
  v: 1; enabled: boolean; direct: { enabled: boolean; host: string; port: number }; routesVersion: number
}
export interface NetRuntime {
  db: NetDatabase; keys: FileKeyStore; identity: NetIdentityService; streams: SqliteStreamStore
  executions: SqliteExecutionLedger; budgets: SqliteBudgetLedger; outbox: SqliteOutbox
  limits: SqliteQuotaRateLedger; blobs: FileBlobStore; rpc: DurableRpcDispatcher; enrollment: EnrollmentService; transfer: AuthorityTransferDelivery
}
const defaults = (): NetConfiguration => ({ v: 1, enabled: false, direct: { enabled: false, host: '127.0.0.1', port: 0 }, routesVersion: 0 })

/** One profile owns its keys, ledger, listeners and sessions. Local IPC never takes a profile path. */
export class NetService {
  private readonly clock: Clock
  private state?: NetRuntime
  private config = defaults()
  private transport?: DirectTransport
  private routes?: RouteManagerImpl
  private localSignedRoutes?: Signed
  private readonly sessions = new Set<NetSyncSession>()
  private readonly supervisors = new Map<NodeId, SyncSupervisor>()
  private readonly gateways = new Set<EnrollmentGateway | EnrollmentQuarantine>()
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly shutdownSignal = new AbortController()
  private mutation = Promise.resolve()
  private stopped = false
  private lastError?: keyof typeof NET_ERRORS
  private renewal?: { cancel(): void }
  private rosterListener?: () => void
  constructor(private readonly options: { profileDir: string; clock?: Clock; onChanged?(status: NetStatus): void }) {
    this.clock = options.clock ?? systemClock
  }
  runtime(): NetRuntime {
    if (this.stopped) throw new NetError('cancelled')
    if (this.state) return this.state
    const db = new NetDatabase({ profileDir: this.options.profileDir, clock: this.clock })
    try {
      db.transaction(() => db.database.exec('CREATE TABLE IF NOT EXISTS net_service_config(singleton INTEGER PRIMARY KEY CHECK(singleton=1),value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS net_peer_routes(node TEXT PRIMARY KEY,signed TEXT NOT NULL)'))
      const row = db.database.prepare('SELECT value FROM net_service_config WHERE singleton=1').get()
      if (row) {
        const cfg = parseProtocolJson(Buffer.from(String(row.value))) as NetConfiguration
        if (cfg.v !== 1) throw new NetError('downgrade_unsupported')
        if (typeof cfg.enabled !== 'boolean' || typeof cfg.direct?.enabled !== 'boolean' || typeof cfg.direct.host !== 'string' || !Number.isInteger(cfg.direct.port) || cfg.direct.port < 0 || cfg.direct.port > 65535 || !Number.isSafeInteger(cfg.routesVersion) || cfg.routesVersion < 0) throw new NetError('storage_corrupt')
        this.config = cfg
      }
      const keys = new FileKeyStore(this.options.profileDir)
      const identity = new NetIdentityService({ database: db.database, keys, clock: this.clock, coordinator: db })
      const streams = new SqliteStreamStore(db), executions = new SqliteExecutionLedger(db), blobs = new FileBlobStore(db)
      const enrollment = new EnrollmentService({ db, identity, keys, clock: this.clock, routes: () => this.signedRoutes() })
      const rpc = new DurableRpcDispatcher({ db, identity, executions, clock: this.clock }), transfer = new AuthorityTransferDelivery({ db, identity, keys })
      transfer.register(rpc)
      rpc.register({ method: 'authority.transfer.ready', capability: 'read', mutating: false, handle: async params => {
        if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length) throw new NetError('bad_request')
        return { protected: keys.encryptedAtRest(), unlocked: keys.state() === 'unlocked', node: identity.self()?.node }
      } })
      this.state = { db, keys, identity, streams, executions, blobs, enrollment, transfer, budgets: new SqliteBudgetLedger(db), outbox: new SqliteOutbox(db), limits: new SqliteQuotaRateLedger(db), rpc }
      this.rosterListener = identity.onRosterChanged(() => { this.emit(); if (this.routes) this.refreshPeers() })
      return this.state
    } catch (error) { db.close(); throw error }
  }
  private saveConfig(): void {
    const { db } = this.runtime(), bytes = canonicalJson(this.config)
    db.transaction(() => { db.charge(1, bytes.length); db.database.prepare('INSERT INTO net_service_config VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET value=excluded.value').run(Buffer.from(bytes).toString()) })
  }
  async start(): Promise<void> {
    if (!existsSync(join(this.options.profileDir, 'net', 'net.db'))) return
    try { this.runtime(); if (this.config.enabled) await this.activate() }
    catch (error) { this.lastError = error instanceof NetError ? error.code : 'internal'; this.emit() }
  }
  request(method: NetLocalMethod, params: Record<string, unknown>): unknown | Promise<unknown> {
    if (this.stopped) throw new NetError('cancelled')
    if (method === 'net.status') return this.status()
    if (method === 'net.doctor') return this.doctor()
    if (method === 'bridge.nodes') return this.nodes()
    if (method === 'net.authority.status') { const journal = this.requireEnrolled().identity.authorityTransferState(); return journal ? { phase: journal.phase, ...this.runtime().transfer.query() } : { phase: 'none' } }
    return this.serial(async () => {
      switch (method) {
        case 'net.protect': { const rt = this.requireEnrolled(); rt.keys.protect(params.passphrase as string | undefined); this.emit(); return this.status() }
        case 'net.unlock': { const rt = this.runtime(); await rt.keys.unlock(String(params.passphrase)); if (this.config.enabled) await this.activate(); this.emit(); return this.status() }
        case 'net.authority.transfer': return this.transferAuthority(params.node as NodeId)
        case 'net.recovery.export': return { file: Buffer.from(await this.requireEnrolled().transfer.exportRecovery(String(params.passphrase))).toString('base64url') }
        case 'net.recovery.import': { const rt = this.requireEnrolled(); await rt.transfer.recoverSameIdentity(Buffer.from(String(params.file), 'base64url'), String(params.passphrase)); this.emit(); return this.status() }
        case 'net.init': return this.init(params as NetInitInput)
        case 'bridge.invite': {
          const runtime = this.requireEnrolled(); if (!this.routes) await this.activate()
          const invite = runtime.enrollment.issueNodeInvite(params)
          return { invite: invite.text, inviteId: invite.invite, expiresAt: invite.expiresAt }
        }
        case 'bridge.join': return this.join(String(params.invite), params.name as string | undefined)
        case 'bridge.revoke': { const rt = this.requireEnrolled(); rt.identity.revoke(params.node as NodeId); this.emit(); return { ok: true } }
        case 'bridge.rename': { const rt = this.requireEnrolled(); rt.identity.renameNode(params.node as NodeId, String(params.name)); return { ok: true } }
        default: throw new NetError('bad_request')
      }
    })
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(() => { if (this.stopped) throw new NetError('cancelled'); return work() })
    this.mutation = result.then(() => {}, () => {})
    return this.track(result)
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.tasks.add(operation)
    void operation.then(() => this.tasks.delete(operation), () => this.tasks.delete(operation))
    return operation
  }
  private requireEnrolled(): NetRuntime {
    const rt = this.runtime()
    if (!rt.identity.self()) throw new NetError('not_enrolled')
    if (rt.keys.state() !== 'unlocked') throw new NetError(rt.keys.state() === 'missing' ? 'keystore_missing' : 'keystore_locked')
    return rt
  }
  private async init(input: NetInitInput): Promise<NetStatus> {
    const rt = this.runtime()
    if (!rt.identity.self()) await rt.identity.bootstrapAuthority(input.name ?? 'My device')
    this.config.enabled = true
    if (input.listen) this.config.direct = { enabled: true, host: input.host ?? this.config.direct.host, port: input.port ?? this.config.direct.port }
    this.saveConfig(); await this.activate(); return this.status()
  }
  private async activate(): Promise<void> {
    const rt = this.requireEnrolled()
    for (const supervisor of this.supervisors.values()) supervisor.close()
    this.supervisors.clear()
    for (const session of this.sessions) session.close()
    await this.transport?.teardown()
    const transport = this.transport = new DirectTransport({ ...this.config.direct, clock: this.clock })
    await transport.provision()
    this.routes = new RouteManagerImpl({ node: rt.identity.self()!.node, transports: [transport], credentials: rt.keys.tlsCredentials(), clock: this.clock, routesVersion: this.config.routesVersion })
    if (this.config.direct.enabled) {
      await transport.listen(raw => { if (!this.stopped) this.track(this.accept(raw)).catch(error => { this.lastError = error instanceof NetError ? error.code : 'internal'; this.emit() }); else raw.destroy() })
      // Preserve an automatically assigned port so a peer can reconnect after restart.
      this.config.direct.port = Number(new URL(transport.status().routes[0].address).port)
    }
    this.localSignedRoutes = undefined; this.signedRoutes(); this.lastError = undefined
    this.refreshPeers(); this.scheduleRenewal(); this.emit()
  }
  signedRoutes(): Signed {
    const rt = this.requireEnrolled()
    if (!this.routes) throw new NetError('route_unreachable')
    const record = this.routes.localRoutes()
    if (!this.localSignedRoutes || record.version !== this.config.routesVersion) {
      const signed = rt.identity.signAsNode(record)
      this.config.routesVersion = record.version; this.saveConfig(); this.localSignedRoutes = signed
    }
    return this.localSignedRoutes
  }
  private async accept(raw: Duplex): Promise<void> {
    const rt = this.requireEnrolled()
    if (this.sessions.size + this.gateways.size >= 64) { raw.destroy(); throw new NetError('rate_limited') }
    const channel = await openSecureChannel(raw, { role: 'server', credentials: rt.keys.tlsCredentials(), deadlineMs: DIAL_TLS_DEADLINE_MS, signal: this.shutdownSignal.signal })
    const gateway = new EnrollmentGateway({ channel, service: rt.enrollment, clock: this.clock,
      onEnrolled: () => this.transport?.markAuthenticated(raw),
      normalSession: (secure, mux, context) => this.makeSession(secure, mux, context, raw) })
    this.gateways.add(gateway)
    try { await gateway.completed } finally { this.gateways.delete(gateway) }
  }
  private makeSession(channel: SecureChannel, mux?: Mux, context?: GatewayNormalContext, raw?: Duplex): NetSyncSession {
    const rt = this.requireEnrolled()
    const session = new NetSyncSession({ channel, mux, ...context, identity: rt.identity, store: rt.streams, blobs: rt.blobs, rpc: rt.rpc, clock: this.clock,
      authority: new NodeStreamAuthority(rt.identity, rt.streams, rt.blobs, this.clock), localRoutes: () => this.signedRoutes(),
      onPeerRoutes: (routes, peer) => this.adoptRoutes(routes, peer.node),
      onAuthenticated: () => { if (raw) this.transport?.markAuthenticated(raw); this.routes?.markSessionOpen(channel); this.emit() } })
    this.sessions.add(session)
    session.onClosed(error => { this.sessions.delete(session); if (error instanceof NetError) this.lastError = error.code; this.emit() })
    void session.opened.then(() => { this.lastError = undefined; this.emit() }, () => {})
    return session
  }
  adoptRoutes(signed: Signed, node: NodeId): void {
    const rt = this.requireEnrolled(), self = rt.identity.self()!
    const root = rt.identity.pinnedRootKey(self.user)!, roster = rt.identity.verifySigned<Roster>(rt.identity.roster()!, root)
    const delegation = roster.nodes.map(row => rt.identity.verifySigned<NodeDelegation>(row, root)).filter(row => row.subject === node).sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
    if (!delegation) throw new NetError('bad_delegation')
    const incoming = rt.identity.verifySigned<RoutesRecord>(signed, delegation.keys.sign)
    if (incoming.node !== node || incoming.issuedAt > this.clock.now() || incoming.routes.length > 32) throw new NetError('bad_signature')
    rt.db.transaction(() => {
      const row = rt.db.database.prepare('SELECT signed FROM net_peer_routes WHERE node=?').get(node)
      if (row) {
        const prior = parseProtocolJson(Buffer.from(String(row.signed))) as Signed, document = parseProtocolJson(Buffer.from(prior.payload, 'base64url')) as RoutesRecord
        if (incoming.version < document.version) return
        if (incoming.version === document.version) { if (prior.payload !== signed.payload || prior.sig !== signed.sig) throw new NetError('conflict'); return }
      }
      const bytes = canonicalJson(signed); rt.db.charge(1, bytes.length)
      rt.db.database.prepare('INSERT INTO net_peer_routes VALUES(?,?) ON CONFLICT(node) DO UPDATE SET signed=excluded.signed').run(node, Buffer.from(bytes).toString())
    })
  }
  private refreshPeers(): void {
    if (this.stopped || !this.routes || !this.state) return
    const rt = this.state, self = rt.identity.self()!
    const root = rt.identity.pinnedRootKey(self.user)!, signed = rt.identity.roster()
    if (!signed) return
    const roster = rt.identity.verifySigned<Roster>(signed, root)
    for (const row of rt.db.database.prepare('SELECT node,signed FROM net_peer_routes').all()) {
      const node = String(row.node) as NodeId
      if (node === self.node || this.supervisors.has(node)) continue
      const current = roster.nodes.map(value => rt.identity.verifySigned<NodeDelegation>(value, root)).filter(value => value.subject === node).sort((a,b) => b.keyEpoch-a.keyEpoch || b.issuedAt-a.issuedAt)[0]
      if (!current || roster.revoked.some(value => value.subject === node && value.throughKeyEpoch >= current.keyEpoch)) continue
      const record = parseProtocolJson(Buffer.from(String(row.signed))) as Signed
      let routes: RoutesRecord
      try { routes = rt.identity.verifySigned<RoutesRecord>(record, current.keys.sign) } catch { continue }
      if (!routes.routes.length) continue
      const supervisor = new SyncSupervisor({ identity: rt.identity, clock: this.clock, connect: async signal => {
        const latest = this.currentNode(node), manager = this.routes!
        const result = await manager.connect({ node, user: self.user, transportKey: latest.keys.transport, routes: routes.routes }, signal)
        const session = this.makeSession(result.channel)
        const abort = () => session.close(); signal.addEventListener('abort', abort, { once: true })
        session.onClosed(() => signal.removeEventListener('abort', abort))
        await session.opened; return session
      } })
      this.supervisors.set(node, supervisor); supervisor.onClosed(() => this.emit())
      void supervisor.opened.then(() => this.emit(), () => {})
    }
  }
  private currentNode(node: NodeId): NodeDelegation {
    const rt = this.requireEnrolled(), roster = rt.identity.verifySigned<Roster>(rt.identity.roster()!, rt.keys.rootKey() ?? rt.identity.pinnedRootKey(rt.identity.self()!.user)!)
    const result = roster.nodes.map(row => rt.identity.verifySigned<NodeDelegation>(row, roster.rootKey)).filter(row => row.subject === node).sort((a,b) => b.keyEpoch-a.keyEpoch || b.issuedAt-a.issuedAt)[0]
    if (!result) throw new NetError('bad_delegation')
    if (roster.revoked.some(row => row.subject === node && row.throughKeyEpoch >= result.keyEpoch)) throw new NetError('revoked')
    return result
  }
  session(node: NodeId): SyncSession {
    for (const session of this.sessions) if (session.state() === 'open' && session.peer.node === node) return session
    throw new NetError('peer_offline')
  }
  async publish(stream: StreamId, record: StoredRecord): Promise<void> {
    await Promise.all([...this.sessions].filter(session => session.state() === 'open').map(session => session.publishRecord(stream, record)))
  }
  private async join(invite: string, name?: string): Promise<unknown> {
    const rt = this.runtime(), prepared = await rt.enrollment.prepareNodeJoin(invite, name)
    if (prepared.state !== 'enrolled') {
      const transport = new DirectTransport({ clock: this.clock }); await transport.provision()
      const manager = new RouteManagerImpl({ node: prepared.node, transports: [transport], credentials: rt.keys.tlsCredentials(), clock: this.clock })
      const routes = parseProtocolJson(Buffer.from(prepared.routes.payload, 'base64url')) as RoutesRecord
      try {
        const result = await manager.connect({ node: prepared.authority, user: prepared.user, transportKey: prepared.authorityTransportKey, routes: routes.routes }, this.shutdownSignal.signal)
        const quarantine = new EnrollmentQuarantine({ channel: result.channel, service: rt.enrollment, role: 'joiner', clock: this.clock })
        this.gateways.add(quarantine)
        try { await quarantine.completed } finally { this.gateways.delete(quarantine); quarantine.close() }
      } finally { await transport.teardown() }
    }
    this.config.enabled = true; this.saveConfig(); await this.activate()
    this.adoptRoutes(prepared.routes, prepared.authority); this.refreshPeers()
    const authority = this.supervisors.get(prepared.authority)
    if (authority) await authority.opened
    return { user: prepared.user, node: prepared.node, authority: prepared.authority }
  }
  private async transferAuthority(node: NodeId): Promise<unknown> {
    const rt = this.requireEnrolled()
    let journal = rt.identity.authorityTransferState()
    if (journal) {
      const offer = parseProtocolJson(Buffer.from(journal.offer.payload, 'base64url')) as { to: NodeId }
      if (offer.to !== node) throw new NetError('conflict')
    } else {
      const ready = await this.session(node).rpc('authority.transfer.ready', {}, { id: newId('rpc'), deadlineMs: 10000 }) as { protected?: boolean; unlocked?: boolean; node?: NodeId }
      if (ready.node !== node || ready.protected !== true || ready.unlocked !== true) throw new NetError('keystore_locked')
      await rt.transfer.prepare(node)
      journal = rt.identity.authorityTransferState()!
    }
    const query = rt.transfer.query()
    const readStatus = async (): Promise<AuthorityTransferStatus> => {
      try { return await this.session(node).rpc('authority.transfer.ack', query, { id: newId('rpc'), deadlineMs: 10000 }) as AuthorityTransferStatus }
      catch (cause) { throw new NetError('outcome_uncertain', undefined, { cause }) }
    }
    if (journal.phase !== 'finalized') {
      let ack: Signed | undefined
      try {
        // Resolve a usable pinned session before durably claiming the once-only send.
        const session = this.session(node), request = await rt.transfer.takeImportRequest()
        ack = await session.rpc(request.method, request.params, { id: request.id, idem: request.idem, deadlineMs: 30000 }) as Signed
      } catch (error) {
        if (!(error instanceof NetError) || !['outcome_uncertain', 'route_unreachable', 'peer_offline', 'deadline_exceeded', 'cancelled'].includes(error.code)) throw error
        ack = (await readStatus()).ack
      }
      if (!ack) throw new NetError('outcome_uncertain')
      rt.transfer.retire(ack)
    }
    let activated: AuthorityTransferStatus
    try {
      const session = this.session(node), request = rt.transfer.takeActivationRequest()
      activated = await session.rpc(request.method, request.params, { id: request.id, idem: request.idem, deadlineMs: 30000 }) as AuthorityTransferStatus
    } catch (error) {
      if (!(error instanceof NetError) || !['outcome_uncertain', 'route_unreachable', 'peer_offline', 'deadline_exceeded', 'cancelled'].includes(error.code)) throw error
      activated = await readStatus()
    }
    if (activated.phase !== 'activated') throw new NetError('outcome_uncertain')
    this.emit(); return { ...query, phase: 'activated', authority: node }
  }
  private scheduleRenewal(): void {
    this.renewal?.cancel()
    this.renewal = this.clock.setTimeout(() => {
      if (this.stopped) return
      try { this.state?.identity.renewExpiring(this.clock.now()) } catch (error) { this.lastError = error instanceof NetError ? error.code : 'internal'; this.emit() }
      this.scheduleRenewal()
    }, 60 * 60 * 1000)
  }
  status(): NetStatus {
    if (!this.state && !existsSync(join(this.options.profileDir, 'net', 'net.db'))) return { enabled: false, keystore: 'missing', routes: [], peers: [] }
    try {
      const rt = this.runtime(), self = rt.identity.self()
      const peers = new Map<NodeId, NetStatus['peers'][number]>()
      for (const [node, supervisor] of this.supervisors) peers.set(node, { node, state: supervisor.state() === 'open' ? 'open' : supervisor.state() === 'connecting' ? 'connecting' : 'closed' })
      for (const session of this.sessions) if (session.state() === 'open') peers.set(session.peer.node, { node: session.peer.node, state: 'open' })
      return { enabled: this.config.enabled, keystore: rt.keys.state(), protected: rt.keys.encryptedAtRest(), ...(self ? { self, rosterState: rt.identity.rosterState(self.user) } : {}), routes: this.transport?.status().routes ?? [], peers: [...peers.values()], ...(this.lastError ? { error: this.lastError } : {}) }
    } catch (error) { return { enabled: false, keystore: 'unavailable', routes: [], peers: [], error: error instanceof NetError ? error.code : 'internal' } }
  }
  private nodes(): unknown {
    const rt = this.requireEnrolled(), roster = rt.identity.verifySigned<Roster>(rt.identity.roster()!, rt.identity.pinnedRootKey(rt.identity.self()!.user)!)
    const current = new Map<NodeId, NodeDelegation>()
    for (const signed of roster.nodes) { const node = rt.identity.verifySigned<NodeDelegation>(signed, roster.rootKey), old = current.get(node.subject); if (!old || node.keyEpoch > old.keyEpoch || (node.keyEpoch === old.keyEpoch && node.issuedAt > old.issuedAt)) current.set(node.subject, node) }
    return { nodes: [...current.values()].map(node => ({ node: node.subject, name: node.name, caps: node.caps.filter(cap => NODE_CAPABILITIES.includes(cap)), keyEpoch: node.keyEpoch, expiresAt: node.expiresAt, self: node.subject === rt.identity.self()!.node, revoked: roster.revoked.some(row => row.subject === node.subject && row.throughKeyEpoch >= node.keyEpoch), state: this.status().peers.find(peer => peer.node === node.subject)?.state ?? 'closed' })) }
  }
  private doctor(): NetDoctor {
    const status = this.status()
    const checks: NetDoctor['checks'] = [
      { name: 'identity', ok: !!status.self, ...(status.self ? {} : { code: 'not_enrolled' as const }), message: status.self ? 'Network identity is initialized.' : NET_ERRORS.not_enrolled.message },
      { name: 'keys', ok: status.keystore === 'unlocked', ...(status.keystore === 'unlocked' ? {} : { code: 'keystore_locked' as const }), message: status.keystore === 'unlocked' ? 'The key store is unlocked.' : NET_ERRORS.keystore_locked.message },
      { name: 'roster', ok: status.rosterState === 'ok', ...(status.rosterState === 'conflict' ? { code: 'roster_conflict' as const } : {}), message: status.rosterState === 'ok' ? 'The adopted roster is consistent.' : 'No usable roster is adopted.' },
      { name: 'direct', ok: !this.config.direct.enabled || !!status.routes.length, message: this.config.direct.enabled ? (status.routes.length ? 'The direct listener has an advertised route.' : 'The direct listener has no route.') : 'The direct listener is disabled.' }
    ]
    if (status.error) checks.push({ name: 'service', ok: false, code: status.error, message: NET_ERRORS[status.error].message })
    return { ok: checks.every(check => check.ok), checks }
  }
  private emit(): void { this.options.onChanged?.(this.status()) }
  getActiveCount(): number { return this.tasks.size }
  beginShutdown(): void {
    if (this.stopped) return
    this.stopped = true; this.shutdownSignal.abort(); this.renewal?.cancel(); this.rosterListener?.()
    for (const gateway of this.gateways) gateway.close()
    for (const supervisor of this.supervisors.values()) supervisor.close()
    for (const session of this.sessions) session.close()
  }
  async shutdown(): Promise<void> {
    this.beginShutdown(); await this.transport?.teardown(); await Promise.allSettled([...this.tasks])
    this.state?.streams.close(); this.state?.blobs.close(); this.state?.db.close()
    this.sessions.clear(); this.supervisors.clear(); this.gateways.clear()
  }
}
