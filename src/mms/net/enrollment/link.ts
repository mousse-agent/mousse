import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import type {
  InviteId,
  LinkClaimMessage,
  LinkResultMessage,
  NodeId,
  OfferId,
  Route,
  Signed,
  WireMessage
} from '../../../shared/net'
import {
  ENROLLMENT_JOINER_MAX_BYTES,
  NET_ERRORS,
  NODE_DELEGATION_TTL_MS,
  PREAUTH_DEADLINE_MS,
  NetError,
  isId,
  newId
} from '../../../shared/net'
import type { Clock, KeyStore, SecureChannel } from '../contracts'
import { decodeBase64 } from '../identity/crypto'
import { createMux } from '../link/mux'
import type { NetDatabase } from '../store/database'
import { canonicalJson, parseProtocolJson } from '../sync/codec'

/**
 * A connect link: one piece of copyable text that lets another computer reach this one and prove it holds the
 * link. `ml1_` + base64url of the canonical JSON `{v:1, a, f, k, l, o, r}`:
 * - `a`: adds a computer (made on the keeper) or, false, only connects devices already in the list;
 * - `f`: the maker's transport fingerprint (base64url SHA-256 of its certificate key), pinned by every dial;
 * - `k`: a 32-byte random key; only a proof derived from it is ever sent;
 * - `l`: the list id, base64url SHA-256 of the list's root key, so the pasting computer picks its case offline;
 * - `o`: the offer id the maker keeps;
 * - `r`: up to 8 `[transport, address]` pairs, the maker's automatic LAN listener first.
 * No name and no expiry travel in it: the maker keeps both.
 */
export interface ConnectLink {
  add: boolean
  fingerprint: string
  key: Uint8Array
  list: string
  offer: OfferId
  routes: Route[]
}
export const LINK_PREFIX = 'ml1_'
/** How long a new link accepts a first claim. */
export const LINK_TTL_MS = 30 * 60_000
const MAX_LINK_ROUTES = 8
const MAX_LINK_BYTES = 4096
const LINK_TRANSPORTS = new Set(['direct', 'cloudflared'])
/** The TLS exporter label the offer proof is bound to (32 bytes, empty context). */
export const LINK_EXPORTER = 'EXPORTER-mousse-net-link'

const sha = (bytes: Uint8Array): Buffer => createHash('sha256').update(bytes).digest()
const equal = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && timingSafeEqual(a, b)
const stale = (): never => {
  throw new NetError('invite_invalid', undefined, { details: { reason: 'stale' } })
}

/** The list id a link carries: base64url SHA-256 of the 32-byte root key. */
export function listId(rootKey: string): string {
  return sha(decodeBase64(rootKey, 32)).toString('base64url')
}

function linkRoute(transport: unknown, address: unknown): Route {
  if (
    typeof transport !== 'string' ||
    !LINK_TRANSPORTS.has(transport) ||
    typeof address !== 'string' ||
    address.length > 2048
  )
    throw new NetError('bad_request')
  const url = new URL(address)
  if (
    !['ws:', 'wss:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/mousse-net' ||
    (transport === 'cloudflared' && url.protocol !== 'wss:')
  )
    throw new NetError('bad_request')
  return { transport, address, priority: 0 }
}

export function formatLink(link: ConnectLink): string {
  if (!link.routes.length || link.routes.length > MAX_LINK_ROUTES || link.key.length !== 32)
    throw new NetError('bad_request')
  const body = canonicalJson({
    v: 1,
    a: link.add,
    f: link.fingerprint,
    k: Buffer.from(link.key).toString('base64url'),
    l: link.list,
    o: link.offer,
    r: link.routes.map((route) => [route.transport, route.address])
  })
  return LINK_PREFIX + Buffer.from(body).toString('base64url')
}

/** Reads a pasted link; anything else, or a link with a field out of shape, is `bad_request`. */
export function parseLink(text: unknown): ConnectLink {
  if (
    typeof text !== 'string' ||
    text.length > MAX_LINK_BYTES ||
    !text.trim().startsWith(LINK_PREFIX)
  )
    throw new NetError('bad_request', 'This isn’t a Mousse link.')
  try {
    const value = parseProtocolJson(decodeBase64(text.trim().slice(LINK_PREFIX.length))) as Record<
      string,
      unknown
    >
    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).sort().join(',') !== 'a,f,k,l,o,r,v' ||
      value.v !== 1 ||
      typeof value.a !== 'boolean' ||
      !isId('offer', value.o) ||
      typeof value.f !== 'string' ||
      typeof value.l !== 'string' ||
      typeof value.k !== 'string' ||
      !Array.isArray(value.r) ||
      !value.r.length ||
      value.r.length > MAX_LINK_ROUTES
    )
      throw new NetError('bad_request')
    decodeBase64(value.f, 32)
    decodeBase64(value.l, 32)
    const routes = (value.r as unknown[]).map((row) => {
      if (!Array.isArray(row) || row.length !== 2) throw new NetError('bad_request')
      return linkRoute(row[0], row[1])
    })
    return {
      add: value.a,
      fingerprint: value.f,
      key: decodeBase64(value.k, 32),
      list: value.l,
      offer: value.o,
      routes
    }
  } catch {
    throw new NetError('bad_request', 'This isn’t a Mousse link.')
  }
}

