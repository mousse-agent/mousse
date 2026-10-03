import { createHash, randomBytes } from 'node:crypto'
import type { NodeId, Roster, RpcId, Signed } from '../../../shared/net'
import { NetError, newId } from '../../../shared/net'
import type { RpcContext, RpcDispatcher, RpcMethod } from '../contracts'
import { FileKeyStore, NetIdentityService } from '../identity'
import type { AuthorityTransferOffer } from '../identity/NetIdentityService'
import { decodeBase64 } from '../identity/crypto'
import { canonicalJson, parseProtocolJson } from '../sync/codec'
import type { EnrollmentDatabase } from './service'

export interface AuthorityTransferPacket { offer: Signed; successor: Signed; recovery: string }
export interface AuthorityTransferQuery { transfer: string; offerHash: string }
export interface AuthorityTransferImport { packet: AuthorityTransferPacket; passphrase: string }
export interface AuthorityTransferActivation extends AuthorityTransferQuery { successor: Signed; retirement: Signed }
export interface AuthorityTransferRequest<T> { id: RpcId; idem: string; method: string; params: T }
export interface AuthorityTransferStatus { phase: string; ack?: Signed; retirement?: Signed; successor: Signed }
const hash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('base64url')
const claims = (offer: Signed): AuthorityTransferOffer => parseProtocolJson(decodeBase64(offer.payload)) as AuthorityTransferOffer

/** Protected delivery hooks for the existing authenticated same-user TLS RPC dispatcher.
 * A caller obtains each mutating request ONCE, journals it before transmission, and after an
 * ambiguous response uses fresh read-only status queries. It must never persist raw params.
 */
