import { DatabaseSync } from 'node:sqlite'
import type { IdentityService, MetaState, StreamStore, SyncSession, VerifiedAuthor } from '../net/contracts'
import type { NetRuntime } from '../net/NetService'
import { NetIdentityService } from '../net/identity'
import { canonicalJson, decodeEnvelope } from '../net/sync/codec'
import { isId, NetError, spaceMetaStream, type BotId, type Envelope, type PresenceMessage, type Roster, type Signed, type SpaceId, type StreamDescriptor, type StreamHead, type UserId } from '../../shared/net'
import type { AdmissionInput } from '../bots/admission'
import type { MetaProjection, SpaceHostService } from './host'

interface CurrentRequest { space: SpaceId; user: UserId; metaHead: StreamHead }
type Purpose = 'admission' | 'presence' | 'presenceDisplay' | 'private'
type ProofSession = SyncSession & { spaceIdentity?(space: SpaceId, user: UserId, head: StreamHead, options?: { signal?: AbortSignal }): Promise<Signed> }
interface FreshProof { state: string; root: string; host: string; head: StreamHead; at: number; session?: SyncSession }
export interface SpaceCurrentIdentityOptions {
  runtime: Pick<NetRuntime, 'db' | 'identity' | 'keys'>
  store: StreamStore
  meta: MetaProjection
  host: Pick<SpaceHostService, 'canRead'>
  session(space: SpaceId): SyncSession | undefined
  /** Retain the original validated public document for history verification only. */
  retainHistoryRoster?(signed: Signed): void
}

/** Current proof is explicitly requested from the current Space authority.
 * Historical roster delivery never populates this cache or profile identity.
 */