/** The addresses a link offers for a LAN listener on `port`: each IPv4 interface given, then loopback last. */
export function lanLinkRoutes(port: number, addresses: readonly string[]): Route[] {
  const unique = [...new Set(addresses.filter((address) => isIP(address) === 4))]
  return [...unique.filter((address) => address !== '127.0.0.1'), '127.0.0.1'].map((address) => ({
    transport: 'direct',
    address: `ws://${address}:${port}/mousse-net`,
    priority: 0
  }))
}

/** Keeps the list within the link's 8 routes, with loopback (same computer, another copy) always last. */
export function linkRoutes(lan: readonly Route[], published: readonly Route[]): Route[] {
  const loopback = lan.filter((route) => new URL(route.address).hostname === '127.0.0.1'),
    seen = new Set<string>(),
    rows: Route[] = []
  for (const route of [...lan.filter((route) => !loopback.includes(route)), ...published]) {
    if (!LINK_TRANSPORTS.has(route.transport) || seen.has(route.address)) continue
    seen.add(route.address)
    rows.push({ transport: route.transport, address: route.address, priority: 0 })
  }
  return [...rows.slice(0, MAX_LINK_ROUTES - loopback.length), ...loopback.slice(0, 1)]
}

/** Whether any of `routes` can be dialled from another computer: an address that is not this computer's loopback. */
export function reachableFromOthers(routes: readonly Route[]): boolean {
  return routes.some((route) => {
    const host = new URL(route.address).hostname
    return host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]'
  })
}

export function linkProofKey(key: Uint8Array): Buffer {
  if (key.length !== 32) throw new NetError('bad_request')
  return Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), Buffer.from('mousse-net/link/v1'), 32))
}
/** HMAC-SHA256(proofKey, exporter32 ‖ UTF8(offerId) ‖ SHA-256(canonical claim without proof)). */
export function linkProof(
  proofKey: Uint8Array,
  exporter: Uint8Array,
  request: { t: 'link.claim'; offer: OfferId; want: 'add' | 'connect'; proof?: string }
): string {
  if (proofKey.length !== 32 || exporter.length !== 32 || !isId('offer', request.offer))
    throw new NetError('invite_invalid')
  const { proof: _proof, ...stable } = request
  return createHmac('sha256', proofKey)
    .update(exporter)
    .update(Buffer.from(request.offer))
    .update(sha(canonicalJson(stable)))
    .digest('base64url')
}

export type OfferMode = 'add' | 'connect'
export type OfferState = 'unused' | 'claimed' | 'consumed' | 'cancelled'
interface OfferRow {
  id: OfferId
  mode: OfferMode
  state: OfferState
  expires: number
  claimer: string | null
  invite: InviteId | null
  node: NodeId | null
}
/** What the maker does for a proven claim, supplied by the network service. */
export interface LinkClaimHandlers {
  /** This computer: its node, and whether it keeps the list (only the keeper adds a computer). */
  self(): { node: NodeId; keeper: boolean }
  /** An invitation for a computer, pinned to the claimer's transport fingerprint, with empty routes allowed. */
  issue(claimer: string): { text: string; invite: InviteId }
  revoke(invite: InviteId): void
  /** The device of this list whose current transport key is `transportKey`, if any. */
  listed(transportKey: string): NodeId | undefined
  /** In the transaction that consumes a connect claim: a device with no record is connected here. */
  connect(node: NodeId): void
  routes(): Signed
}

/**
 * The connect links made on this computer (`net_link_offers`), and the offer path that answers them. An offer is
 * `unused` until a proven claim; `claimed` once an invitation was issued for one joiner's key; `consumed` once that
 * joiner enrolled, or a device of the list connected with it; `cancelled` by a new link, its expiry passing unused,
 * or a restart. A cancelled or expired offer takes no new claim; a consumed one still answers the claimer that
 * consumed it (an enrollment's own result is kept by its invitation).
 */
