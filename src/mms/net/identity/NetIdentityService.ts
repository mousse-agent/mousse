import { createHash, createPublicKey, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { BotDelegation, BotId, Delegation, EnvelopeAuthor, NodeCapability, NodeDelegation, NodeId, NodePublicKeys, Roster, RosterState, Signed, UserId } from '../../../shared/net'
import { isId, newId } from '../../../shared/net/ids'
import { NetError } from '../../../shared/net/errors'
import { NODE_CAPABILITIES, DEFAULT_NODE_CAPABILITIES, SESSION_CAPABILITIES } from '../../../shared/net/capabilities'
import { NODE_DELEGATION_TTL_MS, PREAUTH_MAX_BYTES, NET_PROTO_MAJOR, NET_PROTO_MINOR } from '../../../shared/net/limits'
import { canonicalJson, parseProtocolJson, encodeMessage } from '../sync/codec'
import type { Clock, IdentityService, KeyStore, VerifiedAuthor } from '../contracts'
import { decodeBase64, signedDocument, verifyBytes, verifyDocument } from './crypto'

type WriterState = 'follower' | 'authority' | 'retired' | 'transferring'
interface UserState {
  root: string
  current?: Signed
  history: Signed[]
  conflicts: Signed[]
  state: RosterState
  /** Revocation evidence is never forgotten by a recovered/lower roster. */
  revocations: Record<string, { throughKeyEpoch: number; revokedAt: number }>
}
export interface IdentityTransactionCoordinator {
  transaction<T>(work: () => T): T
  afterCommit(callback: () => void): void
}
export interface AuthorityTransferOffer {
  v: 1
  kind: 'authorityTransferOffer'
  transfer: string
  user: UserId
  from: NodeId
  to: NodeId
  sourceRosterHash: string
  successorHash: string
  issuedAt: number
  expiresAt: number
  blobHash?: string
}
export interface AuthorityTransferExport { offer: Signed; successor: Signed; recovery: Uint8Array }
interface TransferProof {
  v: 1
  kind: 'authorityTransferAck' | 'authorityTransferRetirement'
  transfer: string
  user: UserId
  from: NodeId
  to: NodeId
  offerHash: string
  blobHash: string
  successorHash: string
  at: number
}
interface TransferJournal {
  phase: 'prepared' | 'exported' | 'acked' | 'finalized' | 'received' | 'activated'
  source: Signed
  successor: Signed
  offer: Signed
  ack?: Signed
  retirement?: Signed
  /** Encrypted recovery export only; no plaintext root enters net.db. */
  recovery?: string
}
export interface AuthorityTransferState {
  phase: TransferJournal['phase']
  offer: Signed
  successor: Signed
  ack?: Signed
  retirement?: Signed
}
interface IdentityState {
  v: 1
  self?: { user: UserId; node: NodeId }
  writer: WriterState
  transfer?: TransferJournal
  users: Record<string, UserState>
}
export interface NetIdentityServiceOptions {
  database: DatabaseSync
  keys: KeyStore
  clock: Clock
  /** Configured after node enrollment; constructor never guesses IDs from keys/paths. */
  self?: { user: UserId; node: NodeId }
  coordinator?: IdentityTransactionCoordinator
}

const empty = (): IdentityState => ({ v: 1, writer: 'follower', users: {} })
const payloadEqual = (a: Signed, b: Signed): boolean => a.payload === b.payload
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('base64url')
const signedHash = (document: Signed): string => digest(canonicalJson(document))
const position = (a: Roster, b: Roster): number => a.recoveryEpoch - b.recoveryEpoch || a.version - b.version

/** Durable, profile-scoped identity state using the shared profile net.db connection. */
export class NetIdentityService implements IdentityService {
  private readonly database: DatabaseSync
  private readonly keys: KeyStore
  private readonly clock: Clock
  private readonly coordinator?: IdentityTransactionCoordinator
  private readonly listeners = new Set<(user: UserId) => void>()

  constructor(options: NetIdentityServiceOptions) {
    this.database = options.database; this.keys = options.keys; this.clock = options.clock; this.coordinator = options.coordinator
    this.database.exec('CREATE TABLE IF NOT EXISTS net_identity_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), value TEXT NOT NULL)')
    this.transaction(state => {
      if (options.self) {
        this.ids(options.self)
        if (state.self && (state.self.user !== options.self.user || state.self.node !== options.self.node)) throw new NetError('conflict', 'Profile already has a different local identity.')
        state.self = options.self
      }
    })
    if (this.load().transfer?.phase === 'finalized' && this.keys.state() === 'unlocked') this.deleteRetiredRoot()
  }

  /** Explicit initialization seam; KeyStore initialization can safely precede its first roster. */
  async bootstrapAuthority(name: string): Promise<Signed> {
    if (this.load().self) throw new NetError('conflict', 'Local identity already exists.')
    if (this.keys.state() === 'missing') await this.keys.initialize({ asAuthority: true })
    const root = this.keys.rootKey()
    if (!root) throw new NetError('forbidden', 'Initialization requires an authority root key.')
    const self = { user: newId('user'), node: newId('node') }
    const now = this.clock.now()
    const node = this.nodeDelegation({ node: self.node, keys: this.keys.nodeKeys(), name, caps: [...DEFAULT_NODE_CAPABILITIES] }, self.user, 1, now)
    const roster: Roster = { v: 1, owner: self.user, rootKey: root, recoveryEpoch: 0, lineage: randomBytes(16).toString('base64url'), version: 1, authorityNode: self.node, nodes: [node], bots: [], revoked: [], issuedAt: now }
    const signed = signedDocument(roster, bytes => this.keys.signAsRoot(bytes))
    this.representableRoster(roster, signed)
    this.transaction(state => {
      if (state.self) throw new NetError('conflict')
      state.self = self; state.writer = 'authority'
      state.users[self.user] = { root, current: signed, history: [signed], conflicts: [], state: 'ok', revocations: {} }
    })
    this.changed(self.user)
    return signed
  }

  self(): { user: UserId; node: NodeId; isAuthority: boolean } | undefined {
    const state = this.load(), self = state.self
    if (!self) return undefined
    const user = state.users[self.user]
    const current = user?.current ? this.rosterDocument(user.current, user.root) : undefined
    return { ...self, isAuthority: state.writer === 'authority' && user?.state === 'ok' && current?.authorityNode === self.node && this.keys.state() === 'unlocked' && this.keys.rootKey() === user.root && this.localNodeMatches(current, self.node) }
  }
  rosterState(user: UserId): RosterState { return this.load().users[user]?.state ?? 'ok' }
  roster(user?: UserId): Signed | undefined { const state = this.load(); const id = user ?? state.self?.user; return id ? structuredClone(state.users[id]?.current) : undefined }
  pinnedRootKey(user: UserId): string | undefined { return this.load().users[user]?.root }
  pinUser(user: UserId, rootKey: string): void {
    if (!isId('user', user)) throw new NetError('bad_request')
    decodeBase64(rootKey, 32)
    this.transaction(state => {
      const existing = state.users[user]
      if (existing && existing.root !== rootKey) throw new NetError('conflict', 'Pinned user root cannot be replaced.')
      if (!existing) state.users[user] = { root: rootKey, history: [], conflicts: [], state: 'ok', revocations: {} }
    })
  }

  acceptRoster(signed: Signed, pinnedRootKey: string): { changed: boolean; state: RosterState } {
    const incoming = this.rosterDocument(signed, pinnedRootKey)
    let changed = false, resulting: RosterState = 'ok'
    this.transaction(state => {
      const user = state.users[incoming.owner]
      if (!user || user.root !== pinnedRootKey) throw new NetError('not_enrolled', 'Pin the user root before adopting a roster.')
      const documents = [...user.history, ...user.conflicts].map(entry => ({ signed: entry, roster: this.rosterDocument(entry, user.root) }))
      const held = user.current ? this.rosterDocument(user.current, user.root) : undefined
      const equivocation = documents.some(({ signed: prior, roster }) =>
        roster.recoveryEpoch === incoming.recoveryEpoch && (roster.lineage !== incoming.lineage || (roster.version === incoming.version && !payloadEqual(prior, signed))))
      if (equivocation) {
        if (!user.conflicts.some(entry => payloadEqual(entry, signed))) user.conflicts.push(signed)
        if (held && incoming.recoveryEpoch < held.recoveryEpoch) { resulting = user.state; return }
        changed = user.state !== 'conflict'; user.state = 'conflict'; resulting = 'conflict'
        return
      }
      if (user.state === 'conflict') {
        const highest = Math.max(...documents.map(entry => entry.roster.recoveryEpoch), held?.recoveryEpoch ?? 0)
        if (incoming.recoveryEpoch <= highest) { resulting = 'conflict'; return }
      }
      if (held && position(incoming, held) <= 0) {
        this.keyContinuity(user, incoming, false)
        if (!user.history.some(entry => payloadEqual(entry, signed))) user.history.push(signed)
        resulting = user.state
        return
      }
      for (const [subject, prior] of Object.entries(user.revocations)) {
        const next = incoming.revoked.find(row => row.subject === subject)
        if (!next || next.throughKeyEpoch < prior.throughKeyEpoch || next.revokedAt > prior.revokedAt) throw new NetError('bad_delegation', 'Roster drops prior revocation evidence.')
      }
      this.keyContinuity(user, incoming)
      if (state.self?.user === incoming.owner) {
        const local = this.delegations(incoming).filter((entry): entry is NodeDelegation => entry.kind === 'node' && entry.subject === state.self!.node).sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
        if (local && this.keys.state() === 'unlocked' && Buffer.from(canonicalJson(local.keys)).toString() !== Buffer.from(canonicalJson(this.keys.nodeKeys())).toString()) throw new NetError('bad_delegation', 'Local node delegation does not bind this key store.')
      }
      user.current = signed; user.state = 'ok'
      if (!user.history.some(entry => payloadEqual(entry, signed))) user.history.push(signed)
      for (const revocation of incoming.revoked) {
        const prior = user.revocations[revocation.subject]
        user.revocations[revocation.subject] = { throughKeyEpoch: Math.max(prior?.throughKeyEpoch ?? 0, revocation.throughKeyEpoch), revokedAt: Math.min(prior?.revokedAt ?? Infinity, revocation.revokedAt) }
      }
      if (state.self?.user === incoming.owner && incoming.authorityNode !== state.self.node && state.writer === 'authority') state.writer = 'retired'
      changed = true
    })
    if (changed) this.changed(incoming.owner)
    return { changed, state: resulting }
  }

  verifyAuthor(author: EnvelopeAuthor, bytes: Uint8Array, signature: Uint8Array, at: number, purpose: 'newWork' | 'history'): VerifiedAuthor {
    if (purpose !== 'newWork' && purpose !== 'history') throw new NetError('bad_request')
    if (!Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(author.keyEpoch) || author.keyEpoch < 1 || !isId('node', author.node) || (!!author.user === !!author.bot)) throw new NetError('bad_delegation')
    const state = this.load()
    const botOwners = author.bot ? Object.entries(state.users).filter(([, user]) => user.history.some(signed => this.rosterDocument(signed, user.root).bots.some(bot => verifyDocument<BotDelegation>(bot, user.root, 'botDelegation').subject === author.bot))).map(([id]) => id as UserId) : []
    if (botOwners.length > 1) throw new NetError('conflict', 'Bot identifier has conflicting pinned owners.')
    const userId = author.user ?? botOwners[0]
    if (!userId) throw new NetError('bad_delegation', 'No pinned author identity.')
    const user = state.users[userId]
    if (!user?.current) throw new NetError('bad_delegation')
    if (purpose === 'newWork' && user.state === 'conflict') throw new NetError('roster_conflict')
    const current = this.rosterDocument(user.current, user.root)
    const subject = author.bot ?? author.node
    const all = user.history.flatMap(entry => this.delegations(this.rosterDocument(entry, user.root)))
      .filter(entry => entry.subject === subject && entry.keyEpoch === author.keyEpoch && entry.issuedAt <= at && at < entry.expiresAt)
    const delegated = all.sort((a, b) => b.issuedAt - a.issuedAt)[0]
    if (!delegated || delegated.owner !== userId || (delegated.kind === 'bot' && delegated.hostNode !== author.node)) throw new NetError('bad_delegation')
    if (delegated.kind === 'node' && delegated.subject !== author.node) throw new NetError('bad_delegation')
    const currentEntries = this.delegations(current).filter(entry => entry.subject === subject)
    const latest = currentEntries.sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
    const latestEpoch = latest?.keyEpoch ?? 0, now = this.clock.now()
    const live = latest && latest.keyEpoch === author.keyEpoch && latest.issuedAt <= now && now < latest.expiresAt && (latest.kind === 'node' || latest.hostNode === author.node) ? latest : undefined
    const revoked = (user.revocations[subject]?.throughKeyEpoch ?? 0) >= author.keyEpoch
    const verifyOnly = author.keyEpoch !== latestEpoch || !live || revoked
    if (purpose === 'newWork') {
      if (delegated.kind === 'bot') {
        const nodes = this.delegations(current).filter((entry): entry is NodeDelegation => entry.kind === 'node' && entry.subject === author.node)
        const placement = nodes.sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
        const nodeEpoch = placement?.keyEpoch ?? 0
        if ((user.revocations[author.node]?.throughKeyEpoch ?? 0) >= nodeEpoch) throw new NetError('revoked', 'Bot placement node is revoked.')
        if (!placement || placement.issuedAt > now || now >= placement.expiresAt) throw new NetError('bad_delegation', 'Bot placement node has no current delegation.')
      }
      if (revoked) throw new NetError('revoked')
      if (verifyOnly) throw new NetError('bad_delegation', 'Old, expired or displaced author is verify-only.')
    }
    verifyBytes(bytes, signature, delegated.keys.sign)
    const authorized = purpose === 'newWork' ? live! : delegated
    return authorized.kind === 'node'
      ? { kind: 'node', user: userId, node: author.node, delegation: structuredClone(authorized), verifyOnly, revoked }
      : { kind: 'bot', user: userId, node: author.node, bot: authorized.subject, delegation: structuredClone(authorized), verifyOnly, revoked }
  }
  historicalRosterFor(author: EnvelopeAuthor, at: number): Signed | undefined {
    if (!Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(author.keyEpoch) || author.keyEpoch < 1 || !isId('node', author.node) || (!!author.user === !!author.bot)) throw new NetError('bad_request')
    const state = this.load(), subject = author.bot ?? author.node
    const owners = author.user ? [author.user] : Object.keys(state.users) as UserId[]
    let found: Signed | undefined, foundOwner: UserId | undefined
    for (const owner of owners) {
      const user = state.users[owner]
      if (!user) continue
      for (const signed of user.history) {
        const roster = this.rosterDocument(signed, user.root)
        const matches = this.delegations(roster).some(row => row.owner === owner && row.subject === subject && row.keyEpoch === author.keyEpoch && row.issuedAt <= at && at < row.expiresAt && (author.bot ? row.kind === 'bot' && row.hostNode === author.node : row.kind === 'node'))
        if (!matches) continue
        if (foundOwner && foundOwner !== owner) throw new NetError('conflict', 'Historical bot evidence has conflicting pinned owners.')
        foundOwner = owner; found ??= signed
        break
      }
    }
    return found ? structuredClone(found) : undefined
  }

  verifySigned<T>(signed: Signed, publicKey: string): T { return verifyDocument<T>(signed, publicKey) }
  signAsNode<T>(document: T): Signed { return signedDocument(document, bytes => this.keys.signAsNode(bytes)) }

  issueNodeDelegation(input: { node: NodeId; keys: NodePublicKeys; name: string; caps: NodeCapability[] }): Signed {
    let result!: Signed
    this.authorityUpdate((roster, self) => {
      if (!isId('node', input.node)) throw new NetError('bad_request')
      const epoch = this.nextEpoch(roster, input.node)
      result = this.nodeDelegation(input, self.user, epoch, this.clock.now())
      roster.nodes.push(result)
    })
    return result
  }
  issueBotDelegation(input: { bot: BotId; key: string; name: string; hostNode: NodeId }): Signed {
    let result!: Signed
    this.authorityUpdate((roster, self) => {
      if (!isId('bot', input.bot) || !isId('node', input.hostNode)) throw new NetError('bad_request')
      decodeBase64(input.key, 32)
      const node = this.delegations(roster).filter((entry): entry is NodeDelegation => entry.kind === 'node' && entry.subject === input.hostNode).sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
      if (!node || node.expiresAt <= this.clock.now() || (roster.revoked.find(row => row.subject === node.subject)?.throughKeyEpoch ?? 0) >= node.keyEpoch) throw new NetError('bad_delegation', 'Bot placement node is not currently authorized.')
      const existing = this.delegations(roster).filter((entry): entry is BotDelegation => entry.kind === 'bot' && entry.subject === input.bot).sort((a, b) => b.keyEpoch - a.keyEpoch)[0]
      if (existing && existing.hostNode !== input.hostNode && existing.expiresAt > this.clock.now()) throw new NetError('forbidden', 'Active bot movement requires acknowledged stop and ledger handoff in P2/P6.')
      const now = this.clock.now()
      const delegation: BotDelegation = { v: 1, kind: 'bot', subject: input.bot, keys: { sign: input.key }, owner: self.user, name: input.name, hostNode: input.hostNode, keyEpoch: this.nextEpoch(roster, input.bot), issuedAt: now, expiresAt: now + NODE_DELEGATION_TTL_MS }
      this.validDelegation(delegation)
      result = signedDocument(delegation, bytes => this.keys.signAsRoot(bytes)); roster.bots.push(result)
    })
    return result
  }
  /** Enrollment cannot rebind an already published node identifier, including removed historical nodes. */
  isKnownNode(node: NodeId): boolean {
    if (!isId('node',node)) throw new NetError('bad_request')
    const state=this.load(), user=state.self&&state.users[state.self.user]
    return !!user&&[...user.history,...user.conflicts].some(signed=>this.delegations(this.rosterDocument(signed,user.root)).some(row=>row.kind==='node'&&row.subject===node))
  }
  renameNode(node: NodeId, name: string): Signed {
    return this.authorityUpdate(roster=>{
      const entries=this.delegations(roster).filter((row):row is NodeDelegation=>row.kind==='node'&&row.subject===node).sort((a,b)=>b.keyEpoch-a.keyEpoch||b.issuedAt-a.issuedAt)
      const held=entries[0]
      if(!held)throw new NetError('bad_request')
      if((roster.revoked.find(row=>row.subject===node)?.throughKeyEpoch??0)>=held.keyEpoch)throw new NetError('revoked')
      // A label update does not resurrect an expired lease or change its authorization lifetime.
      const renamed={...held,name};this.validDelegation(renamed)
      roster.nodes=roster.nodes.filter(signed=>{const row=verifyDocument<NodeDelegation>(signed,roster.rootKey,'nodeDelegation');return row.subject!==node||row.keyEpoch!==held.keyEpoch})
      roster.nodes.push(signedDocument(renamed,bytes=>this.keys.signAsRoot(bytes)))
    })
  }
  revoke(subject: NodeId | BotId): Signed {
    return this.authorityUpdate(roster => {
      const rows = this.delegations(roster).filter(entry => entry.subject === subject)
      if (!rows.length) throw new NetError('bad_request', 'Unknown delegation subject.')
      if (subject === roster.authorityNode) throw new NetError('forbidden', 'Transfer or recover authority before revoking it.')
      const epoch = Math.max(...rows.map(entry => entry.keyEpoch)), old = roster.revoked.find(row => row.subject === subject)
      if (old) old.throughKeyEpoch = Math.max(old.throughKeyEpoch, epoch)
      else roster.revoked.push({ subject, throughKeyEpoch: epoch, revokedAt: this.clock.now() })
    })
  }
  renewExpiring(now: number): Signed | undefined {
    if (!Number.isSafeInteger(now) || now < 0 || now !== this.clock.now()) throw new NetError('bad_request', 'Renewal must use the authority clock.')
    const current = this.roster()
    if (!current) throw new NetError('not_enrolled')
    const self = this.self()
    if (!self?.isAuthority) throw new NetError('forbidden')
    const root = this.pinnedRootKey(self.user)!
    const roster = this.rosterDocument(current, root)
    const latest = new Map<string, Delegation>()
    for (const delegation of this.delegations(roster)) {
      const held = latest.get(delegation.subject)
      if (!held || delegation.keyEpoch > held.keyEpoch || (delegation.keyEpoch === held.keyEpoch && delegation.issuedAt > held.issuedAt)) latest.set(delegation.subject, delegation)
    }
    const due = [...latest.values()].filter(entry => entry.expiresAt - now <= 86400000 && entry.expiresAt > now && (roster.revoked.find(row => row.subject === entry.subject)?.throughKeyEpoch ?? 0) < entry.keyEpoch)
    if (!due.length) return undefined
    return this.authorityUpdate(next => {
      for (const entry of due) {
        const renewed = { ...entry, issuedAt: now, expiresAt: now + NODE_DELEGATION_TTL_MS }
        const signed = signedDocument(renewed, bytes => this.keys.signAsRoot(bytes))
        // Prior signed rosters remain in local history. The live roster carries one renewal per epoch.
        if (entry.kind === 'node') {
          next.nodes = next.nodes.filter(row => { const prior = verifyDocument<NodeDelegation>(row, next.rootKey, 'nodeDelegation'); return prior.subject !== entry.subject || prior.keyEpoch !== entry.keyEpoch })
          next.nodes.push(signed)
        } else {
          next.bots = next.bots.filter(row => { const prior = verifyDocument<BotDelegation>(row, next.rootKey, 'botDelegation'); return prior.subject !== entry.subject || prior.keyEpoch !== entry.keyEpoch })
          next.bots.push(signed)
        }
      }
    })
  }

  /** Local operation journal. Actual protected delivery and passphrase exchange belong to P2. */
  authorityTransferState(): AuthorityTransferState | undefined {
    const transfer = this.load().transfer
    if (!transfer) return undefined
    const { phase, offer, successor, ack, retirement } = transfer
    return structuredClone({ phase, offer, successor, ...(ack ? { ack } : {}), ...(retirement ? { retirement } : {}) })
  }

  prepareTransfer(to: NodeId): Signed {
    let offer!: Signed
    this.transaction(state => {
      const self = state.self, user = self && state.users[self.user]
      if (state.writer === 'transferring' && state.transfer) {
        const body = this.transferOffer(state.transfer.offer, state.transfer.source)
        this.transferCurrent(state, state.transfer, body)
        if (body.to !== to) throw new NetError('conflict', 'A different authority handoff is already prepared.')
        offer = state.transfer.offer; return
      }
      if (!self || !user?.current || state.writer !== 'authority' || user.state !== 'ok' || this.keys.rootKey() !== user.root) throw new NetError('forbidden')
      const source = this.rosterDocument(user.current, user.root)
      if (!this.localNodeMatches(source, self.node)) throw new NetError('bad_delegation', 'Local authority delegation does not bind this unlocked key store.')
      if (source.authorityNode !== self.node || to === self.node) throw new NetError('bad_request')
      const now = this.clock.now(), sourceNode = this.liveNode(source, self.node), target = this.liveNode(source, to)
      const successor: Roster = { ...source, authorityNode: to, version: source.version + 1, issuedAt: now }
      if (!Number.isSafeInteger(successor.version)) throw new NetError('conflict')
      const signed = signedDocument(successor, bytes => this.keys.signAsRoot(bytes))
      this.rosterDocument(signed, user.root)
      this.representableRoster(successor, signed)
      const body: AuthorityTransferOffer = { v: 1, kind: 'authorityTransferOffer', transfer: randomBytes(32).toString('base64url'), user: self.user, from: self.node, to,
        sourceRosterHash: signedHash(user.current), successorHash: signedHash(signed), issuedAt: now, expiresAt: Math.min(now + 600000, sourceNode.expiresAt, target.expiresAt) }
      offer = this.signAsNode(body)
      state.transfer = { phase: 'prepared', source: user.current, successor: signed, offer }; state.writer = 'transferring'
    })
    return offer
  }

  /** First export fixes its passphrase and ciphertext; retries return those exact persisted bytes. */
  async exportTransfer(passphrase: string): Promise<AuthorityTransferExport> {
    const state = this.load(), transfer = state.transfer
    if (state.writer !== 'transferring' || !transfer || !['prepared', 'exported', 'acked'].includes(transfer.phase)) throw new NetError('forbidden')
    const body = this.transferOffer(transfer.offer, transfer.source)
    this.transferCurrent(state, transfer, body)
    if (transfer.recovery) {
      const recovery = decodeBase64(transfer.recovery)
      if (digest(recovery) !== body.blobHash) throw new NetError('storage_corrupt', 'Persisted root handoff hash mismatch.')
      return { offer: transfer.offer, successor: transfer.successor, recovery }
    }
    const recovery = await this.keys.exportRecovery(passphrase)
    let exported!: AuthorityTransferExport
    this.transaction(next => {
      const held = next.transfer
      if (!held || signedHash(held.offer) !== signedHash(transfer.offer)) throw new NetError('conflict', 'Transfer changed during root export.')
      this.transferCurrent(next, held, body)
      held.offer = this.signAsNode({ ...body, blobHash: digest(recovery) }); held.phase = 'exported'; held.recovery = Buffer.from(recovery).toString('base64url')
      exported = { offer: held.offer, successor: held.successor, recovery }
    })
    return exported
  }

  /** Importing root material alone never activates authority. Repeated import returns the same durable ack. */
  async importTransfer(exported: AuthorityTransferExport, passphrase: string): Promise<Signed> {
    const state = this.load(), self = state.self
    if (!self) throw new NetError('not_enrolled')
    const user = state.users[self.user]
    if (!user?.current || user.state !== 'ok' || state.writer === 'authority' || state.writer === 'transferring' || state.writer === 'retired') throw new NetError('forbidden')
    const source = state.transfer?.source ?? user.current
    const body = this.transferOffer(exported.offer, source)
    if (!body.blobHash || digest(exported.recovery) !== body.blobHash || body.user !== self.user || body.to !== self.node) throw new NetError('bad_delegation', 'Root handoff is not bound to this recipient and exact encrypted blob.')
    this.validateSuccessor(source, exported.successor, body, user.root)
    if (!this.localNodeMatches(this.rosterDocument(user.current, user.root), self.node)) throw new NetError('bad_delegation', 'Transfer recipient delegation does not bind this key store.')
    if (![body.sourceRosterHash, body.successorHash].includes(signedHash(user.current))) throw new NetError('conflict', 'Recipient roster advanced beyond this handoff.')
    if (state.transfer) {
      if (signedHash(state.transfer.offer) !== signedHash(exported.offer) || !state.transfer.ack) throw new NetError('conflict', 'Recipient has a different outstanding handoff.')
      return structuredClone(state.transfer.ack)
    }
    await this.keys.importRecovery(exported.recovery, passphrase)
    if (this.keys.rootKey() !== user.root) throw new NetError('bad_delegation')
    let ack!: Signed
    this.transaction(next => {
      if (next.transfer || next.writer !== 'follower' || next.users[self.user]?.state !== 'ok' || signedHash(next.users[self.user].current!) !== body.sourceRosterHash) throw new NetError('conflict', 'Recipient identity changed during root import.')
      this.transferOffer(exported.offer, user.current!)
      ack = this.signAsNode(this.proof('authorityTransferAck', body, exported.offer))
      next.transfer = { phase: 'received', source: user.current!, successor: exported.successor, offer: exported.offer, ack }
    })
    return ack
  }

  transferAcknowledgment(): Signed {
    if (this.database.isTransaction) throw new NetError('forbidden', 'Acknowledgment is unavailable until import commits.')
    const transfer = this.load().transfer
    if (!transfer || !['received', 'activated'].includes(transfer.phase) || !transfer.ack) throw new NetError('forbidden')
    return structuredClone(transfer.ack)
  }

  acceptTransferAck(ack: Signed): void {
    this.transaction(state => {
      const transfer = state.transfer
      if (state.writer !== 'transferring' || !transfer || !['exported', 'acked'].includes(transfer.phase)) throw new NetError('forbidden')
      const body = this.transferOffer(transfer.offer, transfer.source)
      this.transferCurrent(state, transfer, body)
      this.verifyTransferProof(ack, 'authorityTransferAck', body, transfer.offer, transfer.source, body.to)
      if (transfer.ack && signedHash(transfer.ack) !== signedHash(ack)) throw new NetError('conflict', 'Transfer acknowledgment differs from the persisted one.')
      transfer.ack = ack; transfer.phase = 'acked'
    })
  }

  transferAuthority(to: NodeId): Signed {
    let successor!: Signed, owner!: UserId
    this.transaction(state => {
      const transfer = state.transfer
      if (!transfer) throw new NetError('forbidden', 'Prepare/export handoff and receive the target acknowledgment first.')
      const self = state.self, user = self && state.users[self.user]
      if (!self || !user) throw new NetError('not_enrolled')
      const source = this.rosterDocument(transfer.source, user.root)
      const body = verifyDocument<AuthorityTransferOffer>(transfer.offer, this.liveNode(source, source.authorityNode, false).keys.sign)
      if (body.to !== to) throw new NetError('forbidden')
      if (transfer.phase === 'finalized' && state.writer === 'retired') { successor = transfer.successor; owner = body.user; return }
      if (state.writer !== 'transferring' || transfer.phase !== 'acked' || !transfer.ack) throw new NetError('forbidden')
      const verified = this.transferOffer(transfer.offer, transfer.source)
      this.transferCurrent(state, transfer, verified)
      this.verifyTransferProof(transfer.ack, 'authorityTransferAck', verified, transfer.offer, transfer.source, to)
      this.validateSuccessor(transfer.source, transfer.successor, verified, user.root)
      user.current = transfer.successor; user.history.push(transfer.successor)
      state.writer = 'retired'; transfer.phase = 'finalized'; delete transfer.recovery
      transfer.retirement = this.signAsNode(this.proof('authorityTransferRetirement', verified, transfer.offer))
      successor = transfer.successor; owner = verified.user
    })
    this.changed(owner)
    // A coordinating outer transaction must commit retirement before deleting its root file.
    this.deleteRetiredRoot()
    return successor
  }

  transferRetirement(): Signed {
    if (this.database.isTransaction) throw new NetError('forbidden', 'Retirement proof is unavailable until the enclosing transaction commits.')
    const transfer = this.load().transfer
    if (transfer?.phase !== 'finalized' || !transfer.retirement) throw new NetError('forbidden')
    return structuredClone(transfer.retirement)
  }

  /** Source retirement is a required second leg; an offered root-signed successor is insufficient. */
  activateTransfer(successor: Signed, retirement: Signed): void {
    let owner!: UserId
    this.transaction(state => {
      const transfer = state.transfer, self = state.self
      if (!transfer || !self || !['received', 'activated'].includes(transfer.phase) || !transfer.ack || signedHash(successor) !== signedHash(transfer.successor)) throw new NetError('forbidden')
      const user = state.users[self.user]
      const source = this.rosterDocument(transfer.source, user.root)
      const body = verifyDocument<AuthorityTransferOffer>(transfer.offer, this.liveNode(source, source.authorityNode, false).keys.sign)
      // A delayed retirement can arrive after the offer expiry. Verify signature at the recorded retirement time.
      this.verifyTransferProof(retirement, 'authorityTransferRetirement', body, transfer.offer, transfer.source, body.from, false)
      this.validateSuccessor(transfer.source, successor, body, user.root)
      if (user.state !== 'ok' || !user.current || ![body.sourceRosterHash, body.successorHash].includes(signedHash(user.current)) || self.node !== body.to || this.keys.rootKey() !== user.root) throw new NetError('conflict', 'A newer recovery/roster prevents activating this transfer.')
      if (!this.localNodeMatches(this.rosterDocument(successor, user.root), self.node)) throw new NetError('bad_delegation')
      if (transfer.phase === 'activated' && signedHash(transfer.retirement!) !== signedHash(retirement)) throw new NetError('conflict')
      user.current = successor
      if (!user.history.some(row => payloadEqual(row, successor))) user.history.push(successor)
      state.writer = 'authority'; transfer.phase = 'activated'; transfer.retirement = retirement; owner = self.user
    })
    this.changed(owner)
  }
  becomeAuthorityFromRecovery(): Signed {
    let result!: Signed, owner!: UserId
    this.transaction(state => {
      const self = state.self
      if (!self) throw new NetError('not_enrolled')
      const user = state.users[self.user], root = this.keys.rootKey()
      if (!user?.current || !root || root !== user.root) throw new NetError('forbidden', 'Import this pinned identity recovery root first.')
      const known = [...user.history, ...user.conflicts].map(entry => this.rosterDocument(entry, user.root))
      const current = this.rosterDocument(user.current, user.root)
      const recoveryEpoch = Math.max(...known.map(row => row.recoveryEpoch)) + 1
      if (!Number.isSafeInteger(recoveryEpoch)) throw new NetError('conflict')
      const now = this.clock.now()
      const delegation = this.nodeDelegation({ node: self.node, keys: this.keys.nodeKeys(), name: 'Recovered authority', caps: [...DEFAULT_NODE_CAPABILITIES] }, self.user, this.nextEpoch(current, self.node), now)
      const roster: Roster = { ...current, recoveryEpoch, lineage: randomBytes(16).toString('base64url'), version: 1, authorityNode: self.node, nodes: [...current.nodes, delegation], issuedAt: now }
      result = signedDocument(roster, bytes => this.keys.signAsRoot(bytes))
      this.rosterDocument(result, user.root)
      this.representableRoster(roster, result)
      user.current = result; user.history.push(result); user.state = 'ok'; state.writer = 'authority'; delete state.transfer; owner = self.user
    })
    this.changed(owner)
    return result
  }
  onRosterChanged(listener: (user: UserId) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  private localNodeMatches(roster: Roster, node: NodeId): boolean {
    if (this.keys.state() !== 'unlocked') return false
    try { return Buffer.compare(canonicalJson(this.liveNode(roster, node).keys), canonicalJson(this.keys.nodeKeys())) === 0 }
    catch (cause) { if (cause instanceof NetError) return false; throw cause }
  }

  private liveNode(roster: Roster, node: NodeId, current = true): NodeDelegation {
    if (!isId('node', node)) throw new NetError('bad_request')
    const rows = this.delegations(roster).filter((row): row is NodeDelegation => row.kind === 'node' && row.subject === node)
    const epoch = Math.max(0, ...rows.map(row => row.keyEpoch)), at = current ? this.clock.now() : roster.issuedAt
    const found = rows.filter(row => row.keyEpoch === epoch && row.issuedAt <= at && at < row.expiresAt).sort((a, b) => b.issuedAt - a.issuedAt)[0]
    if (!found || (roster.revoked.find(row => row.subject === node)?.throughKeyEpoch ?? 0) >= epoch) throw new NetError('bad_delegation', 'Transfer node is not currently delegated.')
    return found
  }
  private transferOffer(signed: Signed, source: Signed): AuthorityTransferOffer {
    const state = this.load(), self = state.self, user = self && state.users[self.user]
    if (!user) throw new NetError('not_enrolled')
    const roster = this.rosterDocument(source, user.root)
    const body = verifyDocument<AuthorityTransferOffer>(signed, this.liveNode(roster, roster.authorityNode).keys.sign)
    const required = ['v', 'kind', 'transfer', 'user', 'from', 'to', 'sourceRosterHash', 'successorHash', 'issuedAt', 'expiresAt']
    if (!body || Object.keys(body).some(key => ![...required, 'blobHash'].includes(key)) || required.some(key => !Object.hasOwn(body, key)) || body.v !== 1 || body.kind !== 'authorityTransferOffer' || body.user !== roster.owner || body.from !== roster.authorityNode || body.from === body.to || body.sourceRosterHash !== signedHash(source) || !Number.isSafeInteger(body.issuedAt) || !Number.isSafeInteger(body.expiresAt) || body.issuedAt < roster.issuedAt || body.expiresAt <= body.issuedAt || body.expiresAt - body.issuedAt > 600000 || this.clock.now() < body.issuedAt || this.clock.now() >= body.expiresAt) throw new NetError('bad_delegation', 'Invalid or expired transfer offer.')
    for (const value of [body.transfer, body.sourceRosterHash, body.successorHash, ...(body.blobHash ? [body.blobHash] : [])]) decodeBase64(value, 32)
    this.liveNode(roster, body.to)
    return body
  }
  private transferCurrent(state: IdentityState, transfer: TransferJournal, offer: AuthorityTransferOffer): void {
    const user = state.users[offer.user]
    if (state.writer !== 'transferring' || state.self?.node !== offer.from || user?.state !== 'ok' || !user.current || signedHash(user.current) !== offer.sourceRosterHash || signedHash(transfer.successor) !== offer.successorHash || this.keys.rootKey() !== user.root) throw new NetError('conflict', 'Transfer source authority/roster changed.')
  }
  private validateSuccessor(source: Signed, signed: Signed, offer: AuthorityTransferOffer, root: string): void {
    if (signedHash(signed) !== offer.successorHash) throw new NetError('bad_delegation')
    const before = this.rosterDocument(source, root), next = this.rosterDocument(signed, root)
    const expected: Roster = { ...before, authorityNode: offer.to, version: before.version + 1, issuedAt: offer.issuedAt }
    if (Buffer.compare(canonicalJson(next), canonicalJson(expected)) !== 0) throw new NetError('bad_delegation', 'Transfer changes more than authority and roster version.')
  }
  private proof(kind: TransferProof['kind'], offer: AuthorityTransferOffer, signed: Signed): TransferProof {
    if (!offer.blobHash) throw new NetError('forbidden')
    return { v: 1, kind, transfer: offer.transfer, user: offer.user, from: offer.from, to: offer.to, offerHash: signedHash(signed), blobHash: offer.blobHash, successorHash: offer.successorHash, at: this.clock.now() }
  }
  private verifyTransferProof(signed: Signed, kind: TransferProof['kind'], offer: AuthorityTransferOffer, signedOffer: Signed, source: Signed, node: NodeId, current = true): void {
    const root = this.load().users[offer.user]?.root
    if (!root) throw new NetError('not_enrolled')
    const roster = this.rosterDocument(source, root)
    const body = verifyDocument<TransferProof>(signed, this.liveNode(roster, node, current).keys.sign)
    const expected = { ...this.proof(kind, offer, signedOffer), at: body.at }
    if (Buffer.compare(canonicalJson(body), canonicalJson(expected)) !== 0 || !Number.isSafeInteger(body.at) || body.at < offer.issuedAt || body.at >= offer.expiresAt || body.at > this.clock.now()) throw new NetError('bad_delegation', 'Acknowledgment/retirement does not bind the exact handoff.')
    const delegated = this.liveNode(roster, node, false)
    if (body.at < delegated.issuedAt || body.at >= delegated.expiresAt) throw new NetError('bad_delegation')
  }
  private deleteRetiredRoot(): void {
    const drop = (): void => { const state = this.load(); if (state.writer === 'retired' && state.transfer?.phase === 'finalized' && this.keys.rootKey()) this.keys.dropRootKey() }
    if (this.coordinator) this.coordinator.afterCommit(drop)
    else drop()
  }

  private nodeDelegation(input: { node: NodeId; keys: NodePublicKeys; name: string; caps: NodeCapability[] }, owner: UserId, epoch: number, now: number): Signed {
    const delegation: NodeDelegation = { v: 1, kind: 'node', subject: input.node, keys: input.keys, owner, name: input.name, caps: input.caps, keyEpoch: epoch, issuedAt: now, expiresAt: now + NODE_DELEGATION_TTL_MS }
    this.validDelegation(delegation)
    return signedDocument(delegation, bytes => this.keys.signAsRoot(bytes))
  }
  private validDelegation(delegation: Delegation): void {
    if (!isId('user', delegation.owner) || !delegation.name || [...delegation.name].length > 256 || !Number.isSafeInteger(delegation.keyEpoch) || delegation.keyEpoch < 1 || !Number.isSafeInteger(delegation.issuedAt) || !Number.isSafeInteger(delegation.expiresAt) || delegation.issuedAt < 0 || delegation.expiresAt <= delegation.issuedAt || delegation.expiresAt - delegation.issuedAt > NODE_DELEGATION_TTL_MS) throw new NetError('bad_delegation')
    decodeBase64(delegation.keys.sign, 32)
    if (delegation.kind === 'node') {
      if (!isId('node', delegation.subject) || new Set(delegation.caps).size !== delegation.caps.length || delegation.caps.some(cap => !NODE_CAPABILITIES.includes(cap))) throw new NetError('bad_delegation')
      decodeBase64(delegation.keys.agree, 32)
      try {
        const key = createPublicKey({ key: decodeBase64(delegation.keys.transport), format: 'der', type: 'spki' })
        if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Wrong curve.')
      } catch (cause) { throw new NetError('bad_delegation', 'Invalid transport key.', { cause }) }
    } else if (!isId('bot', delegation.subject) || !isId('node', delegation.hostNode)) throw new NetError('bad_delegation')
  }
  private delegations(roster: Roster): Delegation[] {
    return [...roster.nodes.map(row => verifyDocument<NodeDelegation>(row, roster.rootKey, 'nodeDelegation')), ...roster.bots.map(row => verifyDocument<BotDelegation>(row, roster.rootKey, 'botDelegation'))]
  }
  private rosterDocument(signed: Signed, root: string): Roster {
    const roster = verifyDocument<Roster>(signed, root, 'roster')
    if (roster.rootKey !== root) throw new NetError('bad_delegation', 'Roster root does not match the pinned signer.')
    const delegations = this.delegations(roster)
    const keys = new Map<string, string>()
    for (const delegation of delegations) {
      this.validDelegation(delegation)
      if (delegation.owner !== roster.owner) throw new NetError('bad_delegation', 'Delegation owner differs from roster.')
      const key = delegation.subject + ':' + delegation.keyEpoch, encoding = Buffer.from(canonicalJson(delegation.keys)).toString('base64url')
      if (keys.has(key) && keys.get(key) !== encoding) throw new NetError('bad_delegation', 'One epoch names different keys.')
      keys.set(key, encoding)
    }
    const authorityNodes = delegations.filter((row): row is NodeDelegation => row.kind === 'node' && row.subject === roster.authorityNode)
    const authorityEpoch = Math.max(0, ...authorityNodes.map(row => row.keyEpoch))
    if (!authorityNodes.some(row => row.keyEpoch === authorityEpoch && row.issuedAt <= roster.issuedAt && roster.issuedAt < row.expiresAt) || (roster.revoked.find(row => row.subject === roster.authorityNode)?.throughKeyEpoch ?? 0) >= authorityEpoch) throw new NetError('bad_delegation', 'Authority node is not delegated at roster publication.')
    if (new Set(roster.revoked.map(row => row.subject)).size !== roster.revoked.length || roster.revoked.some(row => row.revokedAt > roster.issuedAt)) throw new NetError('bad_delegation', 'Invalid revocation evidence.')
    return roster
  }
  private keyContinuity(user: UserState, incoming: Roster, advancing = true): void {
    const historical = user.history.flatMap(entry => this.delegations(this.rosterDocument(entry, user.root)))
    const incomingDelegations = this.delegations(incoming)
    if (advancing) {
      const subjects = new Set(incomingDelegations.map(row => row.subject))
      for (const subject of subjects) {
        const known = Math.max(0, ...historical.filter(row => row.subject === subject).map(row => row.keyEpoch))
        const offered = Math.max(...incomingDelegations.filter(row => row.subject === subject).map(row => row.keyEpoch))
        if (offered < known) throw new NetError('bad_delegation', 'A newer roster cannot restore an obsolete key epoch.')
      }
    }
    for (const next of incomingDelegations) {
      for (const prior of historical) {
        if (prior.subject === next.subject && prior.keyEpoch === next.keyEpoch && Buffer.from(canonicalJson(prior.keys)).toString() !== Buffer.from(canonicalJson(next.keys)).toString()) throw new NetError('bad_delegation', 'An existing key epoch cannot change public keys.')
      }
    }
  }
  private representableRoster(roster: Roster, signed: Signed): void {
    const caps = [...SESSION_CAPABILITIES], now = this.clock.now()
    const acknowledgment = encodeMessage({ t: 'helloAck', protoMinor: NET_PROTO_MINOR, caps, now }).byteLength + 16
    // Both initial mux credit frames and the framed hello/ack must fit quarantine.
    for (const delegation of roster.nodes) {
      const node = verifyDocument<NodeDelegation>(delegation, roster.rootKey, 'nodeDelegation').subject
      const hello = encodeMessage({ t: 'hello', protoMajor: NET_PROTO_MAJOR, protoMinor: NET_PROTO_MINOR, caps, node, delegation, roster: signed, now }).byteLength + 16
      if (hello + acknowledgment + 32 > PREAUTH_MAX_BYTES) throw new NetError('too_large', 'Roster cannot fit the bounded normal hello handshake.')
    }
  }

  private nextEpoch(roster: Roster, subject: NodeId | BotId): number {
    const user = this.load().users[roster.owner]
    const archived = user ? [...user.history, ...user.conflicts].flatMap(row => this.delegations(this.rosterDocument(row, user.root))) : []
    const epoch = Math.max(0, ...[...this.delegations(roster), ...archived].filter(entry => entry.subject === subject).map(entry => entry.keyEpoch), roster.revoked.find(row => row.subject === subject)?.throughKeyEpoch ?? 0) + 1
    if (!Number.isSafeInteger(epoch)) throw new NetError('conflict')
    return epoch
  }
  private authorityUpdate(change: (roster: Roster, self: { user: UserId; node: NodeId }) => void): Signed {
    let result!: Signed, owner!: UserId
    this.transaction(state => {
      const self = state.self, user = self && state.users[self.user]
      if (!self || !user?.current || state.writer !== 'authority' || this.keys.rootKey() !== user.root) throw new NetError('forbidden', 'This profile is not the authority.')
      if (user.state === 'conflict') throw new NetError('roster_conflict')
      const roster = this.rosterDocument(user.current, user.root)
      if (roster.authorityNode !== self.node || !this.localNodeMatches(roster, self.node)) throw new NetError('forbidden')
      change(roster, self)
      roster.version++; roster.issuedAt = this.clock.now()
      if (!Number.isSafeInteger(roster.version)) throw new NetError('conflict')
      result = signedDocument(roster, bytes => this.keys.signAsRoot(bytes))
      this.rosterDocument(result, user.root)
      this.representableRoster(roster, result)
      user.current = result; user.history.push(result)
      for (const revocation of roster.revoked) user.revocations[revocation.subject] = { throughKeyEpoch: revocation.throughKeyEpoch, revokedAt: revocation.revokedAt }
      owner = self.user
    })
    this.changed(owner)
    return result
  }
  private load(): IdentityState {
    const row = this.database.prepare('SELECT value FROM net_identity_state WHERE singleton=1').get() as { value: string } | undefined
    if (!row) return empty()
    try {
      const value = parseProtocolJson(Buffer.from(row.value)) as IdentityState
      if (value.v !== 1 || !value.users || !['follower', 'authority', 'retired', 'transferring'].includes(value.writer)) throw new Error('Invalid state.')
      if (value.self) this.ids(value.self)
      return value
    } catch (cause) { throw new NetError('storage_corrupt', 'Identity state failed integrity checks.', { cause }) }
  }
  private transaction(change: (state: IdentityState) => void): void {
    const work = (): void => {
      const state = this.load(); change(state)
      const serialized = JSON.stringify(state)
      if (Buffer.byteLength(serialized) > 1024 * 1024) throw new NetError('too_large', 'Identity checkpoint exceeds the bounded foundation format.')
      parseProtocolJson(Buffer.from(serialized))
      this.database.prepare('INSERT INTO net_identity_state(singleton,value) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET value=excluded.value').run(serialized)
    }
    if (this.coordinator) { this.coordinator.transaction(work); return }
    try {
      this.database.exec('BEGIN IMMEDIATE'); work(); this.database.exec('COMMIT')
    } catch (cause) {
      try { if (this.database.isTransaction) this.database.exec('ROLLBACK') } catch { /* SQLite may have already rolled back. */ }
      if (cause instanceof NetError) throw cause
      const error = cause as { errcode?: number }
      throw new NetError(error.errcode === 13 ? 'storage_full' : error.errcode === 11 || error.errcode === 26 ? 'storage_corrupt' : 'internal', 'Identity transaction failed.', { cause })
    }
  }
  private ids(self: { user: UserId; node: NodeId }): void { if (!isId('user', self.user) || !isId('node', self.node)) throw new NetError('bad_request') }
  private changed(user: UserId): void {
    const notify = (): void => { for (const listener of this.listeners) { try { listener(user) } catch { /* Observers cannot roll back a committed mutation. */ } } }
    if (this.coordinator) this.coordinator.afterCommit(notify)
    else notify()
  }
}
