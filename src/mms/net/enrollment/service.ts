import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { EnrollRequestMessage, HelloMessage, InviteId, NodeCapability, NodeDelegation, NodeId, Roster, RoutesRecord, Signed, UserId } from '../../../shared/net'
import { DEFAULT_NODE_CAPABILITIES, NODE_CAPABILITIES, NODE_DELEGATION_TTL_MS, PREAUTH_MAX_BYTES, NetError, newId, isId } from '../../../shared/net'
import type { Clock, KeyStore, SecureChannel } from '../contracts'
import { NetIdentityService, type IdentityTransactionCoordinator } from '../identity'
import { decodeBase64, verifyDocument } from '../identity/crypto'
import { fingerprint } from '../link/selfSignedCert'
import { canonicalJson, encodeMessage, parseProtocolJson } from '../sync/codec'

export interface EnrollmentDatabase extends IdentityTransactionCoordinator { database: DatabaseSync; charge?(rows: number, bytes?: number): void }
export interface EnrollmentServiceOptions { db: EnrollmentDatabase; identity: NetIdentityService; keys: KeyStore; clock: Clock; routes(): Signed; fault?(point: 'enroll.beforeCommit' | 'join.beforeCommit'): void }
interface NodeInviteAuthorization {
  v: 1; kind: 'nodeInvite'; invite: InviteId; user: UserId; node: NodeId; rootKey: string
  roster: Signed; delegation: Signed; routes: Signed; transportFingerprint: string
  tokenHash: string; issuedAt: number; expiresAt: number; caps: NodeCapability[]; name?: string
}
export interface PreparedNodeJoin { invite: InviteId; user: UserId; node: NodeId; rootKey: string; authority: NodeId; authorityTransportKey: string; transportFingerprint: string; routes: Signed; state: 'prepared' | 'enrolled' }
export interface NodeEnrollmentResult { delegation: Signed; roster: Signed }
interface JoinJournal { authorization: Signed; claims: PreparedNodeJoin; name: string; attempted?: boolean }
const sha = (bytes: Uint8Array): Buffer => createHash('sha256').update(bytes).digest()
const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && timingSafeEqual(a, b)
const same = (a: unknown, b: unknown): boolean => equal(canonicalJson(a), canonicalJson(b))
const invalid = (): never => { throw new NetError('invite_invalid') }
export function invitationProofKey(token: Uint8Array, purpose: 'node' | 'space'): Uint8Array {
  if (token.length !== 32) return invalid()
  return Buffer.from(hkdfSync('sha256', token, Buffer.alloc(0), Buffer.from(purpose === 'node' ? 'mousse-net/enroll/v1' : 'mousse-net/space-join/v1'), 32))
}
/** Exact frozen proof construction. Never log the token, proof key or resulting proof. */
export function invitationProof(key: Uint8Array, exporter: Uint8Array, request: { invite: InviteId; proof?: string }): string {
  if (key.length !== 32 || exporter.length !== 32 || !isId('invite', request.invite)) return invalid()
  const { proof: _proof, ...stable } = request
  return createHmac('sha256', key).update(exporter).update(Buffer.from(request.invite)).update(sha(canonicalJson(stable))).digest('base64url')
}
function name(value: string): void { if (typeof value !== 'string' || !value.length || [...value].length > 256) throw new NetError('bad_request') }
function caps(values: NodeCapability[]): void { if (!values.length || new Set(values).size !== values.length || values.some(cap => !NODE_CAPABILITIES.includes(cap))) throw new NetError('bad_request') }
function currentNode(roster: Roster, node: NodeId, at: number): { signed: Signed; delegation: NodeDelegation } {
  const rows = roster.nodes.map(signed => ({ signed, delegation: verifyDocument<NodeDelegation>(signed, roster.rootKey, 'nodeDelegation') })).filter(row => row.delegation.subject === node).sort((a, b) => b.delegation.keyEpoch - a.delegation.keyEpoch || b.delegation.issuedAt - a.delegation.issuedAt)
  const found = rows[0]
  if (!found || found.delegation.owner !== roster.owner || found.delegation.issuedAt > at || at >= found.delegation.expiresAt || found.delegation.expiresAt - found.delegation.issuedAt > NODE_DELEGATION_TTL_MS || (roster.revoked.find(row => row.subject === node)?.throughKeyEpoch ?? 0) >= found.delegation.keyEpoch) throw new NetError('bad_delegation')
  return found
}
function parseInvite(text: string): { authorization: Signed; token: Uint8Array; document: NodeInviteAuthorization } {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 64 * 1024 || !text.startsWith('mj1_')) return invalid()
  try {
    const outer = parseProtocolJson(decodeBase64(text.slice(4))) as { v: number; authorization: Signed; token: string }
    if (!outer || outer.v !== 1 || Object.keys(outer).sort().join(',') !== 'authorization,token,v') return invalid()
    const raw = parseProtocolJson(decodeBase64(outer.authorization.payload)) as NodeInviteAuthorization
    const roster = verifyDocument<Roster>(raw.roster, raw.rootKey, 'roster')
    const issued = currentNode(roster, raw.node, raw.issuedAt)
    const document = verifyDocument<NodeInviteAuthorization>(outer.authorization, issued.delegation.keys.sign)
    const required = ['v','kind','invite','user','node','rootKey','roster','delegation','routes','transportFingerprint','tokenHash','issuedAt','expiresAt','caps']
    if (required.some(key => !Object.hasOwn(document, key)) || Object.keys(document).some(key => ![...required,'name'].includes(key)) || document.v !== 1 || document.kind !== 'nodeInvite' || !isId('invite', document.invite) || !isId('user', document.user) || !isId('node', document.node) || roster.owner !== document.user || roster.rootKey !== document.rootKey || roster.authorityNode !== document.node || document.issuedAt < roster.issuedAt || !Number.isSafeInteger(document.issuedAt) || !Number.isSafeInteger(document.expiresAt) || document.expiresAt <= document.issuedAt || document.expiresAt > issued.delegation.expiresAt || document.expiresAt - document.issuedAt > NODE_DELEGATION_TTL_MS || !same(document.delegation, issued.signed)) return invalid()
    caps(document.caps); if (document.name !== undefined) name(document.name)
    const routes = verifyDocument<RoutesRecord>(document.routes, issued.delegation.keys.sign, 'routes')
    if (routes.node !== document.node || routes.issuedAt > document.issuedAt || !routes.routes.length || !equal(decodeBase64(document.transportFingerprint, 32), decodeBase64(fingerprint(decodeBase64(issued.delegation.keys.transport)), 32))) return invalid()
    const token = decodeBase64(outer.token, 32)
    if (!equal(sha(token), decodeBase64(document.tokenHash, 32))) return invalid()
    return { authorization: outer.authorization, token, document }
  } catch { return invalid() }
}

