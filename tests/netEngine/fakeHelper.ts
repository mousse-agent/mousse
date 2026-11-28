/**
 * A fake network helper for tests: the helper's side of the app channel (design §2), with a fake network between
 * helpers instead of the engine. It frames, hands out stream handles that are never reused, grants and honours
 * app credit, keeps FIN behind a stream's data, and reports `conn.up`, `conn.down`, `stream.incoming` and
 * `stream.reset` as the real helper does. It pairs as the helper does too: `invite.create`, `join` (the host's app
 * hears `approval`, answers it, hears `enrolled`; the joiner's connection comes up before the join's reply),
 * `grant.add` and `peer.add`; and it may pause networking (`hello.paused`, `net.paused`, `net.resumed`). A helper
 * can be killed (its app sees the pipe close and its peers see `conn.down`) and a new one started for the same
 * identity.
 *
 * Every engine message that crosses the fake network is decoded and recorded, and a test may drop one (`tap`).
 */
import { randomBytes } from 'node:crypto'
import {
  creditFrame,
  dataFrame,
  DATA_FIN,
  FRAME_CREDIT,
  FRAME_DATA,
  FrameReader,
  jsonFrame,
  type AppPipe
} from '../../src/mms/netEngine/helper/appChannel'
import {
  encodeMessage,
  MessageReader,
  type EngineMessage
} from '../../src/mms/netEngine/session/frame'
import { decodeTicket, encodeTicket, ticketHash, type TicketFields } from './ticketCbor'
import {
  automaticRoute,
  isLoopbackIp,
  parseRoute,
  routeClass,
  type RouteClass
} from '../../src/shared/netEngine/routes'

/** What a 1.1 helper keeps for one peer: the hints it heard (ticket, `peer.add`), the owner's addresses, approvals. */
interface Known {
  hints: string[]
  owner: string[]
  /** Destinations approved for this peer (`join {approved}` and the owner's addresses). */
  approved: Set<string>
  /** The owner's SSH routes (`{route_id, selector, shell}`). */
  ssh: Array<Record<string, unknown>>
}

/** A helper's routes as `routes.config` keeps them (§1.5). */
export interface FakeReach {
  lan: boolean
  tailnet: boolean
  public: string[]
  forward_to?: string | null
  tunnels: string[]
  port?: number
}

const STREAM_CREDIT = 256 * 1024
/** A role name (wire.md §7): 1 to 32 bytes of `[a-z0-9-]`. */
const ROLE = /^[a-z0-9-]{1,32}$/

/** A Send link invitation at its host (kind 2): the code it shows and the tries left (design 1b §5.1). */
export interface FakeLinkInvite extends TicketFields {
  ticket: string
  hash: string
  code: string
  attemptsLeft: number
  ended?: string
  /** The role fixed in the invitation (§8.1); absent: `owner`. */
  role?: string
}

/** A joiner's flow record for one ticket, as the helper keeps it on disk (§5.4). */
export interface FakeFlow {
  attemptsLeft: number
  /** The confirmation was sent and the outcome is not known yet. */
  pending?: boolean
  /** The ticket's `PAIRED`, until `join.ack`. */
  done?: { identity: string; name: string; role: string }
  exhausted?: boolean
}

/** A six-digit code. */
const newCode = (): string => String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0')

export interface Crossed {
  /** The identity of the helper the message left from. */
  from: string
  label: string
  /** The method of the call the stream carries (`mousse.rpc`), from its first message. */
  method?: string
  header: EngineMessage['header']
  parts: Uint8Array[]
}

/** One direction of a stream on the fake wire, as the receiving helper holds it. */
interface End {
  helper: FakeHelper
  handle: number
  /** Credit the app granted this helper for DATA to it. */
  appCredit: number
  /** What waits for that credit. */
  queue: Array<{ bytes: Uint8Array; fin: boolean }>
  other?: End
  label: string
  /** Messages being read from what this side's app writes, to record and filter them. */
  reader: MessageReader
  method?: string
  closed: boolean
}

interface Conn {
  /** Each helper's number for the connection (per helper, never reused). */
  id: { [identity: string]: number }
  a: FakeHelper
  b: FakeHelper
  ends: Set<End>
  up: boolean
  /** The route it came up on (1.1); a relay's (Phase 3) names its destination. */
  route?: { kind: string; class: string; destination?: string }
}

export class FakeNetwork {
  private readonly helpers = new Map<string, FakeHelper>()
  /** The addresses each identity's helper says it listens on (`hello`'s `routes`); none unless a test sets them. */
  readonly routes = new Map<string, string[]>()
  /** For each host identity, the grant each caller identity holds there (the helper's numbers; tests may name one). */
  private readonly grants = new Map<string, Map<string, number | string>>()
  /**
   * The receipt saved with a grant, by grant number: `grant.add`'s, or the invitation an enrollment used (kept while
   * the grant lives, as the helper does).
   */
  readonly receipts = new Map<string, string>()
  /** By helper identity: an op fails (`busy`, a helper still starting) this many more times before it answers. */
  readonly failing = new Map<string, Record<string, number>>()
  /**
   * By helper identity: this many more `grant.add_connected` saves fail after the grant was added in memory
   * (`store_failed`, the grant in effect), as a full disk would.
   */
  readonly storeFailing = new Map<string, number>()
  /** For each identity, the identities it may dial (its peers). */
  private readonly peers = new Map<string, Set<string>>()
  /** The role each peer record says its helper holds at that peer, by `"<from> <to>"`. */
  private readonly peerRoles = new Map<string, string>()
  /** Open invitations by ticket, with their host. */
  readonly invitations = new Map<string, { host: string; invitation: string; routes: string[]; role?: string }>()
  /** Each grant's role and revision (§8), by grant number; absent: `owner` at revision 1. */
  readonly roles = new Map<string, { role: string; revision: number }>()
  /** By helper identity: this many more `grant.set_role` saves fail (`store_failed`) before one goes through. */
  readonly setRoleFailing = new Map<string, number>()
  /** Whether a stream the dialler opens is handed to the app with its grant's role (§8.4); false plays older ones. */
  streamRoles = true
  private nextGrant = 1
  private readonly conns = new Set<Conn>()
  private next = 1
  readonly crossed: Crossed[] = []
  /** Send link invitations by id, with their host. */
  readonly links = new Map<string, FakeLinkInvite>()
  /** Each joiner's flow records by ticket hash, kept across its helper's restarts. */
  private readonly flows = new Map<string, Map<string, FakeFlow>>()
  /** The `approved` list each Send link join carried, by joiner identity, in order. */
  readonly approvedSent: Array<{ joiner: string; approved: string[] }> = []
  /**
   * Helper defects a check's controls build in (the real helper's `mousse_control` cfgs): `journal-pins-link`,
   * `link-accepts-kind1`, `invitation-survives-exhaustion`, `skip-code-confirm`, `joiner-records-in-memory`,
   * `host-attempts-reset-on-reconnect`.
   */
  readonly defects = new Set<string>()
  /** Decides each message that crosses; `drop` loses it on the way. */
  tap?: (message: Crossed) => 'drop' | void
  /**
   * The protocol minor its helpers speak: 0 (1a, the default: dials by identity, private addresses only) or 1
   * (1b: routes with approvals, `routes.config`, `routes.test`, `conn.up.route`).
   */
  minor = 0
  /**
   * What its helpers list in a 1.2 `hello` (`minor` 2): only then do they answer `routes.available`, `join.check`,
   * `join.probe`, `grant.revoke_local` and `invite.create {way}`, each under its feature. `grant-roles` is listed and
   * answered at any minor, as the helper this app ships with takes roles; a test of a helper without roles drops it.
   */
  features: string[] = ['grant-roles']
  /**
   * With `version-refusals`: each helper's last refusal for version per device (`version_refusal` on its
   * `peers.list` and `grants.list` rows), by the helper's identity, then the device's.
   */
  readonly versionRefusals = new Map<string, Map<string, { peer_minor: number; local_minor: number; since: number }>>()
  /**
   * Identities still on an older protocol minor (the value): with `version-refusals`, a dial to one fails with
   * `unsupported_version {peer_minor}` and is recorded; a dial that connects clears the dialler's refusal.
   */
  readonly outdated = new Map<string, number>()
  /** Each identity's `routes.available` answer; unset: LAN ready with its routes, the other ways off. */
  readonly ways = new Map<string, Array<Record<string, unknown>>>()
  /** How long a `join.probe` takes before it answers (a cancel answers it at once). */
  probeDelayMs = 0
  /**
   * Whether connections carry calls both ways (wire minor 3): `conn.up {both}`; the dialled side may open streams
   * on the dialler's connection, which its helper passes on as `stream.incoming` with the dialler's own live grant
   * for the dialled side (refused without one). Off: such opens answer `one_way`.
   */
  bothWays = false
  /** Identities no one can dial (a computer that only dials out, behind its firewall); they still dial others. */
  readonly outboundOnly = new Set<string>()
  /** What each identity's helper listens on besides what it advertises (its loopback listener, say). */
  readonly listening = new Map<string, string[]>()
  /** Each identity's kept TCP port (`hello.port`). */
  readonly ports = new Map<string, number>()
  /** Each identity's routes config (`routes.config`, `hello.routes_config`). */
  readonly reach = new Map<string, FakeReach>()
  /** Classes the checks map routes to, as `MOUSSE_NET_TEST_CLASS_MAP` does for the debug helper. */
  classMap?: Record<string, RouteClass>
  /**
   * SSH servers by hostname (1b §3.4): the computer whose `mousse-cli net-engine ssh` answers there, and its
   * helper identity, which a pipe over that route reaches.
   */
  readonly sshServers = new Map<
    string,
    { owns(identity: string): boolean; serve(request: Record<string, unknown>): Promise<Record<string, unknown>> }
  >()
  /** SSH routes `ssh.resolve` made, by route id. */
  readonly sshRoutes = new Map<string, { hostname: string; user: string; pinned: boolean }>()
  /** A setup session whose reply is lost on the way back (the session dropped): answers true to lose it. */
  sshLose?: (request: Record<string, unknown>) => boolean
  /** What each identity's helper keeps for each peer (it survives the helper's restarts, as `peers.json` does). */
  private readonly known = new Map<string, Map<string, Known>>()
  /** Identities reached only through a relay (Phase 3): dials to one come up on that relay's destination. */
  readonly relayed = new Map<string, string>()
  /** Each identity's relays (Phase 3), kept across its helper's restarts; none means its helper has no relays. */
  readonly relays = new Map<string, FakeRelays>()
  /** Each identity's Plus (Phase 4), kept across its helper's restarts; none means its helper has no Plus. */
  readonly plus = new Map<string, FakePlus>()

