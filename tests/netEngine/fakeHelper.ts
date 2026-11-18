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

const STREAM_CREDIT = 256 * 1024

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
}

export class FakeNetwork {
  private readonly helpers = new Map<string, FakeHelper>()
  /** For each host identity, the grant each caller identity holds there (the helper's numbers; tests may name one). */
  private readonly grants = new Map<string, Map<string, number | string>>()
  /** For each identity, the identities it may dial (its peers). */
  private readonly peers = new Map<string, Set<string>>()
  /** Open invitations by ticket, with their host. */
  readonly invitations = new Map<string, { host: string; invitation: string }>()
  private nextGrant = 1
  private readonly conns = new Set<Conn>()
  private next = 1
  readonly crossed: Crossed[] = []
  /** Decides each message that crosses; `drop` loses it on the way. */
  tap?: (message: Crossed) => 'drop' | void

  /**
   * `caller` holds a grant at `host` (a new grant number when none is given) and knows `host` as a peer; answers
   * the grant, as `grant.add` does.
   */
  grant(
    host: string,
    caller: string,
    grant?: number | string
  ): { grant: number | string; already: boolean } {
    let held = this.grants.get(host)
    if (!held) this.grants.set(host, (held = new Map()))
    const had = held.get(caller)
    if (grant === undefined && had !== undefined) return { grant: had, already: true }
    const given = grant ?? this.nextGrant++
    held.set(caller, given)
    this.peer(caller, host)
    return { grant: given, already: false }
  }

  /** The grants callers hold at `host`, as `grants.list` answers. */
  grantsAt(host: string): Array<{ caller: string; grant: number | string }> {
    return [...(this.grants.get(host) ?? [])].map(([caller, grant]) => ({ caller, grant }))
  }

  /** `host` removes the grant `grant`: its connections with that caller go down; answers the caller, if any. */
  revoke(host: string, grant: number | string): string | undefined {
    const held = this.grants.get(host)
    for (const [caller, given] of held ?? [])
      if (String(given) === String(grant)) {
        held!.delete(caller)
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
  forget(from: string, to: string): boolean {
    return !!this.peers.get(from)?.delete(to)
  }

  /** `from` knows `to` as a peer (it may dial it); answers whether it did already. */
  peer(from: string, to: string): boolean {
    let known = this.peers.get(from)
    if (!known) this.peers.set(from, (known = new Set()))
    const already = known.has(to)
    known.add(to)
    return already
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

  /** @internal */
  dial(from: FakeHelper, identity: string): number {
    if (!this.peers.get(from.identity)?.has(identity))
      throw Object.assign(new Error('not paired with that identity'), { code: 'no_peer' })
    const to = this.helpers.get(identity)
    if (!to || !to.alive) throw Object.assign(new Error('unreachable'), { code: 'unreachable' })
    const grant = this.grants.get(identity)?.get(from.identity)
    if (grant === undefined) throw Object.assign(new Error('not allowed'), { code: 'forbidden' })
    const conn: Conn = {
      id: { [from.identity]: this.next++, [identity]: this.next++ },
      a: from,
      b: to,
      ends: new Set(),
      up: true
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
    to.incoming(theirs, conn.id[to.identity]!, label, cls)
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
function ticketOf(host: string, invitation: string): string {
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
    head(4, 0)
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

export class FakeHelper {
  alive = true
  /** The app's end of the channel. */
  readonly pipe: AppPipe
  private readonly own: AppPipe
  private readonly reader = new FrameReader()
  private readonly ends = new Map<number, End>()
  private readonly conns = new Map<number, Conn>()
  private nextHandle = 1
  private helloed = false
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
    this.event({ ev: 'conn.up', conn: id, identity, dir, ...fields, deadline: 0 })
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
  incoming(end: End, conn: number, label: string, cls: string): void {
    this.event({ ev: 'stream.incoming', conn, handle: end.handle, label, class: cls })
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
      this.request(JSON.parse(body.toString('utf8')) as Record<string, any>)
    }
  }

  private request(message: Record<string, any>): void {
    const re = message.id
    const reply = (fields: Record<string, unknown> = {}) => this.send(jsonFrame({ re, ...fields }))
    try {
      if (!this.helloed && message.op !== 'hello')
        return reply({ error: 'no_hello', reason: 'hello first' })
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
          return reply({
            proto: [1, 0],
            identity: this.identity,
            routes: [],
            paused: this.paused ?? null
          })
        }
        case 'config.set':
          return reply()
        case 'shutdown':
          if (this.ignoreShutdown) return
          reply()
          return void setImmediate(() => this.kill())
        case 'dial':
          if (this.paused) return reply({ error: 'paused', reason: this.paused })
          return reply({ conn: this.network.dial(this, String(message.identity)), already: false })
        case 'invite.create': {
          const invitation = randomBytes(16).toString('hex')
          const uri = ticketOf(this.identity, invitation)
          this.network.invitations.set(uri, { host: this.identity, invitation })
          return reply({
            invitation,
            uri,
            routes: [],
            expires_at: Math.floor(Date.now() / 1000) + 600
          })
        }
        case 'invite.cancel':
          for (const [uri, open] of this.network.invitations)
            if (open.invitation === message.invitation) this.network.invitations.delete(uri)
          return reply()
        case 'join': {
          if (this.paused) return reply({ error: 'paused', reason: this.paused })
          const open = this.network.invitations.get(String(message.ticket))
          const host = open && this.network.helperOf(open.host)
          if (!open || !host?.alive)
            return reply({ error: 'bad_ticket', reason: 'no such invitation' })
          this.event({
            ev: 'join.progress',
            invitation: open.invitation,
            step: 'connecting',
            route: 'fake'
          })
          host.askApproval(open.invitation, this, this.hello?.name ?? this.identity, (fields) => {
            if (fields.error) return reply(fields)
            // As the helper: the connection comes up before the join's reply.
            const conn = this.network.dial(this, open.host)
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
          this.approvals.delete(String(message.request))
          if (message.yes !== true) {
            reply()
            return waiting.answer({ error: 'declined', reason: 'the host declined' })
          }
          for (const [uri, open] of this.network.invitations)
            if (open.invitation === waiting.invitation) this.network.invitations.delete(uri)
          const { grant } = this.network.grant(this.identity, waiting.joiner.identity)
          reply()
          this.event({
            ev: 'enrolled',
            invitation: waiting.invitation,
            grant,
            identity: waiting.joiner.identity
          })
          this.event({ ev: 'invite.ended', invitation: waiting.invitation, reason: 'used' })
          return waiting.answer({})
        }
        case 'grant.add':
          return reply(this.network.grant(this.identity, String(message.identity)))
        case 'grants.list':
          return reply({
            grants: this.network.grantsAt(this.identity).map(({ caller, grant }) => ({
              grant,
              identity: caller,
              name: '',
              role: 'owner',
              expires_at: null,
              receipt: null
            }))
          })
        case 'grant.remove': {
          const caller = this.network.revoke(this.identity, message.grant)
          reply({ removed: caller !== undefined })
          if (caller !== undefined)
            this.event({ ev: 'grant.closed', grant: message.grant, connections: 0 })
          return
        }
        case 'peer.add':
          return reply({ already: this.network.peer(this.identity, String(message.identity)) })
        case 'peer.forget':
          return reply({ forgotten: this.network.forget(this.identity, String(message.identity)) })
        case 'join.cancel':
          return reply()
        case 'stream.open': {
          const conn = this.conns.get(Number(message.conn))
          if (!conn || !conn.up) return reply({ error: 'peer_offline' })
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