export class AuthorityTransferDelivery {
  constructor(private readonly options: { db: EnrollmentDatabase; identity: NetIdentityService; keys: FileKeyStore }) {
    options.db.transaction(() => options.db.database.exec('CREATE TABLE IF NOT EXISTS net_authority_delivery(transfer TEXT PRIMARY KEY, recipient TEXT NOT NULL, import_rpc TEXT, activation_rpc TEXT) STRICT'))
  }
  private protected(): void {
    if (this.options.db.database.isTransaction) throw new NetError('forbidden', 'Protected delivery requires an independent committed operation.')
    if (!this.options.keys.encryptedAtRest() || this.options.keys.state() !== 'unlocked') throw new NetError('keystore_locked', 'Protect and unlock this profile before authority transfer.')
  }
  private secret(transfer: string): string { return `authority-transfer/${transfer}/passphrase` }
  /** Local-owner recovery keeps the pinned root and creates a higher recovery epoch. */
  async recoverSameIdentity(file: Uint8Array, passphrase: string): Promise<Signed> {
    this.protected()
    const { identity, keys } = this.options, self = identity.self()
    if (!self) throw new NetError('not_enrolled')
    if (keys.inspectRecoveryRoot(file, passphrase) !== identity.pinnedRootKey(self.user)) throw new NetError('bad_delegation', 'Recovery root differs from the pinned identity.')
    await keys.importRecovery(file, passphrase)
    return identity.becomeAuthorityFromRecovery()
  }
  async exportRecovery(passphrase: string): Promise<Uint8Array> {
    this.protected()
    if (!this.options.identity.self()?.isAuthority) throw new NetError('forbidden')
    return this.options.keys.exportRecovery(passphrase)
  }
  async prepare(to: NodeId): Promise<AuthorityTransferQuery> {
    this.protected()
    const { identity, keys, db } = this.options
    const initial = identity.prepareTransfer(to), body = claims(initial)
    let pass = keys.getSecret(this.secret(body.transfer))
    if (!pass) { pass = randomBytes(32); keys.putSecret(this.secret(body.transfer), pass) }
    try {
      const packet = await identity.exportTransfer(Buffer.from(pass).toString('base64url'))
      db.transaction(() => { db.database.prepare('INSERT OR IGNORE INTO net_authority_delivery(transfer,recipient) VALUES(?,?)').run(body.transfer, to); db.charge?.(1) })
      return { transfer: body.transfer, offerHash: hash(packet.offer) }
    } finally { pass.fill(0) }
  }
  query(): AuthorityTransferQuery {
    const journal = this.options.identity.authorityTransferState()
    if (!journal) throw new NetError('forbidden')
    return { transfer: claims(journal.offer).transfer, offerHash: hash(journal.offer) }
  }
  /** The durable attempted flag is committed before secret-bearing params leave this method. */
  async takeImportRequest(): Promise<AuthorityTransferRequest<AuthorityTransferImport>> {
    this.protected()
    const query = this.query(), { keys, identity } = this.options
    const secret = keys.getSecret(this.secret(query.transfer))
    if (!secret) throw new NetError('storage_corrupt', 'Missing protected transfer credential.')
    try {
      const passphrase = Buffer.from(secret).toString('base64url'), exported = await identity.exportTransfer(passphrase)
      const id = this.claimMutation(query.transfer, 'import_rpc')
      return { id, idem: `authority-import/${query.transfer}`, method: 'authority.transfer.import', params: { packet: { offer: exported.offer, successor: exported.successor, recovery: Buffer.from(exported.recovery).toString('base64url') }, passphrase } }
    } finally { secret.fill(0) }
  }
  /** Local owner finalization is recoverable; it commits retirement before deleting root material. */
  retire(ack: Signed): AuthorityTransferActivation {
    const { identity, keys } = this.options, journal = identity.authorityTransferState()
    if (!journal) throw new NetError('forbidden')
    const body = claims(journal.offer)
    if (journal.phase !== 'finalized') identity.acceptTransferAck(ack)
    const successor = identity.transferAuthority(body.to), retirement = identity.transferRetirement()
    keys.deleteSecret(this.secret(body.transfer))
    return { ...this.query(), successor, retirement }
  }
  takeActivationRequest(): AuthorityTransferRequest<AuthorityTransferActivation> {
    const journal = this.options.identity.authorityTransferState()
    if (!journal?.retirement || journal.phase !== 'finalized') throw new NetError('forbidden')
    const query = this.query(), id = this.claimMutation(query.transfer, 'activation_rpc')
    return { id, idem: `authority-activate/${query.transfer}`, method: 'authority.transfer.activate', params: { ...query, successor: journal.successor, retirement: journal.retirement } }
  }
  private claimMutation(transfer: string, column: 'import_rpc' | 'activation_rpc'): RpcId {
    const { db } = this.options
    if (db.database.isTransaction) throw new NetError('forbidden', 'Outgoing request markers must commit independently before transmission.')
    return db.transaction(() => {
      const row = db.database.prepare(`SELECT ${column} AS id FROM net_authority_delivery WHERE transfer=?`).get(transfer)
      if (!row) throw new NetError('storage_corrupt')
      if (row.id) throw new NetError('outcome_uncertain', 'This mutation was already offered for transmission; query the peer journal.')
      const id = newId('rpc'); db.database.prepare(`UPDATE net_authority_delivery SET ${column}=? WHERE transfer=?`).run(id, transfer); db.charge?.(1); return id
    })
  }
  register(dispatcher: RpcDispatcher): void { for (const method of this.methods()) dispatcher.register(method) }
  methods(): RpcMethod[] {
    return [
      { method: 'authority.transfer.import', capability: 'write', mutating: true, handle: async (params, context) => {
        this.protected(); this.authorizeSource(context)
        const input = params as AuthorityTransferImport
        if (!input || Object.keys(input).sort().join(',') !== 'packet,passphrase' || typeof input.passphrase !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.passphrase) || !input.packet || Object.keys(input.packet).sort().join(',') !== 'offer,recovery,successor') throw new NetError('bad_request')
        const recovery = decodeBase64(input.packet.recovery)
        if (recovery.length > 16384) throw new NetError('too_large')
        // Verify identity, recipient and blob before touching the profile's root slot.
        const self = this.options.identity.self()!, root = this.options.identity.pinnedRootKey(self.user)!
        const roster = this.options.identity.verifySigned<Roster>(this.options.identity.roster()!, root)
        const source = roster.nodes.map(row => this.options.identity.verifySigned<import('../../../shared/net').NodeDelegation>(row, root)).find(row => row.subject === context.caller.node && row.keyEpoch === context.caller.delegation.keyEpoch)
        if (!source) throw new NetError('bad_delegation')
        const offer = this.options.identity.verifySigned<AuthorityTransferOffer>(input.packet.offer, source.keys.sign)
        if (offer.to !== self.node || offer.user !== self.user || offer.from !== context.caller.node || offer.blobHash !== createHash('sha256').update(recovery).digest('base64url')) throw new NetError('bad_delegation')
        if (this.options.keys.inspectRecoveryRoot(recovery, input.passphrase) !== root) throw new NetError('bad_delegation', 'Recovery root differs from the pinned identity.')
        return this.options.identity.importTransfer({ ...input.packet, recovery }, input.passphrase)
      } },
      { method: 'authority.transfer.ack', capability: 'read', mutating: false, handle: async (params, context) => this.status(params, context, 'source') },
      { method: 'authority.transfer.retirement', capability: 'read', mutating: false, handle: async (params, context) => this.status(params, context, 'recipient') },
      { method: 'authority.transfer.activate', capability: 'write', mutating: true, handle: async (params, context) => {
        const input = params as AuthorityTransferActivation
        this.status({ transfer: input?.transfer, offerHash: input?.offerHash }, context, 'source')
        if (!input || Object.keys(input).sort().join(',') !== 'offerHash,retirement,successor,transfer') throw new NetError('bad_request')
        this.options.identity.activateTransfer(input.successor, input.retirement)
        return this.status({ transfer: input.transfer, offerHash: input.offerHash }, context, 'source')
      } }
    ]
  }
  private authorizeSource(context: RpcContext): void {
    const identity = this.options.identity, self = identity.self()
    if (!self || context.caller.user !== self.user || identity.rosterState(self.user) !== 'ok') throw new NetError('forbidden')
    const roster = identity.verifySigned<Roster>(identity.roster()!, identity.pinnedRootKey(self.user)!)
    if (context.caller.node !== roster.authorityNode || context.caller.node === self.node) throw new NetError('forbidden')
  }
  private status(params: unknown, context: RpcContext, caller: 'source' | 'recipient'): AuthorityTransferStatus {
    const query = params as AuthorityTransferQuery, journal = this.options.identity.authorityTransferState(), self = this.options.identity.self()
    if (!query || Object.keys(query).sort().join(',') !== 'offerHash,transfer' || !journal || !self || context.caller.user !== self.user) throw new NetError('forbidden')
    const body = claims(journal.offer)
    if (query.transfer !== body.transfer || query.offerHash !== hash(journal.offer) || context.caller.node !== (caller === 'source' ? body.from : body.to)) throw new NetError('forbidden')
    return { phase: journal.phase, successor: journal.successor, ...(journal.ack ? { ack: journal.ack } : {}), ...(journal.retirement ? { retirement: journal.retirement } : {}) }
  }
}