  /** @internal Every peer `self` keeps something for. */
  knownPeers(self: string): Array<[string, Known]> {
    return [...(this.known.get(self) ?? [])]
  }

  /** @internal What `self` keeps for `peer`. */
  knownFor(self: string, peer: string): Known {
    let mine = this.known.get(self)
    if (!mine) this.known.set(self, (mine = new Map()))
    let entry = mine.get(peer)
    if (!entry) mine.set(peer, (entry = { hints: [], owner: [], approved: new Set(), ssh: [] }))
    return entry
  }

  /** Whether a 1.1 helper dials `route` without approval: private literals, and loopback unless a class map is set. */
  automatic(route: string): boolean {
    return automaticRoute(route, !this.classMap)
  }

  /** The class `conn.up.route` reports for `route`. */
  classOf(route: string): RouteClass {
    const mapped = this.classMap?.[route]
    if (mapped) return mapped
    const parsed = parseRoute(route)
    if (!parsed) return 'public'
    if (parsed.literal && isLoopbackIp(parsed.host)) return 'lan'
    const cls = routeClass(parsed)
    return cls === 'forbidden' ? 'public' : cls
  }

  /** What `identity`'s helper answers on: what it advertises and what it listens on besides. */
  listensOn(identity: string): string[] {
    return [...(this.routes.get(identity) ?? []), ...(this.listening.get(identity) ?? [])]
  }

  /** @internal The routes `from` may dial `to` on, in order: the owner's addresses, then the hints it approved. */
  candidates(from: string, to: string): string[] {
    const known = this.knownFor(from, to)
    const out: string[] = []
    for (const route of [...known.owner, ...known.hints])
      if (!out.includes(route) && (this.automatic(route) || known.approved.has(route))) out.push(route)
    return out
  }

  /**
   * `caller` holds a grant at `host` (a new grant number when none is given) and knows `host` as a peer; answers
   * the grant, as `grant.add` does.
   */
  grant(
    host: string,
    caller: string,
    grant?: number | string,
    role?: string
  ): { grant: number | string; already: boolean } {
    let held = this.grants.get(host)
    if (!held) this.grants.set(host, (held = new Map()))
    const had = held.get(caller)
    if (grant === undefined && had !== undefined) return { grant: had, already: true }
    const given = grant ?? this.nextGrant++
    held.set(caller, given)
    if (role && role !== 'owner') this.roles.set(String(given), { role, revision: 1 })
    // As `PAIRED`: the caller records the role it was given, and keeps it until its app says another.
    this.peer(caller, host, role ?? 'owner')
    return { grant: given, already: false }
  }

  /**
   * `grant.add_connected` on `host`'s connection `conn` (§7): the connection's peer gets a grant at `host`, without a
   * peer record; an inbound connection answers the grant it is served under. Undefined when the connection is down.
   */
  grantConnected(
    host: FakeHelper,
    conn: Conn,
    role?: string
  ): { grant: number | string; already: boolean } | undefined {
    if (!conn.up || !this.conns.has(conn)) return undefined
    const peer = conn.a === host ? conn.b.identity : conn.a.identity
    let held = this.grants.get(host.identity)
    if (conn.b === host) {
      // Inbound: the peer is live only under a served grant of this computer.
      const served = held?.get(peer)
      return served === undefined ? undefined : { grant: served, already: true }
    }
    if (!held) this.grants.set(host.identity, (held = new Map()))
    const had = held.get(peer)
    if (had !== undefined) return { grant: had, already: true }
    const given = this.nextGrant++
    held.set(peer, given)
    if (role && role !== 'owner') this.roles.set(String(given), { role, revision: 1 })
    return { grant: given, already: false }
  }

  /**
   * `caller` holds an `owner` grant at `host` already, written with no peer record (an Allow whose row write was
   * lost, or an older build's grant); answers it.
   */
  heldAlready(host: string, caller: string): number {
    let held = this.grants.get(host)
    if (!held) this.grants.set(host, (held = new Map()))
    const given = this.nextGrant++
    held.set(caller, given)
    return given
  }

  /** Whether `caller` holds a live grant at `host`. */
  holds(host: string, caller: string): boolean {
    return this.grants.get(host)?.has(caller) ?? false
  }

  /** The identities `from` may dial (its pins). */
  peersOf(from: string): string[] {
    return [...(this.peers.get(from) ?? [])]
  }

  /** @internal A joiner's flow records (in its helper's memory only under `joiner-records-in-memory`). */
  flowsOf(helper: FakeHelper): Map<string, FakeFlow> {
    if (this.defects.has('joiner-records-in-memory')) return helper.memoryFlows
    let held = this.flows.get(helper.identity)
    if (!held) this.flows.set(helper.identity, (held = new Map()))
    return held
  }

  /** The grants callers hold at `host`, as `grants.list` answers. */
  grantsAt(host: string): Array<{ caller: string; grant: number | string; role: string; revision: number }> {
    return [...(this.grants.get(host) ?? [])].map(([caller, grant]) => ({ caller, grant, ...this.roleOf(grant) }))
  }

  /** A grant's role and revision. */
  roleOf(grant: number | string): { role: string; revision: number } {
    return this.roles.get(String(grant)) ?? { role: 'owner', revision: 1 }
  }

  /**
   * `grant.set_role` at `host`: the grant keeps its number and takes `role` at the next revision, and every connection
   * between `host` and its caller closes (`cancelled`), as the helper's edit does (§8.3).
   */
  setRole(host: string, grant: number, expected: number, role: string): Record<string, unknown> {
    const found = this.grantsAt(host).find((item) => Number(item.grant) === grant)
    if (!found) return { error: 'no_grant', reason: 'no such grant' }
    if (found.revision !== expected) return { error: 'revision_conflict', reason: 'stale revision' }
    if (found.role === role) return { grant, role, revision: found.revision, changed: false }
    const failing = this.setRoleFailing.get(host) ?? 0
    if (failing > 0) {
      this.setRoleFailing.set(host, failing - 1)
      return { error: 'store_failed', reason: 'disk' }
    }
    const revision = found.revision + 1
    this.roles.set(String(found.grant), { role, revision })
    for (const conn of [...this.conns])
      if (
        (conn.a.identity === found.caller && conn.b.identity === host) ||
        (conn.a.identity === host && conn.b.identity === found.caller)
      )
        this.down(conn, 'cancelled')
    return { grant, role, revision, changed: true }
  }

  /** `host` removes the grant `grant`: its connections with that caller go down; answers the caller, if any. */
  revoke(host: string, grant: number | string): string | undefined {
    const held = this.grants.get(host)
    for (const [caller, given] of held ?? [])
      if (String(given) === String(grant)) {
        held!.delete(caller)
        this.receipts.delete(String(given))
        this.roles.delete(String(given))
        for (const conn of [...this.conns])
          if (
            (conn.a.identity === caller && conn.b.identity === host) ||
            (conn.a.identity === host && conn.b.identity === caller)
          )
            this.down(conn, 'grant_revoked')
        return caller
      }
    return undefined
  }

  /** `from` forgets `to` as a peer; answers whether it knew it. */
  /**
   * `grant.revoke_local`: `host` stops letting the caller of `grant` in, and the connections that caller dialled
   * close; its own peer record of that caller stays, and so do the connections it dialled.
   */
  revokeOnly(host: string, grant: unknown): string | undefined {
    const held = this.grants.get(host)
    for (const [caller, given] of held ?? [])
      if (String(given) === String(grant)) {
        held!.delete(caller)
        this.receipts.delete(String(given))
        this.roles.delete(String(given))
        for (const conn of [...this.conns])
          if (conn.a.identity === caller && conn.b.identity === host) this.down(conn, 'grant_revoked')
        return caller
      }
    return undefined
  }

  forget(from: string, to: string): boolean {
    this.peerRoles.delete(`${from} ${to}`)
    return !!this.peers.get(from)?.delete(to)
  }

