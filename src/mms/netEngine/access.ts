import { randomUUID } from 'node:crypto'
import { NetError } from '../../shared/net/errors'
import type { NodeId } from '../../shared/net'
import type { AccessPresetFields } from '../../shared/net/accessPresets'
import type { NetEngineAccessAsk, NetEngineOtherWay } from '../../shared/netEngine/local'
import { helperCode } from './helper/appChannel'
import type { EngineHelper } from './helper/connections'
import { engineLimits } from './limits'
import type { PairingStep } from './pairing'
import type { EngineSessions } from './sessions'
import type { EngineMessage } from './session/frame'
import {
  ACCESS_FEATURE,
  SESSION_FEATURES,
  type Channel,
  type EngineConnection
} from './session/transport'
import type { EnginePeerRow, EnginePeerStore } from './store'

/** What asking for the other direction needs from the profile's engine. */
export interface EngineAccessPort {
  peers: EnginePeerStore
  sessions: EngineSessions
  helper(): EngineHelper | undefined
  /** Whether the app that calls this computer as `node` said `feature` in its last hello here. */
  callerSays(node: NodeId, feature: string): boolean | undefined
  /** Saves the level the owner picked for `node`, before the helper's grant for it exists. */
  applyAccess(node: NodeId, access: AccessPresetFields): void
  /** This computer may use `node` now: its call back on the other computer's connection is attached. */
  dial(node: NodeId): Promise<void>
  /**
   * Calls `node` back once over its own connection, whether or not this computer uses it yet: whether that computer
   * served the call (so it holds a grant for this one).
   */
  served(node: NodeId): Promise<boolean>
  /** Ends this computer's calls to `node` that a `served` left open. */
  release(node: NodeId): void
  /** A test's crash point (`EnginePairing.checkpoint`). */
  checkpoint(step: PairingStep): void
  changed(): void
}

/** One open `access.*` exchange with a pairing: this computer opened it (`client`), or the other one did. */
interface AccessLink {
  channel: Channel
  connection: EngineConnection
  /** What this computer last said it grants the other one (`access.state`). */
  sent?: boolean
}

/** A request this computer sent ("Use <name> from here…"). */
interface Ask {
  id: string
  state: 'waiting' | 'declined' | 'expired'
  timer?: ReturnType<typeof setTimeout>
}

/** A request the other computer sent, waiting for this computer's owner (the Allow prompt). */
interface Prompt {
  id: string
  timer: ReturnType<typeof setTimeout>
}

const ID = /^[A-Za-z0-9_-]{1,64}$/

/** The grant's name: the row's name within the helper's 1 to 128 bytes, cut on a character. */
export function grantName(name: string, fallback: string): string {
  let out = ''
  for (const char of name) {
    if (Buffer.byteLength(out + char) > 128) break
    out += char
  }
  return out.trim() || fallback
}

/** Exactly these keys, so a message with anything more (an identity, a role) changes nothing. */
const only = (header: EngineMessage['header'], keys: readonly string[]): boolean => {
  const own = Object.keys(header)
  return own.length === keys.length && own.every((key) => keys.includes(key))
}

/**
 * The other direction of a one-way pairing (pairing flow design §7), over one long-lived `mousse.hello` exchange
 * per pairing that the calling side opens once both apps said `access-ask`:
 *
 * - The computer only let in asks (`access.request {id}`), and its owner sees Waiting until the answer, a cancel or
 *   `accessAskMs`. One request per pairing at a time, and not sooner than `accessAskGapMs` after the last.
 * - The computer that uses the other one shows its owner the Allow prompt for the connection's own peer, at most
 *   one at a time and not sooner than `accessPromptGapMs` after the last. Allow saves the level first, then the
 *   helper grants that peer over the live connection (`grant.add_connected`), then the row records it.
 * - `access.state {granted}` tells what the sender grants the receiver, at setup and after each change. Nothing a
 *   message says grants anything here: only this owner's Allow (or Let) does. Nor does one alone move a row: this
 *   computer starts using the other only on an Allow to its own request, or once a call over the connection was
 *   served there, and never in a direction its owner removed until that owner asks again.
 */