/** Profile-scoped P2 enrollment. Identity and receipts share the same real transaction coordinator. */
export class EnrollmentService {
  constructor(private readonly options: EnrollmentServiceOptions) {
    options.db.transaction(() => options.db.database.exec(`CREATE TABLE IF NOT EXISTS net_enrollment_invites(id TEXT PRIMARY KEY, authorization TEXT NOT NULL, token_id TEXT NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','consumed','revoked')), claims TEXT, result TEXT, retain_until INTEGER); CREATE TABLE IF NOT EXISTS net_enrollment_join(singleton INTEGER PRIMARY KEY CHECK(singleton=1), journal TEXT NOT NULL)`))
  }
  private secret(invite: InviteId): string { return `enrollment/${invite}/proof` }
  private join(): JoinJournal | undefined {
    const row = this.options.db.database.prepare('SELECT journal FROM net_enrollment_join WHERE singleton=1').get() as { journal: string } | undefined
    return row ? parseProtocolJson(Buffer.from(row.journal)) as JoinJournal : undefined
  }
  private saveJoin(journal: JoinJournal): void {
    const text = Buffer.from(canonicalJson(journal)).toString()
    this.options.db.charge?.(1, Buffer.byteLength(text))
    this.options.db.database.prepare('INSERT INTO net_enrollment_join VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET journal=excluded.journal').run(text)
  }
  issueNodeInvite(input: { ttlMs?: number; name?: string; caps?: NodeCapability[] } = {}): { text: string; invite: InviteId; expiresAt: number } {
    const { identity, keys, clock, db } = this.options, self = identity.self()
    if (!self?.isAuthority) throw new NetError('forbidden')
    if (!('encryptedAtRest' in keys) || typeof keys.encryptedAtRest !== 'function' || keys.encryptedAtRest() !== true) throw new NetError('keystore_locked', 'Protect this profile before issuing an invitation.')
    const ttl = input.ttlMs ?? 600000, granted = input.caps ?? [...DEFAULT_NODE_CAPABILITIES]
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > NODE_DELEGATION_TTL_MS) throw new NetError('bad_request')
    caps(granted); if (input.name !== undefined) name(input.name)
    const roster = identity.roster()!, rootKey = identity.pinnedRootKey(self.user)!, current = verifyDocument<Roster>(roster, rootKey, 'roster'), routes = this.options.routes(), now = clock.now(), delegation = currentNode(current, self.node, now)
    const routeRecord = verifyDocument<RoutesRecord>(routes, delegation.delegation.keys.sign, 'routes')
    if (routeRecord.node !== self.node || !routeRecord.routes.length || routeRecord.issuedAt > now) throw new NetError('route_unreachable')
    const token = randomBytes(32), invite = newId('invite'), expiresAt = Math.min(now + ttl, delegation.delegation.expiresAt)
    const authorization: NodeInviteAuthorization = { v: 1, kind: 'nodeInvite', invite, user: self.user, node: self.node, rootKey, roster, delegation: delegation.signed, routes, transportFingerprint: fingerprint(decodeBase64(delegation.delegation.keys.transport)), tokenHash: sha(token).toString('base64url'), issuedAt: now, expiresAt, caps: [...granted], ...(input.name === undefined ? {} : { name: input.name }) }
    const signed = identity.signAsNode(authorization), text = 'mj1_' + Buffer.from(canonicalJson({ v: 1, authorization: signed, token: token.toString('base64url') })).toString('base64url')
    if(Buffer.byteLength(text)>64*1024){token.fill(0);throw new NetError('too_large','Invitation exceeds its bounded CLI/IPC container.')}
    const proof = invitationProofKey(token, 'node')
    keys.putSecret(this.secret(invite), proof); proof.fill(0)
    try {
      db.transaction(() => {
        if (!identity.self()?.isAuthority) throw new NetError('forbidden')
        const encoded = Buffer.from(canonicalJson(signed)).toString(); db.charge?.(1, Buffer.byteLength(encoded))
        db.database.prepare('INSERT INTO net_enrollment_invites(id,authorization,token_id,expires,state) VALUES(?,?,?,?,?)').run(invite, encoded, sha(token).subarray(0,16).toString('base64url'), expiresAt, 'active')
      })
      return { text, invite, expiresAt }
    } finally { token.fill(0) }
  }
  revokeInvite(invite: InviteId): void {
    if (!this.options.identity.self()?.isAuthority) throw new NetError('forbidden')
    this.options.db.transaction(() => this.options.db.database.prepare("UPDATE net_enrollment_invites SET state='revoked' WHERE id=? AND state='active'").run(invite))
  }
  async prepareNodeJoin(text: string, requestedName?: string): Promise<PreparedNodeJoin> {
    const parsed = parseInvite(text), { document, authorization, token } = parsed
    const label = requestedName ?? document.name ?? 'Enrolled node'; name(label)
    if (document.name !== undefined && document.name !== label) return invalid()
    let held = this.join()
    if (held && !same(held.authorization, authorization) && held.attempted === false && held.claims.state === 'prepared') {
      const previous = parseProtocolJson(decodeBase64(held.authorization.payload)) as NodeInviteAuthorization
      if (this.options.clock.now() >= previous.expiresAt) { this.abandonPreparedJoin(); held = undefined }
    }
    if (held) {
      token.fill(0)
      if (!same(held.authorization, authorization) || held.name !== label) throw new NetError('conflict', 'Profile has a different durable enrollment attempt.')
      return structuredClone(held.claims)
    }
    if (this.options.clock.now() >= document.expiresAt) return invalid()
    if (this.options.identity.self() || (this.options.keys.state() === 'unlocked' && this.options.keys.rootKey())) throw new NetError('conflict', 'This profile already has an identity.')
    if (this.options.keys.state() === 'missing') await this.options.keys.initialize({ asAuthority: false })
    if (this.options.keys.state() !== 'unlocked') throw new NetError('keystore_locked')
    const node = newId('node'), proof = invitationProofKey(token, 'node'); token.fill(0)
    this.options.keys.putSecret(this.secret(document.invite), proof); proof.fill(0)
    const claims: PreparedNodeJoin = { invite: document.invite, user: document.user, node, rootKey: document.rootKey, authority: document.node, authorityTransportKey: verifyDocument<NodeDelegation>(document.delegation,document.rootKey,'nodeDelegation').keys.transport, transportFingerprint: document.transportFingerprint, routes: document.routes, state: 'prepared' }
    this.options.db.transaction(() => {
      if (this.join() || this.options.identity.self()) throw new NetError('conflict')
      this.saveJoin({ authorization, name: label, claims, attempted: false })
    })
    return claims
  }
  preparedNodeJoin(): PreparedNodeJoin | undefined { return structuredClone(this.join()?.claims) }
  /** Only a request that provably never left this API can be safely discarded locally. */
  abandonPreparedJoin(): void {
    if (this.options.db.database.isTransaction) throw new NetError('forbidden', 'Join abandonment requires an independent committed operation.')
    let invite!: InviteId
    this.options.db.transaction(() => {
      const held = this.join()
      if (!held || held.attempted !== false || held.claims.state !== 'prepared' || this.options.identity.self()) throw new NetError('outcome_uncertain', 'Query the admitting authority before replacing an emitted enrollment request.')
      invite = held.claims.invite
      this.options.db.database.prepare('DELETE FROM net_enrollment_join WHERE singleton=1').run()
    })
    this.options.keys.deleteSecret(this.secret(invite))
  }
  nodeJoinRequest(channel: SecureChannel): EnrollRequestMessage {
    if (this.options.db.database.isTransaction) throw new NetError('forbidden', 'Enrollment requests cannot escape an enclosing transaction.')
    const held = this.join(); if (!held) throw new NetError('not_enrolled')
    if (!equal(decodeBase64(held.claims.transportFingerprint,32), sha(decodeBase64(channel.peerTransportKey)))) throw new NetError('peer_key_mismatch')
    const key = this.options.keys.getSecret(this.secret(held.claims.invite)); if (!key) throw new NetError('keystore_locked')
    const stable = { t: 'enroll.request' as const, invite: held.claims.invite, node: held.claims.node, keys: this.options.keys.nodeKeys(), name: held.name }
    const request = { ...stable, proof: invitationProof(key, channel.exporter('EXPORTER-mousse-net-enroll',32), stable) }
    if (encodeMessage(request).length > PREAUTH_MAX_BYTES) throw new NetError('too_large')
    this.options.db.transaction(() => {
      const current = this.join()
      if (!current || !same(current.authorization, held.authorization) || current.claims.node !== held.claims.node) throw new NetError('conflict')
      this.saveJoin({ ...current, attempted: true })
    })
    return request
  }
  authorityHello(): HelloMessage {
    if(!this.options.identity.self()?.isAuthority)throw new NetError('forbidden')
    return this.localHello()
  }
  localHello(): HelloMessage {
    const identity = this.options.identity, self = identity.self(); if (!self) throw new NetError('not_enrolled')
    const roster = identity.roster()!, current = verifyDocument<Roster>(roster, identity.pinnedRootKey(self.user)!, 'roster'), delegation = currentNode(current,self.node,this.options.clock.now())
    if(!same(delegation.delegation.keys,this.options.keys.nodeKeys()))throw new NetError('bad_delegation')
    return { t:'hello',protoMajor:1,protoMinor:0,caps:['enroll.v1'],node:self.node,delegation:delegation.signed,roster,now:this.options.clock.now() }
  }
  verifyAuthorityHello(hello: HelloMessage, channel: SecureChannel): void {
    const held = this.join(); if (!held || !hello.roster || !hello.delegation || hello.node !== held.claims.authority || !equal(sha(decodeBase64(channel.peerTransportKey)), decodeBase64(held.claims.transportFingerprint,32))) throw new NetError('peer_key_mismatch')
    const roster = verifyDocument<Roster>(hello.roster, held.claims.rootKey, 'roster'), issuer = currentNode(roster,hello.node,this.options.clock.now())
    if (roster.owner !== held.claims.user || roster.rootKey !== held.claims.rootKey || roster.authorityNode !== hello.node || !same(hello.delegation, issuer.signed) || !equal(decodeBase64(issuer.delegation.keys.transport),decodeBase64(channel.peerTransportKey))) throw new NetError('bad_delegation')
    this.options.db.transaction(() => { this.options.identity.pinUser(held.claims.user,held.claims.rootKey); this.options.identity.acceptRoster(hello.roster!,held.claims.rootKey) })
  }
  redeemNode(request: EnrollRequestMessage, channel: SecureChannel): NodeEnrollmentResult {
    const { db, identity, keys, clock } = this.options
    encodeMessage(request)
    if (!identity.self()?.isAuthority) throw new NetError('forbidden')
    if (!equal(decodeBase64(request.keys.transport),decodeBase64(channel.peerTransportKey))) throw new NetError('peer_key_mismatch')
    const key = keys.getSecret(this.secret(request.invite)); if (!key) return invalid()
    const expected = invitationProof(key,channel.exporter('EXPORTER-mousse-net-enroll',32),request)
    if (!equal(decodeBase64(expected,32),decodeBase64(request.proof,32))) return invalid()
    const { proof: _proof, ...claims } = request
    let result!: NodeEnrollmentResult
    db.transaction(() => {
      if (!identity.self()?.isAuthority) throw new NetError('forbidden')
      const row = db.database.prepare('SELECT * FROM net_enrollment_invites WHERE id=?').get(request.invite) as { authorization: string; expires: number; state: string; claims?: string; result?: string; retain_until?: number } | undefined
      if (!row || row.state === 'revoked') return invalid()
      if (row.state === 'consumed') {
        if (!row.claims || !same(parseProtocolJson(Buffer.from(row.claims)),claims) || !row.result || clock.now() >= row.retain_until!) return invalid()
        result = parseProtocolJson(Buffer.from(row.result)) as NodeEnrollmentResult; return
      }
      if (clock.now() >= row.expires || identity.isKnownNode(request.node)) return invalid()
      const signed = parseProtocolJson(Buffer.from(row.authorization)) as Signed, auth = verifyDocument<NodeInviteAuthorization>(signed, keys.nodeKeys().sign)
      if (auth.name !== undefined && auth.name !== request.name) return invalid()
      const delegation = identity.issueNodeDelegation({ node:request.node,keys:request.keys,name:request.name,caps:auth.caps }), roster = identity.roster()!
      result = { delegation, roster }
      const delegated = verifyDocument<NodeDelegation>(delegation,identity.pinnedRootKey(identity.self()!.user)!,'nodeDelegation')
      const bound = Buffer.from(canonicalJson(claims)).toString(), encoded = Buffer.from(canonicalJson(result)).toString(); db.charge?.(1,Buffer.byteLength(bound)+Buffer.byteLength(encoded))
      db.database.prepare("UPDATE net_enrollment_invites SET state='consumed',claims=?,result=?,retain_until=? WHERE id=?").run(bound,encoded,delegated.expiresAt,request.invite)
      this.options.fault?.('enroll.beforeCommit')
    })
    return result
  }
  acceptNodeJoin(result: NodeEnrollmentResult, channel: SecureChannel): PreparedNodeJoin {
    const held = this.join(); if (!held) throw new NetError('not_enrolled')
    const { claims } = held
    if (!equal(sha(decodeBase64(channel.peerTransportKey)),decodeBase64(claims.transportFingerprint,32))) throw new NetError('peer_key_mismatch')
    const roster = verifyDocument<Roster>(result.roster,claims.rootKey,'roster'), delegation = verifyDocument<NodeDelegation>(result.delegation,claims.rootKey,'nodeDelegation')
    if (roster.owner !== claims.user || roster.rootKey !== claims.rootKey || roster.authorityNode !== claims.authority || delegation.owner !== claims.user || delegation.subject !== claims.node || delegation.name !== held.name || !same(delegation.keys,this.options.keys.nodeKeys()) || !roster.nodes.some(row=>same(row,result.delegation))) throw new NetError('bad_delegation')
    this.options.db.transaction(() => {
      const latest = this.join(); if (!latest || !same(latest.claims,claims)) throw new NetError('conflict')
      const enrolled = new NetIdentityService({ database:this.options.db.database,keys:this.options.keys,clock:this.options.clock,coordinator:this.options.db,self:{user:claims.user,node:claims.node} })
      enrolled.pinUser(claims.user,claims.rootKey); enrolled.acceptRoster(result.roster,claims.rootKey)
      const challenge = Buffer.from('mousse-net/enrollment-local-possession/v1')
      enrolled.verifyAuthor({user:claims.user,node:claims.node,keyEpoch:delegation.keyEpoch},challenge,this.options.keys.signAsNode(challenge),this.options.clock.now(),'newWork')
      latest.claims.state='enrolled'; this.saveJoin(latest); this.options.fault?.('join.beforeCommit')
    })
    return this.preparedNodeJoin()!
  }
}