  /** `from` knows `to` as a peer (it may dial it), with `role` recorded when given; answers whether it did already. */
  peer(from: string, to: string, role?: string): boolean {
    let known = this.peers.get(from)
    if (!known) this.peers.set(from, (known = new Set()))
    const already = known.has(to)
    known.add(to)
    if (role !== undefined) this.peerRoles.set(`${from} ${to}`, role)
    return already
  }

  /** The role `from`'s peer record says it holds at `to` (`peers.list`). */
  peerRole(from: string, to: string): string {
    return this.peerRoles.get(`${from} ${to}`) ?? 'owner'
  }

  /** @internal */
  helperOf(identity: string): FakeHelper | undefined {
    return this.helpers.get(identity)
  }

  /** A new helper for `identity` (replacing a killed one). */
  helper(identity: string, profile?: string): FakeHelper {
    const helper = new FakeHelper(this, identity, profile)
    this.helpers.set(identity, helper)
    return helper
  }

  /**
   * @internal The route a 1.1 dial from `from` to `identity` comes up on: the first of `candidates` (by default
   * what `from` keeps for it) the other helper answers on. Undefined in 1.0; `unreachable` when none answers.
   */
  route(from: string, identity: string, candidates?: string[]): Conn['route'] {
    const relay = this.relayed.get(identity)
    if (relay) return { kind: 'relay', class: 'relay', destination: relay }
    if (this.minor < 1) return undefined
    const listens = this.listensOn(identity)
    const route = (candidates ?? this.candidates(from, identity)).find((candidate) =>
      listens.includes(candidate)
    )
    if (!route) {
      // The SSH tier, last (§1.4): an owner SSH route whose server pipes to that identity's helper.
      const viaSsh = this.knownFor(from, identity).ssh.some((entry) => {
        const ssh = this.sshRoutes.get(String(entry.route_id))
        return !!ssh && !!this.sshServers.get(ssh.hostname)?.owns(identity)
      })
      if (viaSsh && !candidates) return { kind: 'ssh', class: 'ssh' }
      throw Object.assign(new Error('no route answered'), { code: 'unreachable' })
    }
    // `conn.up.route.kind` names the pipe: `wss` and `ws` are both `ws`.
    const kind = parseRoute(route)?.kind ?? 'tcp'
    return { kind: kind === 'wss' ? 'ws' : kind, class: this.classOf(route) }
  }

  /** @internal */
  dial(from: FakeHelper, identity: string, candidates?: string[]): number {
    if (!this.peers.get(from.identity)?.has(identity))
      throw Object.assign(new Error('not paired with that identity'), { code: 'no_peer' })
    const to = this.helpers.get(identity)
    if (!to || !to.alive || this.outboundOnly.has(identity))
      throw Object.assign(new Error('unreachable'), { code: 'unreachable' })
    const grant = this.grants.get(identity)?.get(from.identity)
    if (grant === undefined) throw Object.assign(new Error('not allowed'), { code: 'forbidden' })
    const route = this.route(from.identity, identity, candidates)
    const conn: Conn = {
      id: { [from.identity]: this.next++, [identity]: this.next++ },
      a: from,
      b: to,
      ends: new Set(),
      up: true,
      ...(route ? { route } : {})
    }
    this.conns.add(conn)
    from.connUp(conn, conn.id[from.identity]!, identity, 'out')
    to.connUp(conn, conn.id[identity]!, from.identity, 'in', grant)
    return conn.id[from.identity]!
  }

  /** @internal Every connection of a helper that went away goes down at its peers. */
  helperGone(helper: FakeHelper): void {
    for (const conn of [...this.conns])
      if (conn.a === helper || conn.b === helper) this.down(conn, 'peer_gone')
  }

  /** Cuts one connection between two identities, as a lost path does. */
  cut(a: string, b: string): void {
    for (const conn of [...this.conns])
      if (
        (conn.a.identity === a && conn.b.identity === b) ||
        (conn.a.identity === b && conn.b.identity === a)
      )
        this.down(conn, 'path_lost')
  }

  /** Cuts the connections `from` dialled to `to` only, as a path lost one way does; the other direction stays. */
  cutFrom(from: string, to: string): void {
    for (const conn of [...this.conns])
      if (conn.a.identity === from && conn.b.identity === to) this.down(conn, 'path_lost')
  }

  private down(conn: Conn, reason: string): void {
    if (!conn.up) return
    conn.up = false
    this.conns.delete(conn)
    for (const end of conn.ends) end.helper.endGone(end, reason)
    for (const side of [conn.a, conn.b]) side.connDown(conn, conn.id[side.identity]!, reason)
  }

  /** @internal Opens a stream from `from` on `conn`; the other helper reports it to its app. */
  open(from: FakeHelper, conn: Conn, label: string, cls: string): End {
    const to = conn.a === from ? conn.b : conn.a
    const mine = from.newEnd(conn, label)
    const theirs = to.newEnd(conn, label)
    mine.other = theirs
    theirs.other = mine
    conn.ends.add(mine)
    conn.ends.add(theirs)
    if (conn.a === to) {
      // The dialled side calls its dialler: served under the dialler's own live grant for it, else refused.
      const grant = this.grants.get(to.identity)?.get(from.identity)
      if (grant === undefined) {
        setImmediate(() => this.reset(theirs, 'refused'))
        return mine
      }
      to.incoming(theirs, conn.id[to.identity]!, label, cls, { grant, role: this.roleOf(grant).role })
      return mine
    }
    // The dialler calls: served under the grant the dialled side holds for it, named with its role (unless the
    // network plays helpers that do not name it).
    const grant = this.grants.get(to.identity)?.get(from.identity)
    to.incoming(
      theirs,
      conn.id[to.identity]!,
      label,
      cls,
      grant === undefined || !this.streamRoles ? undefined : { grant, role: this.roleOf(grant).role }
    )
    return mine
  }

  /** @internal What the app at `end` wrote, whole messages at a time, toward the other end. */
  carry(end: End, bytes: Uint8Array, fin: boolean): void {
    const other = end.other
    if (!other || other.closed) return
    let messages: EngineMessage[] = []
    try {
      messages = end.reader.push(bytes)
    } catch {
      other.helper.toApp(other, bytes, false)
    }
    for (const message of messages) {
      if (
        end.label === 'mousse.rpc' &&
        end.method === undefined &&
        typeof message.header.method === 'string'
      )
        other.method = end.method = message.header.method
      const row: Crossed = {
        from: end.helper.identity,
        label: end.label,
        ...(end.method ? { method: end.method } : {}),
        header: message.header,
        parts: message.parts
      }
      this.crossed.push(row)
      if (this.tap?.(row) === 'drop') continue
      other.helper.toApp(other, encodeMessage(message.header, message.parts), false)
    }
    if (fin) other.helper.toApp(other, new Uint8Array(0), true)
  }

  /** @internal */
  reset(end: End, code: string): void {
    const other = end.other
    if (other && !other.closed) other.helper.endGone(other, code)
  }
}

/**
 * A ticket as the helper writes one: base64url of the CBOR map {1: 1, 2: 1, 3: host identity, 4: invitation id,
 * 5: secret, 6: expires_at, 7: [routes]}. An identity that is not hex goes in as its UTF-8 bytes.
 */
function ticketOf(host: string, invitation: string, routes: readonly string[] = []): string {
  const head = (major: number, value: number): Buffer => {
    if (value < 24) return Buffer.from([(major << 5) | value])
    if (value < 256) return Buffer.from([(major << 5) | 24, value])
    if (value < 65536) return Buffer.from([(major << 5) | 25, value >> 8, value & 255])
    const out = Buffer.alloc(5)
    out[0] = (major << 5) | 26
    out.writeUInt32BE(value, 1)
    return out
  }
  const bytes = (value: Buffer): Buffer => Buffer.concat([head(2, value.byteLength), value])
  const text = (value: string): Buffer =>
    Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)])
  const identity = /^(?:[0-9a-f]{2})+$/i.test(host) ? Buffer.from(host, 'hex') : Buffer.from(host)
  return Buffer.concat([
    head(5, 7),
    head(0, 1),
    head(0, 1),
    head(0, 2),
    head(0, 1),
    head(0, 3),
    bytes(identity),
    head(0, 4),
    bytes(Buffer.from(invitation, 'hex')),
    head(0, 5),
    bytes(randomBytes(32)),
    head(0, 6),
    head(0, Math.floor(Date.now() / 1000) + 600),
    head(0, 7),
    head(4, routes.length),
    ...routes.map(text)
  ]).toString('base64url')
}

/** The app's end of an in-memory pipe and the helper's. */
function pipePair(): { app: AppPipe; helper: AppPipe } {
  const make = () => ({
    data: [] as Array<(bytes: Uint8Array) => void>,
    close: [] as Array<() => void>,
    open: true
  })
  const toApp = make(),
    toHelper = make()
  const end = (inbox: ReturnType<typeof make>, outbox: ReturnType<typeof make>): AppPipe => ({
    write: (bytes) => {
      if (!outbox.open) return true
      const copy = Uint8Array.from(bytes)
      setImmediate(() => {
        if (outbox.open) for (const listener of outbox.data) listener(copy)
      })
      return true
    },
    onDrain: () => undefined,
    onData: (listener) => void inbox.data.push(listener),
    onClose: (listener) => void inbox.close.push(listener),
    close: () => {
      for (const box of [inbox, outbox]) {
        if (!box.open) continue
        box.open = false
        for (const listener of box.close.splice(0)) setImmediate(listener)
      }
    }
  })
  return { app: end(toApp, toHelper), helper: end(toHelper, toApp) }
}