export class EngineAccess {
  private readonly clients = new Map<NodeId, AccessLink>()
  private readonly hosts = new Map<NodeId, AccessLink>()
  private readonly asks = new Map<NodeId, Ask>()
  private readonly lastAsk = new Map<NodeId, number>()
  private readonly prompts = new Map<NodeId, Prompt>()
  private readonly lastPrompt = new Map<NodeId, number>()
  /** Request ids each other computer sent, with when they came, oldest first (`firstSeen`). */
  private readonly seen = new Map<NodeId, Map<string, number>>()
  /** Pairings whose "it grants this computer" is being checked with a call. */
  private readonly checking = new Set<NodeId>()
  /** Grants being made, so a second Allow joins the first. */
  private readonly granting = new Map<NodeId, Promise<void>>()
  private stopped = false

  constructor(private readonly port: EngineAccessPort) {}

  /** The session features this computer says: `access-ask` only while its helper can grant over a connection. */
  features(): string[] {
    return [...SESSION_FEATURES, ...(this.able() ? [ACCESS_FEATURE] : [])]
  }

  private able(): boolean {
    return this.port.helper()?.has('grant-add-connected') === true
  }

  stop(): void {
    this.stopped = true
    for (const ask of this.asks.values()) clearTimeout(ask.timer)
    for (const prompt of this.prompts.values()) clearTimeout(prompt.timer)
    this.asks.clear()
    this.prompts.clear()
    for (const link of [...this.clients.values(), ...this.hosts.values()]) link.channel.end()
    this.clients.clear()
    this.hosts.clear()
  }

  // ---------------------------------------------------------------- the exchange

  /**
   * This computer's client of `node` is ready (or moved to a new path): its exchange is opened on that connection
   * when the other app said `access-ask`. One that ended on the same connection is not opened again there.
   */
  ensure(node: NodeId): void {
    if (this.stopped || !this.able() || !this.port.sessions.online(node)) return
    if (this.port.sessions.says(node, ACCESS_FEATURE) !== true) return
    const client = this.port.sessions.client(node)
    const held = this.clients.get(node)
    if (held && held.connection === client.connection) return
    let channel: Channel
    try {
      channel = client.openAccess()
    } catch {
      return
    }
    const link: AccessLink = { channel, connection: client.connection }
    this.clients.set(node, link)
    channel.onMessage((message) => {
      if (message.header.t === 'error') return channel.end()
      // Its row is read again for each message: a removed pairing says nothing more.
      if (this.port.peers.serving(node)) this.receive(node, message.header)
    })
    channel.onEnd(() => {
      channel.end()
      if (this.clients.get(node) === link) this.port.changed()
    })
    this.tell(node, link)
    this.port.changed()
  }

  /** The other computer opened its exchange here (its caller was checked). */
  opened(node: NodeId, connection: EngineConnection, channel: Channel): void {
    if (this.stopped) return channel.end()
    const link: AccessLink = { channel, connection }
    this.hosts.get(node)?.channel.end()
    this.hosts.set(node, link)
    channel.onEnd(() => {
      channel.end()
      if (this.hosts.get(node) === link) {
        this.hosts.delete(node)
        this.port.changed()
      }
    })
    this.tell(node, link)
    this.port.changed()
  }

  /** The open exchange with `node`, this computer's own first. */
  private link(node: NodeId): AccessLink | undefined {
    const client = this.clients.get(node)
    if (client?.channel.isOpen()) return client
    const host = this.hosts.get(node)
    return host?.channel.isOpen() ? host : undefined
  }

  private send(node: NodeId, header: EngineMessage['header']): boolean {
    const link = this.link(node)
    if (!link) return false
    try {
      link.channel.send(header)
      return true
    } catch {
      return false
    }
  }

  /** Whether this computer lets `node` use it now. */
  private grants(row: EnginePeerRow | undefined): boolean {
    return !!row && row.state === 'connected' && !!row.grant && !row.revoking
  }

  /** Says what this computer grants the other one on `link`, when that changed since it last said. */
  private tell(node: NodeId, link: AccessLink): void {
    let granted: boolean
    try {
      granted = this.grants(this.port.peers.serving(node))
    } catch {
      return
    }
    if (link.sent === granted || !link.channel.isOpen()) return
    try {
      link.channel.send({ t: 'access.state', granted })
      link.sent = granted
    } catch {
      // Said again on the next change.
    }
  }