export class LinkOffers {
  constructor(
    private readonly db: NetDatabase,
    private readonly keys: KeyStore,
    private readonly clock: Clock
  ) {
    db.transaction(() =>
      db.database.exec(
        `CREATE TABLE IF NOT EXISTS net_link_offers(id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('add','connect')), state TEXT NOT NULL CHECK(state IN ('unused','claimed','consumed','cancelled')), created INTEGER NOT NULL, expires INTEGER NOT NULL, claimer TEXT, invite TEXT, node TEXT); CREATE INDEX IF NOT EXISTS net_link_offers_invite ON net_link_offers(invite)`
      )
    )
  }
  private secret(offer: OfferId): string {
    return `link/${offer}/proof`
  }
  private row(offer: OfferId): OfferRow | undefined {
    return this.db.database.prepare('SELECT * FROM net_link_offers WHERE id=?').get(offer) as
      | OfferRow
      | undefined
  }
  /**
   * Stops every offer that can still take a new claim, and returns the invitations issued on claimed ones, for the
   * caller to revoke. A consumed offer is left as it is.
   */
  cancelOpen(): InviteId[] {
    const open = this.db.database
      .prepare("SELECT id,invite FROM net_link_offers WHERE state IN ('unused','claimed')")
      .all() as Array<{ id: OfferId; invite: InviteId | null }>
    if (!open.length) return []
    this.db.transaction(() => {
      this.db.charge(open.length)
      this.db.database
        .prepare(
          "UPDATE net_link_offers SET state='cancelled' WHERE state IN ('unused','claimed')"
        )
        .run()
    })
    this.forget(open.map((row) => row.id))
    return open.flatMap((row) => (row.invite ? [row.invite] : []))
  }
  /** Drops offers' keys; with the key store locked they stay, unused, since the row decides. */
  private forget(offers: readonly OfferId[]): void {
    for (const offer of offers)
      try {
        this.keys.deleteSecret(this.secret(offer))
      } catch {
        // Locked: the row is what stops a claim.
      }
  }
  /** A new offer; every earlier open one is cancelled first (their invitations are returned to revoke). */
  make(mode: OfferMode, ttlMs = LINK_TTL_MS): {
    offer: OfferId
    key: Buffer
    expiresAt: number
    revoke: InviteId[]
  } {
    const revoke = this.cancelOpen()
    this.prune()
    const offer = newId('offer'),
      key = randomBytes(32),
      now = this.clock.now(),
      expiresAt = now + ttlMs
    const proof = linkProofKey(key)
    try {
      this.keys.putSecret(this.secret(offer), proof)
    } finally {
      proof.fill(0)
    }
    this.db.transaction(() => {
      this.db.charge(1)
      this.db.database
        .prepare(
          "INSERT INTO net_link_offers(id,mode,state,created,expires) VALUES(?,?,'unused',?,?)"
        )
        .run(offer, mode, now, expiresAt)
    })
    return { offer, key, expiresAt, revoke }
  }
  /** Consumed offers older than a pass lasts are forgotten, with their keys. */
  private prune(): void {
    const old = this.db.database
      .prepare("SELECT id FROM net_link_offers WHERE state IN ('consumed','cancelled') AND created<?")
      .all(this.clock.now() - NODE_DELEGATION_TTL_MS) as Array<{ id: OfferId }>
    if (!old.length) return
    this.db.transaction(() => {
      for (const row of old)
        this.db.database.prepare('DELETE FROM net_link_offers WHERE id=?').run(row.id)
    })
    this.forget(old.map((row) => row.id))
  }
  state(offer: OfferId): OfferState | undefined {
    return this.row(offer)?.state
  }
  /**
   * In the transaction that enrolls `node` with `invite`: when the invitation was issued on a claimed offer made
   * here, that offer is consumed and the device came in by a link (it is held until Allow).
   */
  redeemed(invite: InviteId, node: NodeId): boolean {
    const changed = this.db.database
      .prepare(
        "UPDATE net_link_offers SET state='consumed',node=? WHERE invite=? AND state='claimed'"
      )
      .run(node, invite)
    return Number(changed.changes) > 0
  }
  /**
   * Answers one claim on the offer path. Nothing is read beyond the offer row and nothing is written until the
   * claim's proof, bound to this TLS channel, checks out: a claim without the link's key binds and stores nothing.
   */
  claim(
    request: LinkClaimMessage,
    channel: SecureChannel,
    handlers: LinkClaimHandlers
  ): LinkResultMessage {
    const row = isId('offer', request.offer) ? this.row(request.offer) : undefined
    if (!row) throw new NetError('invite_invalid')
    const key = this.keys.getSecret(this.secret(row.id))
    if (!key) return stale()
    try {
      const expected = linkProof(key, channel.exporter(LINK_EXPORTER, 32), request)
      if (!equal(decodeBase64(expected, 32), decodeBase64(request.proof, 32)))
        throw new NetError('invite_invalid')
    } finally {
      key.fill(0)
    }
    const claimer = sha(decodeBase64(channel.peerTransportKey)).toString('base64url'),
      now = this.clock.now()
    if (request.want === 'connect') {
      const node = handlers.listed(channel.peerTransportKey)
      if (!node)
        throw new NetError('forbidden', 'This device isn’t in the list.', {
          details: { reason: 'not_listed' }
        })
      if (node === handlers.self().node) throw new NetError('bad_request')
      const again = row.state === 'consumed' && row.mode === 'connect' && row.node === node
      if (!again && (row.state !== 'unused' || now >= row.expires)) return stale()
      this.db.transaction(() => {
        if (!again) {
          const current = this.row(row.id)
          if (current?.state !== 'unused') stale()
          this.db.charge(1)
          this.db.database
            .prepare(
              "UPDATE net_link_offers SET state='consumed',claimer=?,node=? WHERE id=? AND state='unused'"
            )
            .run(claimer, node, row.id)
        }
        handlers.connect(node)
      })
      return { t: 'link.result', node: handlers.self().node, routes: handlers.routes() }
    }
    if (row.mode !== 'add' || !handlers.self().keeper) throw new NetError('forbidden')
    if (
      row.state === 'consumed' ||
      row.state === 'cancelled' ||
      now >= row.expires ||
      (row.state === 'claimed' && row.claimer !== claimer)
    )
      return stale()
    // The same joiner asking again (its answer was lost) gets a fresh invitation; the earlier one stops working.
    const issued = handlers.issue(claimer)
    let kept = false
    try {
      this.db.transaction(() => {
        const current = this.row(row.id)
        if (
          !current ||
          current.state !== row.state ||
          current.invite !== row.invite ||
          (current.state === 'claimed' && current.claimer !== claimer)
        )
          stale()
        this.db.charge(1)
        this.db.database
          .prepare("UPDATE net_link_offers SET state='claimed',claimer=?,invite=? WHERE id=?")
          .run(claimer, issued.invite, row.id)
        kept = true
      })
    } finally {
      if (!kept) handlers.revoke(issued.invite)
    }
    if (row.invite) handlers.revoke(row.invite)
    return { t: 'link.result', invite: issued.text }
  }
}