/**
 * A helper's relays (Phase 3 §B.9, §B.11), when it has them: its own relays as `relay.list` answers, each peer's
 * `peers.list[].relay`, each caller's `grants.list[].relay`, and the refusal `relay.enroll` answers next.
 */
export interface FakeRelays {
  available: boolean
  relays: Array<Record<string, any>>
  peers: Map<string, Record<string, any>>
  grants: Map<string, string>
  enrollError?: string
  /** `relay.list` fails this many more times (a helper still starting) before it answers. */
  listFailures?: number
}

/** A helper's Plus (Phase 4): the answer to each `plus.*` and `removal.*` op, and how many more times each fails first. */
export interface FakePlus {
  answers: Record<string, Record<string, unknown>>
  /** An op fails (`busy`, a helper still starting) this many more times before it answers. */
  failures?: Record<string, number>
}

export class FakeHelper {
  alive = true
  /** Every request its app sent, in order. */
  readonly requests: Array<Record<string, any>> = []
  /** Ops whose request this helper takes up only after this many ms (a slow answer). */
  readonly slow = new Map<string, number>()
  /** Its relays; a helper without them answers `unknown_op` to every relay request, as a 1b helper does. */
  get relays(): FakeRelays | undefined {
    return this.network.relays.get(this.identity)
  }
  /** The app's end of the channel. */
  readonly pipe: AppPipe
  private readonly own: AppPipe
  private readonly reader = new FrameReader()
  private readonly ends = new Map<number, End>()
  private readonly conns = new Map<number, Conn>()
  private nextHandle = 1
  private helloed = false
  /** `join.probe`s not answered yet, by request id: each answers `cancelled` when cancelled. */
  private readonly probes = new Map<string, () => void>()
  /** It speaks 1.2 and lists `feature` in its hello. */
  private lists(feature: string): boolean {
    return (this.network.minor >= 2 || feature === 'grant-roles') && this.network.features.includes(feature)
  }
  /** A list row's `version_refusal` for `identity`, with `version-refusals`. */
  private versionRefusal(identity: string): Record<string, unknown> {
    if (!this.lists('version-refusals')) return {}
    return { version_refusal: this.network.versionRefusals.get(this.identity)?.get(identity) ?? null }
  }
  /** What the app said in `hello`. */
  hello?: { name?: string; profile?: string }
  /** Why networking is paused, while it is. */
  private paused?: string
  /** Approvals waiting for this host's app: the joiner and how to answer its join. */
  private readonly approvals = new Map<
    string,
    { invitation: string; joiner: FakeHelper; answer(fields: Record<string, unknown>): void }
  >()
  private nextRequest = 1
  /** Frames the app sent for a handle that was not open. */
  dropped = 0
  /** It neither answers `shutdown` nor exits for it (a helper that hangs). */
  ignoreShutdown = false
  /** The addresses the app set for each peer (`peer.addresses.set`), by identity. */
  readonly addresses = new Map<string, string[]>()
  /** The next Send link `PAIRED` is lost: the confirmation is sent and this helper exits before answering. */
  losePaired = false
  /** @internal Flow records under `joiner-records-in-memory`. */
  readonly memoryFlows = new Map<string, FakeFlow>()
  /** Send link joins waiting for the code, by invitation. */
  private readonly codeWaits = new Map<
    string,
    {
      reply: (fields: Record<string, unknown>) => void
      invite: FakeLinkInvite
      hash: string
      /** The app passed `pinned` (a Send link join never should). */
      pinned: boolean
      changed: boolean
      /** The routes a 1.1 join dials. */
      candidates?: string[]
    }
  >()
  /** The routes of each `peer.add` the app sent, in order. */
  readonly peerAdds: string[][] = []

  /** Its routes config now (`routes.config`), LAN on by default as in 1a. */
  private reachNow(): FakeReach {
    return (
      this.network.reach.get(this.identity) ?? {
        lan: true,
        tailnet: false,
        public: [],
        tunnels: [],
        ...(this.network.ports.has(this.identity)
          ? { port: this.network.ports.get(this.identity) }
          : {})
      }
    )
  }

  constructor(
    private readonly network: FakeNetwork,
    readonly identity: string,
    /** The profile its endpoint belongs to: `hello` for another is refused. */
    readonly profile?: string
  ) {
    const pair = pipePair()
    this.pipe = pair.app
    this.own = pair.helper
    this.own.onData((bytes) => this.fromApp(bytes))
    this.own.onClose(() => this.kill())
  }

  /** The helper exits: its app sees the pipe close, its peers see its connections go down. */
  kill(): void {
    if (!this.alive) return
    this.alive = false
    this.own.close()
    this.network.helperGone(this)
  }

  /** Networking pauses (a removal not saved) until `resume`. */
  pause(reason: string): void {
    this.paused = reason
    this.event({ ev: 'net.paused', reason })
  }
  resume(): void {
    this.paused = undefined
    this.event({ ev: 'net.resumed' })
  }

  /** @internal A joiner asks this host's app to approve it; `answer` ends the join. */
  askApproval(
    invitation: string,
    joiner: FakeHelper,
    name: string,
    answer: (fields: Record<string, unknown>) => void
  ): void {
    const request = `request-${this.nextRequest++}`
    this.approvals.set(request, { invitation, joiner, answer })
    this.event({
      ev: 'approval',
      request,
      invitation,
      identity: joiner.identity,
      device: joiner.identity.slice(0, 8),
      name
    })
  }

  private send(frame: Uint8Array): void {
    if (this.alive) this.own.write(frame)
  }
  private event(event: Record<string, unknown>): void {
    this.send(jsonFrame(event))
  }
  /** Sends its app an event, as the helper does on its own (`relay.state`, `peer.manifest`, …). */
  emit(event: Record<string, unknown>): void {
    this.event(event)
  }

  /** @internal */
  connUp(
    conn: Conn,
    id: number,
    identity: string,
    dir: 'in' | 'out',
    grant?: number | string
  ): void {
    this.conns.set(id, conn)
    // An inbound connection carries its grant and that grant's role; an outbound one the role the peer gave here.
    const fields =
      dir === 'in' ? (grant !== undefined ? { grant, role: 'owner' } : {}) : { role: 'owner' }
    this.event({
      ev: 'conn.up',
      conn: id,
      identity,
      dir,
      ...fields,
      deadline: 0,
      both: this.network.bothWays,
      ...(conn.route ? { route: conn.route } : {})
    })
  }
  /** @internal */
  connDown(conn: Conn, id: number, reason: string): void {
    if (this.conns.get(id) !== conn) return
    this.conns.delete(id)
    this.event({
      ev: 'conn.down',
      conn: id,
      identity: (conn.a === this ? conn.b : conn.a).identity,
      reason
    })
  }
  /** @internal */
  newEnd(conn: Conn, label: string): End {
    const end: End = {
      helper: this,
      handle: this.nextHandle++,
      appCredit: 0,
      queue: [],
      label,
      reader: new MessageReader(),
      closed: false
    }
    this.ends.set(end.handle, end)
    return end
  }
  /** @internal The other side opened a stream: the app hears of it and may write once it has credit. */
  incoming(
    end: End,
    conn: number,
    label: string,
    cls: string,
    served?: { grant: number | string; role: string }
  ): void {
    this.event({ ev: 'stream.incoming', conn, handle: end.handle, label, class: cls, ...served })
    this.send(creditFrame(end.handle, STREAM_CREDIT))
  }
  /** @internal Bytes for this side's app, under the credit it granted; FIN after them. */
  toApp(end: End, bytes: Uint8Array, fin: boolean): void {
    if (end.closed) return
    for (let at = 0; at < bytes.byteLength; at += 64 * 1024)
      end.queue.push({
        bytes: bytes.subarray(at, Math.min(bytes.byteLength, at + 64 * 1024)),
        fin: false
      })
    if (fin) end.queue.push({ bytes: new Uint8Array(0), fin: true })
    this.flush(end)
  }
  /** @internal The stream ended at the other side or with its connection: the app hears a reset. */
  endGone(end: End, code: string): void {
    if (end.closed) return
    end.closed = true
    this.ends.delete(end.handle)
    this.event({ ev: 'stream.reset', handle: end.handle, code })
  }

  private flush(end: End): void {
    while (end.queue.length && !end.closed) {
      const next = end.queue[0]!
      if (next.bytes.byteLength > end.appCredit) return
      end.queue.shift()
      end.appCredit -= next.bytes.byteLength
      this.send(dataFrame(end.handle, next.bytes, next.fin))
    }
  }