  /** After any change here: each open exchange says what this computer grants now, if that changed. */
  refresh(): void {
    if (this.stopped) return
    for (const [node, link] of [...this.clients, ...this.hosts]) this.tell(node, link)
  }

  // ---------------------------------------------------------------- what the other computer says

  /** One message of a pairing's exchange. One that is not exactly as defined is dropped. */
  receive(node: NodeId, header: EngineMessage['header']): void {
    if (this.stopped) return
    switch (header.t) {
      case 'access.request':
        if (only(header, ['t', 'id']) && typeof header.id === 'string' && ID.test(header.id))
          this.requested(node, header.id)
        return
      case 'access.cancel':
        if (only(header, ['t', 'id']) && typeof header.id === 'string') this.cancelled(node, header.id)
        return
      case 'access.answer':
        if (
          only(header, ['t', 'id', 'decision']) &&
          typeof header.id === 'string' &&
          (header.decision === 'allow' || header.decision === 'not_now')
        )
          this.answered(node, header.id, header.decision)
        return
      case 'access.state':
        if (only(header, ['t', 'granted']) && typeof header.granted === 'boolean')
          this.stated(node, header.granted)
        return
    }
  }

  /** It asks to use this computer: the Allow prompt, for this connection's peer only. */
  private requested(node: NodeId, id: string): void {
    const row = this.port.peers.serving(node)
    if (!row || row.state !== 'connected' || row.source || row.revoking || !this.able()) return
    // It may use this computer already: it is told so, and nothing is asked.
    if (row.ways !== 'out') {
      const link = this.link(node)
      if (link) {
        link.sent = undefined
        this.tell(node, link)
      }
      return
    }
    if (!this.firstSeen(node, id)) return
    if (this.prompts.has(node)) return
    const now = Date.now()
    if (now - (this.lastPrompt.get(node) ?? -Infinity) < engineLimits().accessPromptGapMs) return
    this.lastPrompt.set(node, now)
    const timer = setTimeout(() => {
      if (this.prompts.get(node)?.id !== id) return
      this.prompts.delete(node)
      this.port.changed()
    }, engineLimits().accessAskMs)
    timer.unref?.()
    this.prompts.set(node, { id, timer })
    this.port.changed()
  }

  /**
   * Whether `id` is a request `node` has not sent before, remembering it if so. An id is kept for `accessSeenMs`
   * however many come after it: while `accessSeenIds` are kept, a new one is refused rather than an old one dropped.
   */
  private firstSeen(node: NodeId, id: string): boolean {
    const now = Date.now()
    const seen = this.seen.get(node) ?? new Map<string, number>()
    this.seen.set(node, seen)
    // Kept in the order they came: the oldest go once their time is up.
    for (const [old, at] of seen) {
      if (now - at < engineLimits().accessSeenMs) break
      seen.delete(old)
    }
    if (seen.has(id) || seen.size >= engineLimits().accessSeenIds) return false
    seen.set(id, now)
    return true
  }

  /** It cancelled its request: the prompt closes. */
  private cancelled(node: NodeId, id: string): void {
    const prompt = this.prompts.get(node)
    if (prompt?.id !== id) return
    clearTimeout(prompt.timer)
    this.prompts.delete(node)
    this.port.changed()
  }

  /** The answer to this computer's own request; any other answer, or one after it ended, changes nothing. */
  private answered(node: NodeId, id: string, decision: 'allow' | 'not_now'): void {
    const ask = this.asks.get(node)
    if (!ask || ask.state !== 'waiting' || ask.id !== id) return
    clearTimeout(ask.timer)
    if (decision === 'not_now') {
      ask.state = 'declined'
      this.port.changed()
      return
    }
    this.asks.delete(node)
    this.gained(node)
  }