/** The error answer on the offer path. */
export function linkError(error: unknown): Extract<LinkResultMessage, { error: unknown }> {
  const code = error instanceof NetError ? error.code : 'internal'
  return {
    t: 'link.result',
    error: { code, message: NET_ERRORS[code].message, retryable: NET_ERRORS[code].retryable }
  }
}

export type LinkAnswer =
  | { kind: 'invite'; invite: string }
  | { kind: 'routes'; node: NodeId; routes: Signed }

/**
 * The pasting side of the offer path, on a channel already pinned to the link's fingerprint: one claim with a proof
 * bound to this channel, one answer, then the connection ends. Bounded like any enrollment quarantine.
 */
export async function claimOffer(
  channel: SecureChannel,
  link: ConnectLink,
  want: 'add' | 'connect',
  clock: Clock
): Promise<LinkAnswer> {
  let bytes = 0
  const mux = createMux(channel.stream, {
    clock,
    onBytesReceived: (count) => {
      bytes += count
      if (bytes > ENROLLMENT_JOINER_MAX_BYTES) throw new NetError('too_large')
    }
  })
  const proofKey = linkProofKey(link.key)
  try {
    const stable = { t: 'link.claim' as const, offer: link.offer, want }
    const request: LinkClaimMessage = {
      ...stable,
      proof: linkProof(proofKey, channel.exporter(LINK_EXPORTER, 32), stable)
    }
    const answer = new Promise<WireMessage>((resolve, reject) => {
      const timer = clock.setTimeout(
        () => reject(new NetError('deadline_exceeded')),
        PREAUTH_DEADLINE_MS
      )
      const stops = [
        mux.onMessage((lane, message) => {
          timer.cancel()
          for (const stop of stops) stop()
          if (lane !== 'control' || message.parts.length) reject(new NetError('forbidden'))
          else resolve(message.header)
        }),
        mux.onClose((error) => {
          timer.cancel()
          for (const stop of stops) stop()
          reject(error ?? new NetError('peer_offline'))
        })
      ]
    })
    await mux.send('control', { header: request, parts: [] })
    const header = await answer
    if (header.t !== 'link.result') throw new NetError('incompatible_peer')
    if ('error' in header)
      throw new NetError(header.error.code, undefined, { details: { from: 'peer' } })
    if ('invite' in header) {
      if (want !== 'add' || !header.invite.startsWith('mj1_')) throw new NetError('bad_request')
      return { kind: 'invite', invite: header.invite }
    }
    if (want !== 'connect') throw new NetError('bad_request')
    return { kind: 'routes', node: header.node, routes: header.routes }
  } finally {
    proofKey.fill(0)
    mux.close()
    channel.close()
  }
}