  private fromApp(bytes: Uint8Array): void {
    if (!this.alive) return
    let frames
    try {
      frames = this.reader.push(bytes)
    } catch {
      this.kill()
      return
    }
    for (const frame of frames) {
      const body = Buffer.from(frame.body.buffer, frame.body.byteOffset, frame.body.byteLength)
      if (frame.type === FRAME_CREDIT) {
        const end = this.ends.get(body.readUInt32BE(0))
        if (!end) {
          this.dropped += 1
          continue
        }
        end.appCredit += body.readUInt32BE(4)
        this.flush(end)
        continue
      }
      if (frame.type === FRAME_DATA) {
        const end = this.ends.get(body.readUInt32BE(0))
        if (!end) {
          this.dropped += 1
          continue
        }
        const payload = frame.body.subarray(5)
        const fin = (body.readUInt8(4) & DATA_FIN) !== 0
        this.network.carry(end, payload, fin)
        // What was carried is room again for the app.
        if (payload.byteLength && !fin) this.send(creditFrame(end.handle, payload.byteLength))
        continue
      }
      const message = JSON.parse(body.toString('utf8')) as Record<string, any>
      const wait = this.slow.get(String(message.op))
      if (wait) setTimeout(() => this.request(message), wait)
      else this.request(message)
    }
  }

  /** `invite.create {kind: "link"}`: a kind-2 ticket, its code and three tries. */
  private linkInvite(reply: (fields: Record<string, unknown>) => void, role?: string): void {
    const fields: TicketFields = {
      version: 1,
      kind: 2,
      host: this.identity,
      invitation: randomBytes(16).toString('hex'),
      secret: randomBytes(32).toString('hex'),
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      routes: this.network.routes.get(this.identity) ?? []
    }
    const ticket = encodeTicket(fields)
    const invite: FakeLinkInvite = {
      ...fields,
      ticket,
      hash: ticketHash(ticket),
      code: newCode(),
      attemptsLeft: 3,
      ...(role ? { role } : {})
    }
    this.network.links.set(invite.invitation, invite)
    reply({
      invitation: invite.invitation,
      uri: ticket,
      code: invite.code,
      attempts_left: invite.attemptsLeft,
      routes: fields.routes,
      expires_at: fields.expiresAt
    })
  }

  /**
   * `join` of a ticket that came by link (§5.3, §5.5); answers false once it has answered or waits for the code.
   */
  private joinLink(
    message: Record<string, any>,
    reply: (fields: Record<string, unknown>) => void
  ): boolean {
    const ticket = String(message.ticket)
    let fields: TicketFields
    try {
      fields = decodeTicket(ticket)
    } catch (error) {
      reply({ error: 'bad_ticket', reason: (error as Error).message })
      return false
    }
    // A kind-1 ticket needs an in-app scan; the defect lets it go on as a link.
    if (fields.kind !== 2 && !this.network.defects.has('link-accepts-kind1')) {
      reply({ error: 'pairing_failed', reason: 'kind 1 needs an in-app scan' })
      return false
    }
    const hash = ticketHash(ticket)
    const flows = this.network.flowsOf(this)
    const flow = flows.get(hash)
    if (flow?.exhausted) {
      reply({ error: 'attempts_exhausted', reason: 'no tries left' })
      return false
    }
    if (fields.expiresAt * 1000 <= Date.now() && !flow?.pending) {
      reply({ error: 'expired', reason: 'the ticket expired' })
      return false
    }
    this.network.approvedSent.push({
      joiner: this.identity,
      approved: Array.isArray(message.approved) ? message.approved.map(String) : []
    })
    const host = this.network.helperOf(fields.host)
    if (!host?.alive) {
      reply({ error: 'no_route', reason: 'no address answers as that key' })
      return false
    }
    // As a 1.1 helper: the ticket's private hints, and those in both the ticket and `approved` (§1.3).
    let candidates: string[] | undefined
    if (this.network.minor >= 1) {
      const approved = new Set((Array.isArray(message.approved) ? message.approved : []).map(String))
      candidates = fields.routes.filter(
        (route) => this.network.automatic(route) || approved.has(route)
      )
      try {
        this.network.route(this.identity, host.identity, candidates)
      } catch {
        reply({ error: 'unreachable', reason: 'no route answered' })
        return false
      }
      const known = this.network.knownFor(this.identity, host.identity)
      for (const route of fields.routes) if (!known.hints.includes(route)) known.hints.push(route)
      for (const route of candidates) known.approved.add(route)
    }
    // The confirmation was sent before a crash: the outcome is learnt now, even after expiry.
    if (flow?.pending) {
      this.linkDone(host, flow, reply, candidates)
      return false
    }
    // Existing access: the host lets this computer in already, whatever the proof (AUTHORIZED live).
    if (this.network.holds(host.identity, this.identity)) {
      reply({
        identity: host.identity,
        name: host.hello?.name ?? host.identity,
        role: 'owner',
        already: true
      })
      return false
    }
    const record = flow ?? { attemptsLeft: 3 }
    flows.set(hash, record)
    const invite = this.network.links.get(fields.invitation)
    if (!invite || invite.host !== fields.host || invite.secret !== fields.secret || invite.ended) {
      reply({ error: 'invitation_invalid', reason: 'no such invitation' })
      return false
    }
    if (this.network.defects.has('host-attempts-reset-on-reconnect')) invite.attemptsLeft = 3
    if (this.network.defects.has('skip-code-confirm')) {
      this.linkPaired(host, invite, record, reply, candidates)
      return false
    }
    this.codeWaits.set(invite.invitation, {
      reply,
      invite,
      hash,
      pinned: message.pinned === true,
      ...(candidates ? { candidates } : {}),
      // A route hint or expires_at changed: the hash differs, so key confirmation fails whatever code is typed.
      changed: invite.hash !== hash
    })
    this.event({
      ev: 'join.code_needed',
      invitation: invite.invitation,
      attempts_left: record.attemptsLeft
    })
    return false
  }

  /** `join.code`: the right code pairs; a wrong one spends a try on each side, and the third ends both. */
  private joinCode(
    invitation: string,
    code: string,
    reply: (fields: Record<string, unknown>) => void
  ): void {
    if (!/^[0-9]{6}$/.test(code)) return reply({ error: 'bad_code', reason: 'six digits' })
    const waiting = this.codeWaits.get(invitation)
    if (!waiting) return reply({ error: 'no_join', reason: 'no join waits for a code' })
    reply()
    const host = this.network.helperOf(waiting.invite.host)
    const record = this.network.flowsOf(this).get(waiting.hash)!
    this.codeWaits.delete(invitation)
    if (!host?.alive) return waiting.reply({ error: 'no_route', reason: 'the host went away' })
    if (code === waiting.invite.code && !waiting.changed) {
      // As the engine's host does, a try is taken when an attempt starts, and the next code shows, before the result.
      waiting.invite.attemptsLeft -= 1
      if (waiting.invite.attemptsLeft > 0) {
        waiting.invite.code = newCode()
        host.event({
          ev: 'invite.code',
          invitation: waiting.invite.invitation,
          code: waiting.invite.code,
          attempts_left: waiting.invite.attemptsLeft
        })
      }
      return this.linkPaired(host, waiting.invite, record, waiting.reply, waiting.candidates)
    }
    // A pinned join trusted as journaled (the defect): a failed key confirmation ends as "already paired".
    if (waiting.pinned && this.network.defects.has('journal-pins-link'))
      return waiting.reply({ identity: host.identity, name: host.identity, role: 'owner', already: true })
    if (this.spend(host, waiting.invite, record))
      return waiting.reply({ error: 'attempts_exhausted', reason: 'no tries left' })
    this.codeWaits.set(invitation, waiting)
    this.event({ ev: 'join.attempt_failed', invitation, attempts_left: record.attemptsLeft })
  }

  /** One try spent on each side; answers whether that was the last (the invitation ends). */
  private spend(host: FakeHelper, invite: FakeLinkInvite, record: FakeFlow): boolean {
    invite.attemptsLeft -= 1
    record.attemptsLeft -= 1
    if (invite.attemptsLeft > 0 && record.attemptsLeft > 0) {
      invite.code = newCode()
      host.event({
        ev: 'invite.code',
        invitation: invite.invitation,
        code: invite.code,
        attempts_left: invite.attemptsLeft
      })
      return false
    }
    record.exhausted = true
    if (!this.network.defects.has('invitation-survives-exhaustion')) {
      invite.ended = 'attempts_exhausted'
      this.network.links.delete(invite.invitation)
    }
    host.event({ ev: 'invite.ended', invitation: invite.invitation, reason: 'attempts_exhausted' })
    return true
  }

  /** The code matched: the host enrolls this computer (no approval for links), and the join answers `PAIRED`. */
  private linkPaired(
    host: FakeHelper,
    invite: FakeLinkInvite,
    record: FakeFlow,
    reply: (fields: Record<string, unknown>) => void,
    candidates?: string[]
  ): void {
    const { grant, already } = this.network.grant(host.identity, this.identity, undefined, invite.role)
    // The enrollment receipt names the invitation, as the helper's `grants.list` says.
    if (!already) this.network.receipts.set(String(grant), invite.invitation)
    invite.ended = 'used'
    this.network.links.delete(invite.invitation)
    host.event({
      ev: 'enrolled',
      invitation: invite.invitation,
      grant,
      role: this.network.roleOf(grant).role,
      identity: this.identity,
      name: this.hello?.name ?? this.identity
    })
    host.event({ ev: 'invite.ended', invitation: invite.invitation, reason: 'used' })
    record.pending = true
    if (this.losePaired) {
      this.losePaired = false
      setImmediate(() => this.kill())
      return
    }
    this.linkDone(host, record, reply, candidates)
  }