  /**
   * What it says it grants this computer now: information only, so the message alone changes nothing here. A `true`
   * (its owner let this computer in from there, say) is checked with one call over its connection, and only a call
   * it served (its helper holds a grant for this computer) adds the direction.
   */
  private stated(node: NodeId, granted: boolean): void {
    if (!granted || this.checking.has(node) || !this.mayGain(node)) return
    this.checking.add(node)
    void this.port
      .served(node)
      .catch(() => false)
      .then((served) => {
        this.checking.delete(node)
        if (!served) return
        if (!this.stopped && this.mayGain(node)) {
          const ask = this.asks.get(node)
          if (ask) clearTimeout(ask.timer)
          this.asks.delete(node)
          return this.gained(node)
        }
        // The row changed while the call ran: unless this computer uses it now (an Allow came meanwhile), the call
        // it opened ends.
        const row = this.port.peers.serving(node)
        if (this.stopped || !row || row.ways === 'in') this.port.release(node)
      })
  }

  /**
   * Whether this computer may start using `node`: it is only let in, and this computer's owner did not remove that
   * it uses it (until that owner asks again).
   */
  private mayGain(node: NodeId): boolean {
    const row = this.port.peers.serving(node)
    return (
      !!row && row.ways === 'in' && row.state === 'connected' && !row.source && !row.revoking && !row.stoppedUsing
    )
  }

  /** It let this computer in: its row lists both directions and this computer uses it over its connection. */
  private gained(node: NodeId): void {
    if (!this.mayGain(node)) return
    this.port.peers.advance(node, ['connected'], { ways: null })
    this.port.changed()
    void this.port.dial(node).catch(() => undefined)
  }

  // ---------------------------------------------------------------- this computer's owner

  /** What a pairing's row offers for its missing direction, if anything. */
  other(row: EnginePeerRow): NetEngineOtherWay | undefined {
    if (this.stopped || row.source || row.revoking || row.state !== 'connected' || !row.ways) return undefined
    if (!this.able()) return undefined
    const node = row.localId
    const blocked = 'Not connected right now.'
    if (row.ways === 'in') {
      // An app that never said it can answer is not asked: the item is absent.
      if (this.port.callerSays(node, ACCESS_FEATURE) !== true) return undefined
      const asked = this.asks.get(node)?.state
      return {
        offer: 'ask',
        ...(this.hosts.get(node)?.channel.isOpen() ? {} : { blocked }),
        ...(asked ? { asked } : {})
      }
    }
    if (this.port.sessions.says(node, ACCESS_FEATURE) !== true) return undefined
    return {
      offer: 'let',
      ...(this.port.sessions.online(node) && this.clients.get(node)?.channel.isOpen() ? {} : { blocked })
    }
  }

  /** Requests from other computers waiting for this owner. */
  pending(): NetEngineAccessAsk[] {
    const out: NetEngineAccessAsk[] = []
    for (const [node, prompt] of this.prompts) {
      const row = this.port.peers.serving(node)
      if (row) out.push({ node, request: prompt.id, name: row.name })
    }
    return out
  }

  /** "Use <name> from here…": asks the computer it lets in to let this one in too. */
  ask(node: NodeId): void {
    const row = this.port.peers.serving(node)
    if (!row) throw new NetError('bad_request', 'Unknown device.')
    const offer = this.other(row)
    if (offer?.offer !== 'ask') throw new NetError('bad_request', "This device can't be asked.")
    if (offer.blocked) throw new NetError('peer_offline', offer.blocked)
    if (this.asks.get(node)?.state === 'waiting') return
    const now = Date.now()
    if (now - (this.lastAsk.get(node) ?? -Infinity) < engineLimits().accessAskGapMs)
      throw new NetError('bad_request', 'Asked just now. Try again in a moment.', {
        details: { reason: 'too_soon' }
      })
    const id = randomUUID()
    if (!this.send(node, { t: 'access.request', id }))
      throw new NetError('peer_offline', 'Not connected right now.')
    this.lastAsk.set(node, now)
    // This owner asks again for a direction it removed: an Allow, or a call it serves, may add it now.
    if (row.stoppedUsing) this.port.peers.update(node, { stoppedUsing: null })
    const ask: Ask = { id, state: 'waiting' }
    ask.timer = setTimeout(() => {
      if (this.asks.get(node) !== ask || ask.state !== 'waiting') return
      ask.state = 'expired'
      this.send(node, { t: 'access.cancel', id })
      this.port.changed()
    }, engineLimits().accessAskMs)
    ask.timer.unref?.()
    this.asks.set(node, ask)
    this.port.changed()
  }