export class SpaceCurrentIdentity {
  private readonly fresh = new Map<string, FreshProof>()
  private readonly pending = new Map<string, Promise<void>>()
  private stopped = false
  private readonly dispose: () => void
  readonly source = {
    get: (request: CurrentRequest, peer: SyncSession['peer']): Signed => this.sourceRoster(request, peer),
    revalidate: (request: CurrentRequest, roster: Signed, peer: SyncSession['peer']): void => {
      if (this.sourceRoster(request, peer).payload !== roster.payload) throw new NetError('meta_stale')
    }
  }
  constructor(readonly options: SpaceCurrentIdentityOptions) {
    options.runtime.db.transaction(() => options.runtime.db.database.exec(`CREATE TABLE IF NOT EXISTS net_space_current_identity(
      space TEXT NOT NULL,user TEXT NOT NULL,root TEXT NOT NULL,state TEXT NOT NULL,bytes INTEGER NOT NULL,
      PRIMARY KEY(space,user)) STRICT`))
    this.dispose = options.runtime.identity.onRosterChanged(user => this.invalidate(user))
  }
  invalidate(user: UserId): void { for (const key of this.fresh.keys()) if (key.split('/')[1] === user) this.fresh.delete(key) }
  close(): void { this.stopped = true; this.dispose(); this.fresh.clear() }
  activeCount(): number { return this.pending.size }
  async prepareAdmission(input: AdmissionInput): Promise<void> {
    const descriptor = this.options.store.getStream(input.stream), envelope = decodeEnvelope(input.record.envelope).envelope
    if (!descriptor?.space || !envelope.author.user || envelope.author.bot || envelope.stream !== input.stream) throw new NetError('forbidden')
    await this.prepare(descriptor.space, envelope.author.user, 'admission')
  }
  verifyMentionAuthor(input: AdmissionInput, descriptor: StreamDescriptor, envelope: Envelope): { author: VerifiedAuthor; rootKey: string } {
    if (!descriptor.space || descriptor.id !== input.stream || envelope.stream !== input.stream || !envelope.author.user || envelope.author.bot) throw new NetError('forbidden')
    const stored = this.options.store.getById(input.stream, envelope.id)
    if (!stored || stored.epoch !== input.record.epoch || stored.seq !== input.record.seq || stored.recvTs !== input.record.recvTs ||
      !Buffer.from(stored.envelope).equals(input.record.envelope) || !Buffer.from(stored.sig).equals(input.record.sig)) throw new NetError('forbidden')
    const proof = this.current(descriptor.space, envelope.author.user, 'admission')
    return { author: this.withIdentity(proof.state, identity => identity.verifyAuthor(envelope.author, input.record.envelope, input.record.sig, envelope.ts, 'newWork')), rootKey: proof.root }
  }
  async preparePresence(space: SpaceId, bot: BotId): Promise<void> {
    const meta = this.state(space), registered = meta.bots.get(bot)
    if (!registered) throw new NetError('forbidden')
    await this.prepare(space, registered.owner, 'presence')
    if (registered.owner !== meta.descriptor.owner) await this.prepare(space, meta.descriptor.owner, 'presence')
  }
  async preparePrivateAudience(space: SpaceId, participants: Array<UserId | BotId>): Promise<void> {
    if (participants.length > 256) throw new NetError('too_large')
    const meta = this.state(space), users = new Set<UserId>()
    for (const participant of participants) {
      if (isId('user', participant)) {
        if (!meta.members.has(participant)) throw new NetError('not_member')
        users.add(participant)
      } else {
        const bot = meta.bots.get(participant as BotId)
        if (!bot || !participants.includes(bot.owner)) throw new NetError('forbidden')
        users.add(bot.owner)
      }
    }
    for (const user of users) {
      try { this.currentPrivateRoster(space, user) }
      catch (error) { if (!(error instanceof NetError) || error.code !== 'meta_stale') throw error; await this.prepare(space, user, 'private') }
    }
  }
  currentPrivateRoster(space: SpaceId, user: UserId): Signed {
    const meta = this.state(space), member = meta.members.get(user), identity = this.options.runtime.identity
    if (!member) throw new NetError('not_member')
    const pin = identity.pinnedRootKey(user)
    if (pin) {
      if (pin !== member.rootKey) throw new NetError('conflict')
      if (identity.rosterState(user) !== 'ok') throw new NetError('roster_conflict')
      const adopted = identity.roster(user)
      if (!adopted) throw new NetError('bad_delegation')
      return adopted
    }
    const proof = this.current(space, user, 'private')
    return this.withIdentity(proof.state, scoped => {
      if (scoped.rosterState(user) !== 'ok') throw new NetError('roster_conflict')
      const roster = scoped.roster(user)
      if (!roster) throw new NetError('bad_delegation')
      return roster
    })
  }
  /** Only the presence validator receives this scoped current view. */
  presenceIdentity(space: SpaceId): IdentityService {
    return this.scopedPresenceIdentity(space, 'presence')
  }
  /** Accepted display freshness is separate from permission to accept a packet. */
  presenceDisplayIdentity(space: SpaceId): IdentityService {
    return this.scopedPresenceIdentity(space, 'presenceDisplay')
  }
  recordVerifiedPresence(message: PresenceMessage): void {
    const descriptor = this.options.store.getStream(message.stream)
    if (!descriptor?.space || descriptor.kind !== 'space.channel') throw new NetError('forbidden')
    const meta = this.state(descriptor.space), bot = meta.bots.get(message.subject as BotId)
    if (!bot || meta.channels.get(message.stream)?.archived !== false) throw new NetError('forbidden')
    const { sig, ...unsigned } = message
    const author = this.presenceIdentity(descriptor.space).verifyAuthor({ bot: message.subject as BotId, node: bot.delegation.hostNode, keyEpoch: bot.delegation.keyEpoch }, canonicalJson(unsigned), Buffer.from(sig, 'base64url'), message.ts, 'newWork')
    const seen = this.options.runtime.db.database.prepare('SELECT counter FROM net_bot_presence_seen WHERE bot=? AND key_epoch=?').get(message.subject, bot.delegation.keyEpoch)
    if (author.kind !== 'bot' || author.verifyOnly || author.revoked || author.user !== bot.owner || author.delegation.keys.sign !== bot.delegation.keys.sign || !seen || Number(seen.counter) !== message.counter) throw new NetError('forbidden')
    for (const user of new Set([bot.owner, meta.descriptor.owner])) {
      const proof = this.current(descriptor.space, user, 'presence')
      if (this.fresh.size >= 256 && !this.fresh.has(`${descriptor.space}/${user}/presenceDisplay`)) this.fresh.delete(this.fresh.keys().next().value!)
      this.fresh.set(`${descriptor.space}/${user}/presenceDisplay`, { ...proof, at: this.options.runtime.db.clock.monotonic() })
    }
  }
  private scopedPresenceIdentity(space: SpaceId, purpose: 'presence' | 'presenceDisplay'): IdentityService {
    const original = this.options.runtime.identity
    const proof = (user: UserId): FreshProof => this.current(space, user, purpose)
    return new Proxy(original, { get: (target, name) => {
      if (name === 'pinnedRootKey') return (user: UserId) => proof(user).root
      if (name === 'roster') return (user?: UserId) => user ? this.withIdentity(proof(user).state, identity => identity.roster(user)) : original.roster()
      if (name === 'rosterState') return (user: UserId) => this.withIdentity(proof(user).state, identity => identity.rosterState(user))
      if (name === 'verifyAuthor') return (...args: Parameters<IdentityService['verifyAuthor']>) => {
        if (args[4] !== 'newWork') return original.verifyAuthor(...args)
        const owner = args[0].user ?? (args[0].bot ? this.state(space).bots.get(args[0].bot)?.owner : undefined)
        if (!owner) throw new NetError('bad_delegation')
        const verified = this.withIdentity(proof(owner).state, identity => identity.verifyAuthor(...args))
        // The accepted display view cannot accidentally become an admission or
        // packet-verification port: both reject verify-only authors.
        return purpose === 'presenceDisplay' ? { ...verified, verifyOnly: true } : verified
      }
      const value = Reflect.get(target, name)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }
  private state(space: SpaceId, head?: StreamHead): MetaState {
    if (this.stopped) throw new NetError('cancelled')
    const meta = this.options.meta.state(space), descriptor = this.options.store.getStream(spaceMetaStream(space))
    if (!meta || !descriptor || meta.frozen || meta.upgradeRequired || descriptor.authority !== meta.descriptor.hostNode) throw new NetError('forbidden')
    const stored = this.options.store.head(descriptor.id)
    if (stored.epoch !== meta.applied.epoch || stored.seq !== meta.applied.seq || head && (head.epoch !== stored.epoch || head.seq !== stored.seq)) throw new NetError('meta_stale')
    return meta
  }
  private hostBinding(meta: MetaState): string { return `${meta.descriptor.epoch}/${meta.descriptor.owner}/${meta.descriptor.hostNode}/${meta.descriptor.hostTransportKey}` }
  private sourceRoster(request: CurrentRequest, peer: SyncSession['peer']): Signed {
    const meta = this.state(request.space, request.metaHead), identity = this.options.runtime.identity, self = identity.self()
    if (!self || self.user !== meta.descriptor.owner || self.node !== meta.descriptor.hostNode || !this.options.host.canRead(spaceMetaStream(request.space), peer)) throw new NetError('forbidden')
    const member = meta.members.get(request.user), signed = identity.roster(request.user)
    if (!member || !signed || identity.pinnedRootKey(request.user) !== member.rootKey || identity.rosterState(request.user) !== 'ok') throw new NetError('bad_delegation')
    const roster = identity.verifySigned<Roster>(signed, member.rootKey)
    if (roster.owner !== request.user || roster.rootKey !== member.rootKey) throw new NetError('bad_delegation')
    return signed
  }
  private async prepare(space: SpaceId, user: UserId, purpose: Purpose): Promise<void> {
    if (this.options.runtime.db.inTransaction) throw new NetError('bad_request')
    try { this.current(space, user, purpose); return } catch (error) { if (!(error instanceof NetError) || error.code !== 'meta_stale') throw error }
    const key = `${space}/${user}/${purpose}`, existing = this.pending.get(key)
    if (existing) return existing
    if (this.pending.size >= 8) throw new NetError('rate_limited')
    const operation = this.fetch(space, user, purpose)
    this.pending.set(key, operation)
    try { await operation } finally { if (this.pending.get(key) === operation) this.pending.delete(key) }
  }
  private async fetch(space: SpaceId, user: UserId, purpose: Purpose): Promise<void> {
    const meta = this.state(space), member = meta.members.get(user), identity = this.options.runtime.identity, self = identity.self()
    if (!member || !self) throw new NetError('forbidden')
    const head = { ...meta.applied }, host = this.hostBinding(meta)
    let signed: Signed, session: ProofSession | undefined
    if (self.node === meta.descriptor.hostNode && self.user === meta.descriptor.owner) {
      const own = identity.roster(user)
      if (!own || identity.pinnedRootKey(user) !== member.rootKey || identity.rosterState(user) !== 'ok') throw new NetError('bad_delegation')
      signed = own
    } else {
      session = this.options.session(space)
      this.assertSession(meta, session)
      if (!session?.spaceIdentity) throw new NetError('forbidden')
      signed = await session.spaceIdentity(space, user, head)
      this.assertSession(this.state(space, head), session)
    }
    if (this.hostBinding(this.state(space, head)) !== host) throw new NetError('meta_stale')
    if (identity.pinnedRootKey(user) && identity.pinnedRootKey(user) !== member.rootKey) throw new NetError('conflict')
    if (identity.rosterState(user) !== 'ok') throw new NetError('roster_conflict')
    const state = this.retain(space, user, member.rootKey, signed)
    if (this.fresh.size >= 256 && !this.fresh.has(`${space}/${user}/${purpose}`)) this.fresh.delete(this.fresh.keys().next().value!)
    this.fresh.set(`${space}/${user}/${purpose}`, { state, root: member.rootKey, host, head, at: this.options.runtime.db.clock.monotonic(), session })
  }
  private assertSession(meta: MetaState, session?: SyncSession): void {
    if (!session || session !== this.options.session(meta.space) || session.state() !== 'open' || session.peer.user !== meta.descriptor.owner ||
      session.peer.node !== meta.descriptor.hostNode || session.peer.delegation.keys.transport !== meta.descriptor.hostTransportKey) throw new NetError('meta_stale')
  }
  private current(space: SpaceId, user: UserId, purpose: Purpose): FreshProof {
    const meta = this.state(space), proof = this.fresh.get(`${space}/${user}/${purpose}`), member = meta.members.get(user), identity = this.options.runtime.identity
    if (!member) throw new NetError('forbidden')
    if (identity.pinnedRootKey(user) && identity.pinnedRootKey(user) !== member.rootKey) throw new NetError('conflict')
    if (identity.rosterState(user) !== 'ok') throw new NetError('roster_conflict')
    const age = proof ? this.options.runtime.db.clock.monotonic() - proof.at : Infinity
    if (!proof || age < 0 || age >= (purpose === 'presenceDisplay' ? 90000 : 30000) || proof.root !== member.rootKey || proof.host !== this.hostBinding(meta) || proof.head.epoch !== meta.applied.epoch || proof.head.seq !== meta.applied.seq) throw new NetError('meta_stale')
    if (proof.session && purpose !== 'presenceDisplay') this.assertSession(meta, proof.session)
    const adopted = identity.roster(user)
    if (adopted && this.withIdentity(proof.state, scoped => scoped.roster(user)?.payload) !== adopted.payload) throw new NetError('meta_stale')
    const held = this.options.runtime.db.database.prepare('SELECT state FROM net_space_current_identity WHERE space=? AND user=?').get(space, user)
    if (!held || held.state !== proof.state) throw new NetError('meta_stale')
    return proof
  }
  private withIdentity<T>(state: string | undefined, work: (identity: NetIdentityService, database: DatabaseSync) => T): T {
    const database = new DatabaseSync(':memory:')
    try {
      database.exec('CREATE TABLE net_identity_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),value TEXT NOT NULL)')
      if (state) database.prepare('INSERT INTO net_identity_state VALUES(1,?)').run(state)
      return work(new NetIdentityService({ database, keys: this.options.runtime.keys, clock: this.options.runtime.db.clock }), database)
    } finally { database.close() }
  }
  private retain(space: SpaceId, user: UserId, root: string, signed: Signed): string {
    const db = this.options.runtime.db, row = db.database.prepare('SELECT root,state FROM net_space_current_identity WHERE space=? AND user=?').get(space, user)
    if (row && row.root !== root || db.database.prepare('SELECT 1 FROM net_space_current_identity WHERE user=? AND root<>? LIMIT 1').get(user, root)) throw new NetError('conflict')
    let conflict = false
    const state = this.withIdentity(row?.state as string | undefined, (scoped, database) => {
      scoped.pinUser(user, root)
      const incoming = scoped.verifySigned<Roster>(signed, root), held = scoped.roster(user)
      if (incoming.owner !== user || incoming.rootKey !== root) throw new NetError('bad_delegation')
      if (held) {
        const prior = scoped.verifySigned<Roster>(held, root)
        if (incoming.recoveryEpoch < prior.recoveryEpoch || incoming.recoveryEpoch === prior.recoveryEpoch && incoming.version < prior.version) throw new NetError('meta_stale')
      }
      conflict = scoped.acceptRoster(signed, root).state !== 'ok'
      // Export only the isolated validator's state, never the profile's identity.
      return String(database.prepare('SELECT value FROM net_identity_state WHERE singleton=1').get()!.value)
    })
    const bytes = Buffer.byteLength(state)
    db.transaction(() => {
      const used = db.database.prepare('SELECT count(*) AS rows,coalesce(sum(bytes),0) AS bytes FROM net_space_current_identity WHERE NOT(space=? AND user=?)').get(space, user)!
      if (Number(used.rows) >= 512 || Number(used.bytes) + bytes > 16 * 1024 * 1024) throw new NetError('too_large')
      db.charge(1, bytes)
      db.database.prepare('INSERT INTO net_space_current_identity VALUES(?,?,?,?,?) ON CONFLICT(space,user) DO UPDATE SET root=excluded.root,state=excluded.state,bytes=excluded.bytes').run(space, user, root, state, bytes)
      if (!conflict) this.options.retainHistoryRoster?.(signed)
    })
    if (conflict) throw new NetError('roster_conflict')
    return state
  }
}