  private linkDone(
    host: FakeHelper,
    record: FakeFlow,
    reply: (fields: Record<string, unknown>) => void,
    candidates?: string[]
  ): void {
    const name = host.hello?.name ?? host.identity
    record.pending = false
    record.done = { identity: host.identity, name, role: 'owner' }
    this.network.peer(this.identity, host.identity)
    const conn = this.network.dial(this, host.identity, candidates)
    reply({ identity: host.identity, name, role: 'owner', already: false, conn })
  }

  private request(message: Record<string, any>): void {
    const re = message.id
    const reply = (fields: Record<string, unknown> = {}) => this.send(jsonFrame({ re, ...fields }))
    this.requests.push(message)
    try {
      const op = String(message.op)
      if (this.helloed && (op.startsWith('relay.') || op.startsWith('peer.relay.'))) {
        if (!this.relays) return reply({ error: 'unknown_op', reason: op })
        const answer = relayAnswer(message, this.relays)
        // As the network does once a computer has a relay: every dial to it goes through that relay.
        const added = answer.relay as { destination?: string } | undefined
        if (op === 'relay.enroll' && added?.destination) this.network.relayed.set(this.identity, added.destination)
        return reply(answer)
      }
      if (this.helloed && (op.startsWith('plus.') || op.startsWith('removal.'))) {
        const plus = this.network.plus.get(this.identity)
        if (!plus) return reply({ error: 'unknown_op', reason: op })
        if ((plus.failures?.[op] ?? 0) > 0) {
          plus.failures![op]!--
          return reply({ error: 'busy', reason: 'starting' })
        }
        return reply(plus.answers[op] ?? { error: 'unknown_op', reason: op })
      }
      if (!this.helloed && message.op !== 'hello')
        return reply({ error: 'no_hello', reason: 'hello first' })
      const failing = this.network.failing.get(this.identity)
      if ((failing?.[op] ?? 0) > 0) {
        failing![op]!--
        return reply({ error: 'busy', reason: 'starting' })
      }
      switch (message.op) {
        case 'hello': {
          const proto = message.proto
          if (!Array.isArray(proto) || proto[0] !== 1)
            return reply({ error: 'unsupported_proto', reason: '1.0 only' })
          if (
            typeof message.profile === 'string' &&
            this.profile &&
            message.profile !== this.profile
          )
            return reply({
              error: 'wrong_profile',
              reason: 'this endpoint belongs to another profile'
            })
          this.helloed = true
          this.hello = { name: message.name, profile: message.profile }
          const minor = Math.min(this.network.minor, Number(proto[1]) || 0)
          const reach = this.reachNow()
          const port = this.network.ports.get(this.identity)
          return reply({
            proto: [1, minor],
            identity: this.identity,
            routes: this.network.routes.get(this.identity) ?? [],
            paused: this.paused ?? null,
            ...(port !== undefined ? { port } : {}),
            ...(minor >= 1
              ? {
                  routes_config: reach,
                  ...(reach.tunnels.length ? { ws_port: (port ?? 47000) + 1 } : {})
                }
              : {}),
            ...(minor >= 2
              ? { features: [...this.network.features] }
              : this.lists('grant-roles')
                ? { features: ['grant-roles'] }
                : {})
          })
        }
        case 'routes.available': {
          if (!this.lists('route-readiness')) return reply({ error: 'unknown_op', reason: 'routes.available' })
          const routes = this.network.routes.get(this.identity) ?? []
          return reply({
            ways: this.network.ways.get(this.identity) ?? [
              { way: 'lan', state: 'ready', routes },
              { way: 'tailnet', state: 'off', reason: 'disabled', routes: [] },
              { way: 'public', state: 'off', reason: 'not_configured', routes: [] },
              { way: 'tunnel', state: 'off', reason: 'not_configured', routes: [] },
              { way: 'relay', state: 'unavailable', reason: 'relay_not_registered', routes: [] }
            ]
          })
        }
        case 'join.check': {
          if (!this.lists('route-readiness')) return reply({ error: 'unknown_op', reason: 'join.check' })
          const open = this.network.invitations.get(String(message.ticket))
          if (!open) return reply({ error: 'bad_ticket', reason: 'no such invitation' })
          return reply({
            kind: 1,
            invitation: open.invitation,
            hints: open.routes.map((route) => ({
              route,
              way: 'lan',
              eligibility: this.network.automatic(route) ? 'automatic' : 'approval_required',
              local: 'unknown'
            }))
          })
        }
        case 'join.probe': {
          if (!this.lists('join-probe')) return reply({ error: 'unknown_op', reason: 'join.probe' })
          const open = this.network.invitations.get(String(message.ticket))
          if (!open) return reply({ error: 'bad_ticket', reason: 'no such invitation' })
          const answer = (): void => {
            if (!this.probes.delete(String(re))) return
            const automatic = open.routes.filter((route) => this.network.automatic(route))
            try {
              if (!automatic.length) throw new Error('nothing to dial unapproved')
              this.network.route(this.identity, open.host, automatic)
              const listens = this.network.listensOn(open.host)
              const route = automatic.find((candidate) => listens.includes(candidate)) ?? automatic[0]
              reply({ reachable: true, route, ms: 1 })
            } catch {
              reply(
                automatic.length
                  ? { reachable: false, reason: 'unreachable' }
                  : { reachable: null, reason: 'approval_required' }
              )
            }
          }
          this.probes.set(String(re), () => reply({ reachable: null, reason: 'cancelled' }))
          if (this.network.probeDelayMs) setTimeout(answer, this.network.probeDelayMs)
          else answer()
          return
        }
        case 'join.probe.cancel': {
          const running = this.probes.get(String(message.probe))
          this.probes.delete(String(message.probe))
          running?.()
          return reply({ cancelled: !!running })
        }
        case 'grant.revoke_local': {
          if (!this.lists('grant-revoke-local'))
            return reply({ error: 'unknown_op', reason: 'grant.revoke_local' })
          // As the helper: only the grant goes; its peer record, approvals and completion stay.
          const caller = this.network.revokeOnly(this.identity, message.grant)
          return caller === undefined
            ? reply({ error: 'not_found', reason: 'no such grant' })
            : reply({ removed: true })
        }
        case 'config.set':
          // As the helper: the name joins and approvals send from now on.
          if (typeof message.name === 'string') this.hello = { ...this.hello, name: message.name }
          return reply()
        case 'shutdown':
          if (this.ignoreShutdown) return
          reply()
          return void setImmediate(() => this.kill())
        case 'dial': {
          if (this.paused) return reply({ error: 'paused', reason: this.paused })
          const target = String(message.identity)
          if (this.lists('version-refusals')) {
            const refusals = this.network.versionRefusals.get(this.identity) ?? new Map()
            this.network.versionRefusals.set(this.identity, refusals)
            const minorThere = this.network.outdated.get(target)
            if (minorThere !== undefined) {
              refusals.set(target, { peer_minor: minorThere, local_minor: 4, since: Math.floor(Date.now() / 1000) })
              return reply({ error: 'unsupported_version', peer_minor: minorThere, reason: 'unsupported version' })
            }
            refusals.delete(target)
          }
          return reply({ conn: this.network.dial(this, target), already: false })
        }
        case 'routes.config': {
          if (this.network.minor < 1) return reply({ error: 'unknown_op', reason: 'routes.config' })
          const before = this.reachNow()
          const after: FakeReach = {
            ...before,
            ...(typeof message.lan === 'boolean' ? { lan: message.lan } : {}),
            ...(typeof message.tailnet === 'boolean' ? { tailnet: message.tailnet } : {}),
            ...(Array.isArray(message.public) ? { public: message.public.map(String) } : {}),
            ...(Array.isArray(message.tunnels) ? { tunnels: message.tunnels.map(String) } : {}),
            ...(typeof message.port === 'number' ? { port: message.port } : {}),
            ...('forward_to' in message ? { forward_to: message.forward_to ?? null } : {})
          }
          for (const route of [...after.public, ...after.tunnels])
            if (!parseRoute(route)) return reply({ error: 'bad_route', reason: route })
          this.network.reach.set(this.identity, after)
          // What it advertises follows the forwards and tunnels as saved.
          const gone = new Set([...before.public, ...before.tunnels])
          const advertised = (this.network.routes.get(this.identity) ?? []).filter(
            (route) => !gone.has(route)
          )
          for (const route of [...after.public, ...after.tunnels])
            if (!advertised.includes(route)) advertised.push(route)
          this.network.routes.set(this.identity, advertised)
          if (after.port !== undefined) this.network.ports.set(this.identity, after.port)
          const restart =
            after.lan !== before.lan ||
            after.tailnet !== before.tailnet ||
            after.port !== before.port ||
            !after.public.length !== !before.public.length ||
            (after.forward_to ?? null) !== (before.forward_to ?? null) ||
            !after.tunnels.length !== !before.tunnels.length
          return reply({ routes: advertised, restart_needed: restart, config: after })
        }
        case 'ssh.resolve': {
          const target = String(message.target ?? '')
          const at = target.lastIndexOf('@')
          const hostname = target.slice(at + 1)
          if (!hostname) return reply({ error: 'bad_request', reason: 'no host' })
          const routeId = randomBytes(8).toString('hex')
          this.network.sshRoutes.set(routeId, {
            hostname,
            user: at > 0 ? target.slice(0, at) : 'me',
            pinned: false
          })
          const route = this.network.sshRoutes.get(routeId)!
          return reply({ route_id: routeId, user: route.user, hostname, port: 22, pinned: false })
        }
        case 'ssh.probe': {
          const route = this.network.sshRoutes.get(String(message.route_id))
          if (!route) return reply({ error: 'bad_request', reason: 'unknown route' })
          if (!this.network.sshServers.has(route.hostname))
            return reply({ error: 'unreachable', reason: 'no server' })
          return reply({
            key_type: 'ssh-ed25519',
            sha256: `SHA256:fake-${route.hostname}`,
            in_user_known_hosts: false
          })
        }
        case 'ssh.trust': {
          const route = this.network.sshRoutes.get(String(message.route_id))
          if (!route) return reply({ error: 'probe_again', reason: 'no kept key' })
          if (message.sha256 !== `SHA256:fake-${route.hostname}`)
            return reply({ error: 'host_key_changed', reason: 'another key' })
          route.pinned = true
          return reply({ sha256: message.sha256, pinned: true })
        }
        case 'ssh.run': {
          const route = this.network.sshRoutes.get(String(message.route_id))
          if (!route?.pinned) return reply({ error: 'host_key_unknown', reason: 'no pin' })
          const server = this.network.sshServers.get(route.hostname)
          if (!server) return reply({ error: 'unreachable', reason: 'no server' })
          const request = (message.request ?? {}) as Record<string, unknown>
          void server.serve(request).then(
            (answer) =>
              this.network.sshLose?.(request)
                ? reply({ error: 'remote_failed', reason: 'the session dropped' })
                : reply({ reply: answer }),
            () => reply({ error: 'remote_failed', reason: 'the remote failed' })
          )
          return
        }
        case 'ssh.forget':
          this.network.sshRoutes.delete(String(message.route_id))
          return reply()
        case 'routes.test': {
          if (this.network.minor < 1) return reply({ error: 'unknown_op', reason: 'routes.test' })
          return this.network.listensOn(this.identity).includes(String(message.route))
            ? reply({ ok: true, ms: 1 })
            : reply({ ok: false, reason: 'unreachable' })
        }
        case 'approvals.list': {
          const entries: Array<Record<string, unknown>> = []
          for (const [peer, known] of this.network.knownPeers(this.identity))
            for (const destination of known.approved)
              entries.push({
                identity: peer,
                destination,
                source: known.owner.includes(destination) ? 'owner' : 'ticket'
              })
          return reply({ approvals: entries })
        }
        case 'invite.create': {
          if (message.way !== undefined && !this.lists('invite-way'))
            return reply({ error: 'bad_request', reason: 'unknown field way' })
          if (message.role !== undefined && (!this.lists('grant-roles') || !ROLE.test(String(message.role))))
            return reply({ error: 'bad_request', reason: 'role' })
          const role = typeof message.role === 'string' ? message.role : undefined
          if (message.kind === 'link') return this.linkInvite(reply, role)
          const invitation = randomBytes(16).toString('hex')
          const routes = this.network.routes.get(this.identity) ?? []
          const uri = ticketOf(this.identity, invitation, routes)
          this.network.invitations.set(uri, { host: this.identity, invitation, routes, ...(role ? { role } : {}) })
          return reply({
            invitation,
            uri,
            routes: [],
            expires_at: Math.floor(Date.now() / 1000) + 600,
            ...(typeof message.way === 'string' ? { ways: [message.way] } : {})
          })
        }
        case 'invite.cancel':
          for (const [uri, open] of this.network.invitations)
            if (open.invitation === message.invitation) this.network.invitations.delete(uri)
          this.network.links.delete(String(message.invitation))
          return reply()
        case 'join.code':
          return this.joinCode(String(message.invitation), String(message.code), reply)
        case 'join.status': {
          const flow = this.network.flowsOf(this).get(String(message.ticket_hash))
          return reply({
            done: flow?.done ?? null,
            pending: !!flow?.pending && !flow.done,
            attempts_left: flow?.attemptsLeft ?? null
          })
        }
        case 'join.ack': {
          const flow = this.network.flowsOf(this).get(String(message.ticket_hash))
          if (flow) delete flow.done
          return reply()
        }
        case 'peers.list':
          return reply({
            peers: this.network
              .peersOf(this.identity)
              .map((identity) => ({
                identity,
                name: '',
                role: this.network.peerRole(this.identity, identity),
                // With relays (Phase 3): what this helper keeps about the peer's relays.
                ...(this.relays ? { relay: this.relays.peers.get(identity) ?? null } : {}),
                ...this.versionRefusal(identity)
              }))
          })
        case 'join': {
          if (this.paused) return reply({ error: 'paused', reason: this.paused })
          if (message.arrival === 'link' || linkKind(String(message.ticket)))
            if (!this.joinLink(message, reply)) return
          const open = this.network.invitations.get(String(message.ticket))
          const host = open && this.network.helperOf(open.host)
          if (!open || !host?.alive)
            return reply({ error: 'bad_ticket', reason: 'no such invitation' })
          // As a 1.1 helper: the ticket's private hints, and those in both the ticket and `approved` (§1.3).
          let candidates: string[] | undefined
          if (this.network.minor >= 1) {
            const approved = new Set(
              (Array.isArray(message.approved) ? message.approved : []).map(String)
            )
            candidates = open.routes.filter(
              (route) => this.network.automatic(route) || approved.has(route)
            )
            try {
              this.network.route(this.identity, open.host, candidates)
            } catch {
              // The owner's own routes for that host, its SSH route last (§1.4).
              try {
                this.network.route(this.identity, open.host)
                candidates = undefined
              } catch {
                return reply({ error: 'unreachable', reason: 'no route answered' })
              }
            }
            const known = this.network.knownFor(this.identity, open.host)
            for (const route of open.routes) if (!known.hints.includes(route)) known.hints.push(route)
            for (const route of candidates ?? []) known.approved.add(route)
          }
          this.event({
            ev: 'join.progress',
            invitation: open.invitation,
            step: 'connecting',
            route: 'fake'
          })
          host.askApproval(open.invitation, this, this.hello?.name ?? this.identity, (fields) => {
            if (fields.error) return reply(fields)
            // As the helper: the connection comes up before the join's reply.
            const conn = this.network.dial(this, open.host, candidates)
            reply({
              identity: open.host,
              name: host.hello?.name ?? open.host,
              role: 'owner',
              already: false,
              conn
            })
          })
          return
        }
        case 'approval.answer': {
          const waiting = this.approvals.get(String(message.request))
          if (!waiting)
            return reply({ error: 'no_request', reason: 'no such approval request is waiting' })
          if (
            message.role !== undefined &&
            (!this.lists('grant-roles') || message.yes !== true || !ROLE.test(String(message.role)))
          )
            return reply({ error: 'bad_request', reason: 'role' })
          this.approvals.delete(String(message.request))
          if (message.yes !== true) {
            reply()
            return waiting.answer({ error: 'declined', reason: 'the host declined' })
          }
          let role = typeof message.role === 'string' ? message.role : undefined
          for (const [uri, open] of this.network.invitations)
            if (open.invitation === waiting.invitation) {
              role ??= open.role
              this.network.invitations.delete(uri)
            }
          const { grant, already } = this.network.grant(this.identity, waiting.joiner.identity, undefined, role)
          if (!already) this.network.receipts.set(String(grant), waiting.invitation)
          reply()
          this.event({
            ev: 'enrolled',
            invitation: waiting.invitation,
            grant,
            role: this.network.roleOf(grant).role,
            identity: waiting.joiner.identity
          })
          this.event({ ev: 'invite.ended', invitation: waiting.invitation, reason: 'used' })
          return waiting.answer({})
        }
        case 'grant.add': {
          if (message.role !== undefined && (!this.lists('grant-roles') || !ROLE.test(String(message.role))))
            return reply({ error: 'bad_request', reason: 'role' })
          const role = typeof message.role === 'string' ? message.role : undefined
          const added = this.network.grant(this.identity, String(message.identity), undefined, role)
          if (!added.already && typeof message.receipt === 'string')
            this.network.receipts.set(String(added.grant), message.receipt)
          return reply({ ...added, ...(this.lists('grant-roles') ? { role: this.network.roleOf(added.grant).role } : {}) })
        }
        case 'grant.set_role': {
          if (!this.lists('grant-roles')) return reply({ error: 'unknown_op', reason: 'grant.set_role' })
          const fields = Object.keys(message).filter((key) => key !== 'op' && key !== 'id')
          if (
            fields.some((key) => !['grant', 'expected_revision', 'role'].includes(key)) ||
            !Number.isSafeInteger(message.grant) ||
            !Number.isSafeInteger(message.expected_revision) ||
            typeof message.role !== 'string' ||
            !ROLE.test(message.role)
          )
            return reply({ error: 'bad_request', reason: 'fields' })
          if (this.paused) return reply({ error: 'paused', reason: this.paused })
          const answer = this.network.setRole(this.identity, message.grant, message.expected_revision, message.role)
          reply(answer)
          if (answer.changed === true)
            this.event({ ev: 'grant.role_changed', grant: answer.grant, role: answer.role, revision: answer.revision })
          return
        }
        case 'grant.add_connected': {
          if (!this.lists('grant-add-connected'))
            return reply({ error: 'unknown_op', reason: 'grant.add_connected' })
          // As the helper: every field is required and no other is taken; the identity is the connection's peer.
          const fields = Object.keys(message).filter((key) => key !== 'op' && key !== 'id')
          const name = message.name
          if (
            fields.length !== 3 ||
            !Number.isSafeInteger(message.conn) ||
            typeof name !== 'string' ||
            !name ||
            Buffer.byteLength(name) > 128 ||
            typeof message.role !== 'string' ||
            !ROLE.test(message.role)
          )
            return reply({ error: 'bad_request', reason: 'fields' })
          if (this.paused) return reply({ error: 'paused', reason: this.paused })
          const conn = this.conns.get(Number(message.conn))
          const added = conn && this.network.grantConnected(this, conn, message.role)
          if (!added) return reply({ error: 'no_conn', reason: 'not live' })
          const failing = this.network.storeFailing.get(this.identity) ?? 0
          if (failing > 0) {
            this.network.storeFailing.set(this.identity, failing - 1)
            return reply({ error: 'store_failed', reason: 'disk' })
          }
          return reply({ ...added, role: this.network.roleOf(added.grant).role })
        }
        case 'grants.list':
          return reply({
            grants: this.network.grantsAt(this.identity).map(({ caller, grant, role, revision }) => ({
              grant,
              identity: caller,
              name: '',
              role,
              ...(this.lists('grant-roles') ? { revision } : {}),
              expires_at: null,
              receipt: this.network.receipts.get(String(grant)) ?? null,
              ...(this.relays ? { relay: this.relays.grants.get(caller) ?? 'no_key' } : {}),
              ...this.versionRefusal(caller)
            }))
          })
        case 'grant.remove': {
          const caller = this.network.revoke(this.identity, message.grant)
          reply({ removed: caller !== undefined })
          if (caller !== undefined)
            this.event({ ev: 'grant.closed', grant: message.grant, connections: 0 })
          return
        }
        case 'peer.add': {
          const routes = ((message.routes as unknown[] | undefined) ?? []).map(String)
          // As the helper: the record takes the role given, `owner` when none is.
          const role = typeof message.role === 'string' ? message.role : 'owner'
          if (this.network.minor >= 1) {
            // As a 1.1 helper: every route is kept; only the automatic ones are dialled without approval.
            if (routes.some((route) => !parseRoute(route)))
              return reply({ error: 'bad_route', reason: 'not a route' })
            const known = this.network.knownFor(this.identity, String(message.identity))
            for (const route of routes) if (!known.hints.includes(route)) known.hints.push(route)
            this.peerAdds.push(routes)
            return reply({ already: this.network.peer(this.identity, String(message.identity), role) })
          }
          // As the helper: the whole list is refused for one address outside a private range.
          const bad = routes.find((route) => !fakePrivate(route))
          if (bad)
            return reply({ error: 'bad_route', reason: `${bad} is not a private-range address` })
          this.peerAdds.push(routes)
          return reply({ already: this.network.peer(this.identity, String(message.identity), role) })
        }
        case 'peer.forget': {
          // As the helper: the host's completion records go with it, and their pending marks settle, so no replay
          // brings it back (unless `replay-after-removal`).
          if (!this.network.defects.has('replay-after-removal'))
            for (const flow of this.network.flowsOf(this).values())
              if (flow.done?.identity === String(message.identity)) {
                delete flow.done
                flow.pending = false
              }
          return reply({ forgotten: this.network.forget(this.identity, String(message.identity)) })
        }
        case 'join.cancel': {
          const waiting = this.codeWaits.get(String(message.invitation))
          this.codeWaits.delete(String(message.invitation))
          waiting?.reply({ error: 'cancelled', reason: 'cancelled' })
          return reply()
        }
        case 'peer.addresses.set': {
          if (this.network.minor >= 1) {
            // As a 1.1 helper: every owner kind, each an `owner` approval; those no longer listed lose theirs.
            const entries = message.routes as unknown[]
            const routes = entries.filter((entry): entry is string => typeof entry === 'string')
            const ssh = entries.filter(
              (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object'
            )
            for (const route of routes) {
              const parsed = parseRoute(route)
              const loopback = parsed?.literal && isLoopbackIp(parsed.host)
              if (!parsed || parsed.kind === 'ssh' || (routeClass(parsed) === 'forbidden' && !loopback))
                return reply({ error: 'bad_route', reason: `${route} cannot be dialled` })
            }
            const identity = String(message.identity)
            const known = this.network.knownFor(this.identity, identity)
            for (const route of known.owner) if (!routes.includes(route)) known.approved.delete(route)
            known.owner = routes
            known.ssh = ssh
            for (const route of routes) known.approved.add(route)
            this.addresses.set(identity, routes)
            return reply({ routes })
          }
          // As the helper: private ranges only (RFC 1918, link-local, ULA).
          const routes = (message.routes as unknown[]).map(String)
          const bad = routes.find((route) => !fakePrivate(route))
          if (bad)
            return reply({ error: 'bad_route', reason: `${bad} is not a private-range address` })
          this.addresses.set(String(message.identity), routes)
          return reply({ routes })
        }
        case 'stream.open': {
          const conn = this.conns.get(Number(message.conn))
          if (!conn || !conn.up) return reply({ error: 'peer_offline' })
          // Toward the dialler only on a both-ways connection (minor 3).
          if (conn.b === this && !this.network.bothWays)
            return reply({ error: 'one_way', reason: 'the caller on this connection does not take calls on it' })
          const end = this.network.open(this, conn, String(message.label), String(message.class))
          reply({ handle: end.handle })
          this.send(creditFrame(end.handle, STREAM_CREDIT))
          return
        }
        case 'stream.accept':
          return reply()
        case 'stream.reset': {
          const end = this.ends.get(Number(message.handle))
          if (end) {
            end.closed = true
            this.ends.delete(end.handle)
            this.network.reset(end, String(message.code ?? 'reset'))
          }
          return reply()
        }
        default:
          return reply({ error: 'unknown_op', reason: String(message.op) })
      }
    } catch (error) {
      reply({ error: (error as { code?: string }).code ?? 'internal' })
    }
  }
}

/** Whether a ticket decodes as kind 2. */
function linkKind(ticket: string): boolean {
  try {
    return decodeTicket(ticket).kind === 2
  } catch {
    return false
  }
}

/** The helper's answers to relay requests (Phase 3), over what a test set in `relays`. */
function relayAnswer(message: Record<string, any>, relays: FakeRelays): Record<string, unknown> {
  const find = (id: unknown) => relays.relays.find((relay) => relay.id === id)
  switch (message.op) {
    case 'relay.list':
      if (relays.listFailures) {
        relays.listFailures -= 1
        return { error: 'busy', reason: 'starting' }
      }
      return { relays: relays.relays, available: relays.available }
    case 'relay.enroll': {
      if (relays.enrollError) return { error: relays.enrollError, reason: 'refused' }
      const match = /^mousse-relay:\/\/([^/#]+)\/#([A-Za-z0-9_-]+)\./.exec(String(message.link))
      if (!match) return { error: 'bad_link', reason: "That isn't a relay link" }
      const id = Buffer.from(match[2]!, 'base64url').toString('hex')
      if (find(id)) return { error: 'already', reason: 'This relay is already set up' }
      const relay = {
        id,
        endpoint: match[1],
        destination: `relay://${match[1]}`,
        state: 'registered',
        reason: null,
        retry_ms: null,
        callers: relays.grants.size,
        callers_max: 256,
        added_at: Math.floor(Date.now() / 1000),
        rotated_at: null,
        rotating_until: null,
        new_key_pending: false
      }
      relays.relays.push(relay)
      return { relay }
    }
    case 'relay.remove': {
      if (!find(message.relay)) return { error: 'no_relay', reason: 'No such relay' }
      relays.relays = relays.relays.filter((relay) => relay.id !== message.relay)
      return { removed: true }
    }
    case 'relay.rotate': {
      const relay = find(message.relay)
      if (!relay) return { error: 'no_relay', reason: 'No such relay' }
      if (message.cancel === true) {
        if (!relay.new_key_pending) return { error: 'not_rotating', reason: 'No new key is on its way' }
        relay.cancelling = true
        return { relay }
      }
      if (relay.chain_full) return { error: 'chain_full', reason: 'The relay holds as many keys as it allows' }
      if (relay.state !== 'registered') return { error: 'not_registered', reason: 'not connected' }
      const now = Math.floor(Date.now() / 1000)
      // The helper answers before the relay takes the new key; `rotating_until` comes later, in a `relay.state`.
      Object.assign(relay, { rotated_at: now, new_key_pending: true })
      return { relay }
    }
    case 'peer.relay.allow':
    case 'peer.relay.disallow': {
      const allow = message.op === 'peer.relay.allow'
      const route = (relays.peers.get(String(message.identity))?.routes ?? []).find(
        (item: Record<string, unknown>) => item.destination === message.destination
      )
      const changed = !!route && route.approved !== allow
      if (route) Object.assign(route, { approved: allow, source: allow ? 'manifest' : null })
      return { changed }
    }
    default:
      return { error: 'unknown_op', reason: String(message.op) }
  }
}

/** As the helper reads a route: private ranges only (RFC 1918, link-local, ULA). */
function fakePrivate(route: string): boolean {
  return /^tcp:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[f[cd])/i.test(route)
}