  /** Cancel on the Waiting row, or clearing what the row says after an answer: the request ends here and there. */
  cancel(node: NodeId): void {
    const ask = this.asks.get(node)
    if (!ask) return
    clearTimeout(ask.timer)
    this.asks.delete(node)
    if (ask.state === 'waiting') this.send(node, { t: 'access.cancel', id: ask.id })
    this.port.changed()
  }

  /** The owner answered another computer's request: Not now tells it so; Allow lets it in at `access`. */
  async answer(
    node: NodeId,
    request: string,
    yes: boolean,
    access?: AccessPresetFields
  ): Promise<void> {
    const prompt = this.prompts.get(node)
    if (prompt?.id !== request) throw new NetError('bad_request', 'That request has ended.')
    if (!yes) {
      clearTimeout(prompt.timer)
      this.prompts.delete(node)
      this.send(node, { t: 'access.answer', id: request, decision: 'not_now' })
      this.port.changed()
      return
    }
    if (!access) throw new NetError('bad_request', 'Pick what it may do here.')
    await this.letIn(node, access)
    if (this.prompts.get(node) === prompt) {
      clearTimeout(prompt.timer)
      this.prompts.delete(node)
    }
    this.send(node, { t: 'access.answer', id: request, decision: 'allow' })
    this.port.changed()
  }

  /** "Let <name> use this computer…": this owner lets the computer it uses in, at `access`, over the live connection. */
  async let(node: NodeId, access: AccessPresetFields): Promise<void> {
    const row = this.port.peers.serving(node)
    if (!row) throw new NetError('bad_request', 'Unknown device.')
    const offer = this.other(row)
    if (offer?.offer !== 'let') throw new NetError('bad_request', "This device can't be let in from here.")
    if (offer.blocked) throw new NetError('peer_offline', offer.blocked)
    await this.letIn(node, access)
  }

  private letIn(node: NodeId, access: AccessPresetFields): Promise<void> {
    const running = this.granting.get(node)
    if (running) return running
    const run = this.grant(node, access).finally(() => this.granting.delete(node))
    this.granting.set(node, run)
    return run
  }

  /**
   * The level is saved under the row's id first: nothing is served under it yet, since the row holds no grant.
   * Then the helper grants the connection's peer and saves that grant; then the row takes it. A stop between the
   * last two leaves a grant without its row only until the next start, whose reconciliation writes the row
   * (`EnginePairing.owe`) under the level saved first.
   */
  private async grant(node: NodeId, access: AccessPresetFields): Promise<void> {
    const { peers, sessions } = this.port
    const row = peers.serving(node)
    if (!row || row.state !== 'connected' || row.ways !== 'out' || row.source || row.revoking)
      throw new NetError('bad_request', 'It already uses this computer, or the pairing changed.')
    const helper = this.port.helper()
    if (!helper?.has('grant-add-connected'))
      throw new NetError('bad_request', 'Update networking to do this.', { details: { reason: 'not_supported' } })
    const conn = Number(sessions.client(node).connection.id)
    if (!Number.isSafeInteger(conn)) throw new NetError('peer_offline', 'Not connected right now.')
    this.port.applyAccess(node, access)
    const fields = { conn, name: grantName(row.name, `Computer ${row.endpoint.slice(0, 8)}`), role: 'owner' }
    let answer: Record<string, unknown>
    try {
      try {
        answer = await helper.request('grant.add_connected', fields)
      } catch (error) {
        // The grant is in effect and was not saved: a repeat saves it.
        if (helperCode(error) !== 'store_failed') throw error
        answer = await helper.request('grant.add_connected', fields)
      }
    } catch (error) {
      const code = helperCode(error)
      throw new NetError(
        'peer_offline',
        code === 'no_conn'
          ? 'Not connected right now.'
          : code === 'paused'
            ? 'Networking is paused.'
            : "Couldn't let it in; try again.",
        { details: { reason: code ?? 'helper' } }
      )
    }
    this.port.checkpoint('let-in')
    const grant = String(answer.grant)
    peers.advance(node, ['connected'], { grant, ways: null })
    this.port.changed()
  }
}
