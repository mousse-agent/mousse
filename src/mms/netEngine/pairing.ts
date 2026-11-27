import { createHash } from 'node:crypto'
import { NetError } from '../../shared/net/errors'
import type { NodeId } from '../../shared/net'
import type { AccessPresetFields } from '../../shared/net/accessPresets'
import {
  isNetEngineWay,
  isSshParked,
  type NetEngineWay,
  type NetEngineApproval,
  type NetEngineLinkInvite,
  type NetEngineLinkJoin,
  type NetEngineSshParked
} from '../../shared/netEngine/local'
import type { EngineCaller } from '../net/contracts'
import { helperCode } from './helper/appChannel'
import type { EngineHelper } from './helper/connections'
import { engineControl, engineLimits } from './limits'
import { OWNER_ROLE } from './roles'
import { approvedHints, loopbackClass, pairbackRoutes, privateRoute, splitPairback } from './routes'
import type { EngineSessions } from './sessions'
import {
  isServingState,
  type EngineLink,
  type EnginePeerRow,
  type EnginePeerStore,
  type EngineWays
} from './store'
import { LINK_KIND, pairingLink, readTicket, sendLink, type TicketFacts } from './ticket'
import { parseRoute, routeClass } from '../../shared/netEngine/routes'

/** A route to an address on a tailnet (Tailscale's 100.64.0.0/10), or a loopback route a check maps to one. */
const tailnetRoute = (route: string): boolean => {
  const parsed = parseRoute(route)
  return !!parsed && (loopbackClass(route) ?? routeClass(parsed)) === 'tailnet'
}

/**
 * The points of the ceremony and of a removal where a test may stop this computer as a crash would (`crashAt`):
 * nothing after the point is written until the engine starts again.
 */
export type PairingStep =
  /** Joiner: the consent journal is written, `join` not sent. */
  | 'consented'
  /** Joiner: `join` answered (the host saved its grant), `joined` not written. */
  | 'join-replied'
  /** Joiner: `joined` written, `grant.add` not sent. */
  | 'joined'
  /** Joiner: `granted` written, `pairback` not sent. */
  | 'granted'
  /** Host: `enrolled` heard, its row not written. */
  | 'enrolled'
  /** Host: `pairback` heard, `peer.add` not sent. */
  | 'pairback'
  /** Either: the row is `removing`, `grant.remove` not sent. */
  | 'removing'
  /** Either: `grant.remove` answered, `peer.forget` not sent. */
  | 'grant-removed'
  /** Either: one direction's grant is journaled as revoking and no longer served, `grant.revoke_local` not sent. */
  | 'revoking'
  /** Either: the other direction's level saved and `grant.add_connected` answered, its row not written. */
  | 'let-in'

export interface PairingPort {
  /** Under the routes checks' `route-leak` control: the address pairback offers first. */
  leakedRoute?(): string | undefined
  peers: EnginePeerStore
  sessions: EngineSessions
  helper(): EngineHelper | undefined
  /** Ends a pairing's Bridge work (§3.7); idempotent. */
  teardown(node: NodeId): void
  /** Ends only what this computer serves to `node` (its sessions here, their work); its own clients stay. */
  endServing?(node: NodeId): void
  /** Saves the access the owner picked in Allow for `node`, before the helper saves its grant. */
  applyAccess?(node: NodeId, access: AccessPresetFields): void
  /** Gives `to` the access saved under the reserved id `from`, when one was saved; nothing otherwise. */
  copyAccess?(from: NodeId, to: NodeId): void
  /**
   * The role a grant made now takes (§8): for `node`'s level here, or for `access` when it is given (a device not
   * known yet takes the default level).
   */
  grantRole?(node: NodeId | undefined, access?: AccessPresetFields): string
  /** A row took a grant: its role follows the row's level (`EngineRoles.follow`). True once it does. */
  followRole?(node: NodeId): Promise<boolean>
  changed(): void
  /** A test stops this computer at `step` when this answers true. */
  crashAt?(step: PairingStep): boolean
  /**
   * The state of the SSH add request a grant's receipt names, if this computer knows it (1b §3.6): host recovery
   * leaves an open one's grant to its row and removes a removed one's.
   */
  sshRequest?(receipt: string): 'open' | 'done' | 'removed' | undefined
  /** A removal finished (its grants gone, its peer forgotten): the SSH requests of that peer read `removed`. */
  removed?(row: EnginePeerRow): Promise<void>
  /** Runs a removal's steps under the lock its SSH prepares take for `endpoint` (§3.6); unset runs them as they are. */
  exclusive?<T>(endpoint: string, work: () => Promise<T>): Promise<T>
}

/** How Connect joins: the arrival the ticket came by and, for a Send link, what the owner approved and shares. */
export interface JoinOptions {
  arrival?: 'scan' | 'link'
  /** This computer's tailnet and public routes the owner ticked under "Also share". */
  share?: string[]
  /**
   * "Also let <name> use this computer": false pairs one way (no grant here, no pairback). Unset is true, the
   * pairing both ways every caller made before one-way pairing.
   */
  back?: boolean
}

/** The helper's join errors after which a Send link cannot finish: its pending link goes (§3.6, §5.3). */
const LINK_ENDED = new Set([
  'attempts_exhausted',
  'pairing_failed',
  'invitation_invalid',
  'expired',
  'forbidden_address',
  'bad_ticket',
  'not_supported',
  'declined',
  'pairing_declined',
  'no_route',
  'forgotten'
])

const LINK_NOT_USED = "This link didn't work. Ask for a new one."
const LINK_DAMAGED = 'This link is damaged. Ask for a new one.'

/** What the joiner's dialog says when a Send link join ends, by the helper's reason. */
const LINK_TEXT: Record<string, string> = {
  attempts_exhausted: 'No tries left. Ask for a new link.',
  expired: 'This link has expired. Ask for a new one.',
  invitation_invalid: LINK_NOT_USED,
  pairing_failed:
    "That code didn't work. If you typed it exactly, the link may have been swapped; get a new one another way.",
  bad_ticket: LINK_DAMAGED,
  not_supported: LINK_DAMAGED,
  forgotten: 'Removed while joining.'
}

/** A row added over SSH runs its own steps (1b §3.6): 1a's ceremony, pairback and recovery skip it. */
const skipsCeremony = (row: EnginePeerRow): boolean =>
  row.source === 'ssh' && !engineControl('ssh-row-pairback')

export const fingerprintOf = (identity: string): string =>
  `sha256:${createHash('sha256')
    .update(/^[0-9a-f]+$/i.test(identity) ? Buffer.from(identity, 'hex') : Buffer.from(identity))
    .digest('hex')}`

/** What a pairing row is called before the other computer said its name. */
const shortName = (identity: string): string => `Computer ${identity.slice(0, 8)}`

/**
 * Pairing both ways (§5.1) and removal (§5.4) for one run of the engine: the host's invitations and approvals, the
 * joiner's journal (`consented` → `joined` → `granted` → `connected`), the host's `awaiting_pairback` rows, the
 * recovery of each state at the next start or connection, and the journaled removal with its tombstone.
 */
export class EnginePairing {
  /** Approvals the host's window has not answered, by request. */
  private readonly approvals = new Map<string, NetEngineApproval>()
  /** The name each joiner gave in its approval, by invitation, for the row `enrolled` writes. */
  private readonly approvedNames = new Map<string, string>()
  /** Pairings the other computer no longer accepts (`not_authorized`, `grant_revoked`), until they connect again. */
  private readonly notAccepted = new Set<NodeId>()
  /** Pairings whose last dial failed on a certificate outside its validity window, until they connect again. */
  private readonly outsideWindow = new Set<NodeId>()
  /** Pairings whose SSH login failed in a way only the owner can fix (§1.4): nothing dials them on its own. */
  private readonly parked = new Map<NodeId, NetEngineSshParked>()
  /** The step a pairing is running, so one runs at a time per pairing. */
  private readonly running = new Map<NodeId, Promise<void>>()
  /** The session features each caller's app said in its last `hello` here, this run. */
  private readonly callerFeatures = new Map<NodeId, string[]>()
  /** Removals under way, so one runs at a time per pairing and a second Remove joins it. */
  private readonly removals = new Map<NodeId, Promise<void>>()
  private readonly waiters = new Set<() => void>()
  private readonly retries = new Map<NodeId, ReturnType<typeof setTimeout>>()
  /** Send links this computer shows, by invitation: the code to read out and the tries left (§5.1). */
  private readonly linkInvites = new Map<string, NetEngineLinkInvite>()
  /**
   * Each shown link's tries before the attempt now running: the helper takes a try when an attempt starts and shows
   * the next code then, so a right code gives the try back.
   */
  private readonly triesBefore = new Map<string, number>()
  /** Send link joins running here, by invitation: whether the helper waits for the code (§5.3). */
  private readonly linkJoins = new Map<string, NetEngineLinkJoin>()
  /** Rows whose Send link did not finish and has no outcome to recover: "Pairing didn't finish" (§5.4). */
  private readonly unfinished = new Set<NodeId>()
  /** Stopped at a test's crash point: nothing more is written in this run. */
  private crashed = false
  private stopped = false

  constructor(private readonly port: PairingPort) {}

  stop(): void {
    this.stopped = true
    for (const timer of this.retries.values()) clearTimeout(timer)
    this.retries.clear()
    for (const wake of [...this.waiters]) wake()
  }

  pendingApprovals(): NetEngineApproval[] {
    return [...this.approvals.values()]
  }
  /** Send links this computer shows. */
  links(): NetEngineLinkInvite[] {
    return [...this.linkInvites.values()].map((shown) => ({ ...shown }))
  }
  /** Send link joins running here. */
  joins(): NetEngineLinkJoin[] {
    return [...this.linkJoins.values()].map((running) => ({ ...running }))
  }
  /** A Send link join for this row is running (it may wait for the code). */
  linkJoining(node: NodeId): boolean {
    return [...this.linkJoins.values()].some((running) => running.node === node)
  }
  /** Its Send link did not finish: the row offers Retry while the ticket is valid, and Remove. */
  linkUnfinished(node: NodeId): boolean {
    return this.unfinished.has(node)
  }
  accepted(node: NodeId): boolean {
    return !this.notAccepted.has(node)
  }
  /** Its last dial failed on a certificate outside its window: either computer's clock may be wrong. */
  certificateWindow(node: NodeId): boolean {
    return this.outsideWindow.has(node)
  }
  /** Its SSH login failed in a way only the owner can fix, and nothing logs in again until the owner acts. */
  sshParked(node: NodeId): NetEngineSshParked | undefined {
    return this.parked.get(node)
  }
  /** A dial of it failed so (the helper's event, or Add over SSH's first dial): no step dials it on its own. */
  park(node: NodeId, why: NetEngineSshParked): void {
    this.parked.set(node, why)
    this.port.changed()
  }
  /** The owner acted (Retry, an address, a key trusted): it may be dialled again. */
  unpark(node: NodeId): void {
    if (this.parked.delete(node)) this.port.changed()
  }

  // ---------------------------------------------------------------- host: invitation and approval

  /**
   * Show QR: a new invitation, and the link its code holds (with `name`, this computer's, for the question). Send
   * link (`kind: 'link'`, §5.1): a kind-2 invitation, its `mousse://pair#` link with no name (only the ticket is
   * checked), and the code this computer shows, to be read out another way.
   */
  async invite(
    name?: string,
    kind?: 'link',
    way?: NetEngineWay,
    access?: AccessPresetFields
  ): Promise<{
    invitation: string
    uri: string
    expiresAt?: number
    code?: string
    attemptsLeft?: number
    ways?: NetEngineWay[]
  }> {
    // A way is sent only to a helper that lists `invite-way`: the caller checked, and a code is never made without it.
    if (way && !this.helper().has('invite-way'))
      throw new NetError('bad_request', 'Update networking to pick a way.', {
        details: { reason: 'not_supported' }
      })
    // The role is fixed in the invitation (§8.1): for a link, at the level picked with it, since it has no Allow; in
    // person, at the default level until the Allow names its own.
    // A helper without roles makes an in-person invitation without one: its Allow refuses a level below Full control.
    const role =
      kind === 'link' || this.helper().has('grant-roles') ? this.roleOf(undefined, kind === 'link' ? access : undefined) : undefined
    const wayFields = { ...(way ? { way } : {}), ...(role ? { role } : {}) }
    const ways = (answer: Record<string, unknown>): { ways?: NetEngineWay[] } => {
      const listed = Array.isArray(answer.ways) ? answer.ways.filter(isNetEngineWay) : []
      return listed.length ? { ways: listed } : way ? { ways: [way] } : {}
    }
    if (kind === 'link') {
      const answer = await this.helper().request('invite.create', { kind: 'link', ...wayFields })
      const ticket = String(answer.uri)
      const shown: NetEngineLinkInvite = {
        invitation: String(answer.invitation),
        code: String(answer.code ?? ''),
        attemptsLeft: typeof answer.attempts_left === 'number' ? answer.attempts_left : 3,
        ...(typeof answer.expires_at === 'number' ? { expiresAt: answer.expires_at } : {})
      }
      // A Send link has no Allow: the level picked with it is saved now, under the id its row will take, before
      // anyone has the link, so the device is served under it from its first call.
      if (access && this.port.applyAccess)
        try {
          this.port.applyAccess(this.port.peers.pendingAccess(shown.invitation), access)
        } catch (error) {
          await this.helper()
            .request('invite.cancel', { invitation: shown.invitation })
            .catch(() => undefined)
          throw error
        }
      this.linkInvites.set(shown.invitation, shown)
      this.port.changed()
      return { ...shown, uri: sendLink(ticket.slice(ticket.lastIndexOf('#') + 1)), ...ways(answer) }
    }
    const answer =
      way || role
        ? await this.helper().request('invite.create', wayFields)
        : await this.helper().request('invite.create')
    const ticket = String(answer.uri)
    return {
      invitation: String(answer.invitation),
      uri: name ? pairingLink(ticket.slice(ticket.lastIndexOf('#') + 1), name) : ticket,
      ...(typeof answer.expires_at === 'number' ? { expiresAt: answer.expires_at } : {}),
      ...ways(answer)
    }
  }

  async cancelInvite(invitation: string): Promise<void> {
    this.linkInvites.delete(invitation)
    this.triesBefore.delete(invitation)
    await this.helper().request('invite.cancel', { invitation })
    for (const [request, approval] of this.approvals)
      if (approval.invitation === invitation) this.approvals.delete(request)
    this.port.changed()
  }

  /**
   * The host's window answers "Let <name> use this computer?". Yes saves the grant (the helper does). The access the
   * owner picked is saved first, under the id its row will take, so nothing is ever served to it under a wider one.
   */
  async approve(request: string, yes: boolean, access?: AccessPresetFields): Promise<void> {
    const approval = this.approvals.get(request)
    if (approval && yes) this.approvedNames.set(approval.invitation, approval.name)
    const known =
      approval?.identity && yes ? this.port.peers.byEndpoint(approval.identity) : undefined
    // The grant takes the role of the level picked (a computer known here keeps its own, unless Allow named one);
    // read before the level is saved, so a helper that cannot take it refuses with nothing changed.
    const role = yes ? this.roleOf(known?.localId, access) : undefined
    if (approval && yes && access && this.port.applyAccess) {
      const node = known?.localId ?? this.port.peers.pendingAccess(approval.invitation)
      try {
        this.port.applyAccess(node, access)
      } catch (error) {
        this.approvals.delete(request)
        await this.helper()
          .request('approval.answer', { request, yes: false })
          .catch(() => undefined)
        this.port.changed()
        throw error
      }
    }
    try {
      await this.helper().request('approval.answer', { request, yes, ...(role ? { role } : {}) })
    } finally {
      this.approvals.delete(request)
      this.port.changed()
    }
  }

  // ---------------------------------------------------------------- joiner: the ceremony

  /**
   * The joiner taps Connect: the consent journal is written first, then `join` (pinned), then the rest of the
   * ceremony runs. Resolves with the row once the host said yes and this computer recorded `joined`; the other
   * direction finishes on its own.
   */
  async join(link: string, options: JoinOptions = {}): Promise<EnginePeerRow> {
    const facts = readTicket(link)
    // A Send link, or any ticket that came by a link: the helper refuses a kind-1 ticket there, so the app does not
    // decide that first (§5.5).
    if (facts.kind === LINK_KIND || options.arrival === 'link') return this.joinLink(facts, options)
    // The helper and the journal take the ticket alone, without the link around it.
    const ticket = facts.fragment
    const helper = this.helper()
    const { peers } = this.port
    // Connect approves the ticket's destinations (§1.3); the ticked routes of this computer go in pairback.
    const approved = approvedHints(facts.routes)
    const back = options.back !== false
    const share = back ? (options.share ?? []) : []
    let row = peers.byEndpoint(facts.host)
    if (!row && !engineControl('no-consent-journal'))
      row = peers.add({
        endpoint: facts.host,
        fingerprint: fingerprintOf(facts.host),
        grant: '',
        name: facts.name ?? shortName(facts.host),
        state: 'consented',
        receipt: facts.invitation,
        invitation: facts.invitation,
        ticket,
        ...(approved.length ? { approved } : {}),
        ...(share.length ? { share } : {}),
        ...(back ? {} : { ways: 'out' as const, oneWay: true }),
        pairedAt: Date.now()
      })
    else if (row && isServingState(row.state))
      row = peers.update(row.localId, { approved, share, ...joinWays(row, back) })
    this.port.changed()
    this.at('consented')
    const joined = await helper
      .request('join', joinFields(helper, ticket, approved), engineLimits().joinDeadlineMs)
      .catch((error) => {
        throw isForgotten(error) ? removedWhileJoining() : error
      })
    return this.joined(row, facts, joined, share, back)
  }

  /** `join` answered: `joined` is written (the ticket goes), the join's connection attaches, the ceremony goes on. */
  private joined(
    row: EnginePeerRow | undefined,
    facts: { host: string; invitation: string },
    joined: Record<string, unknown>,
    share: string[] = [],
    back = true
  ): EnginePeerRow {
    this.at('join-replied')
    const identity = typeof joined.identity === 'string' ? joined.identity : facts.host
    const name = typeof joined.name === 'string' && joined.name ? joined.name : shortName(identity)
    const { peers } = this.port
    // The row this join wrote or found was removed while the join ran: the removal stands.
    const now = row && peers.get(row.localId)
    if (row && (!now || !isServingState(now.state))) throw removedWhileJoining()
    // A row of an earlier pairing with this host (it removed this computer, then let it in again) replays its
    // grant and its pairback too: the host's new row waits for them.
    const saved =
      row && now
        ? peers.update(row.localId, {
            state: 'joined',
            endpoint: identity,
            name,
            receipt: facts.invitation,
            invitation: facts.invitation,
            ticket: null
          })!
        : peers.add({
            endpoint: identity,
            fingerprint: fingerprintOf(identity),
            grant: '',
            name,
            state: 'joined',
            receipt: facts.invitation,
            invitation: facts.invitation,
            ...(share.length ? { share } : {}),
            ...(back ? {} : { ways: 'out' as const, oneWay: true }),
            pairedAt: Date.now()
          })
    this.helper().claim(identity)
    this.port.changed()
    void this.advance(saved.localId)
    return saved
  }

  /** Runs a pairing's next steps unless they run already; failures wait for the next connection or retry. */
  advance(node: NodeId): Promise<void> {
    const held = this.running.get(node)
    if (held) return held
    const run = this.steps(node)
      .catch((error) => {
        if (this.crashed || this.stopped) return
        if (isRefusal(error)) this.notAccepted.add(node)
        this.retryLater(node)
      })
      .finally(() => this.running.delete(node))
    this.running.set(node, run)
    return run
  }

  private async steps(node: NodeId): Promise<void> {
    const { peers } = this.port
    for (;;) {
      this.alive()
      const linked = this.linkRow(node)
      if (!linked) return
      if (linked.link?.pending) {
        await this.recoverLink(linked)
        if (peers.get(node)?.link?.pending) return
        continue
      }
      // A Send link's row is never joined from a pin (§5.4): only its own outcome moves it.
      if (linked.state === 'consented' && linked.link) return
      const found = peers.serving(node)
      if (!found || skipsCeremony(found)) return
      // The control lets 1a's ceremony take an SSH row as one of its own: B pinned and granted reads as granted.
      const row =
        found.source === 'ssh' && found.state === 'ssh_granted'
          ? { ...found, state: 'granted' as const }
          : found
      if (row.state === 'consented') {
        await this.rejoin(row)
        if (peers.get(node)?.state === 'consented') return
        continue
      }
      if (row.state === 'joined' && row.oneWay) {
        // One way: Connect let nothing back in, so no grant is made and no pairback is sent. A grant this computer
        // gave the host before stays: then it is both ways, as it was.
        this.at('joined')
        if (!peers.advance(node, ['joined'], { state: 'connected', oneWay: null, ways: row.grant === '' ? 'out' : null }))
          return
        this.notAccepted.delete(node)
        this.port.changed()
        await this.dial(row).catch(() => undefined)
        return
      }
      if (row.state === 'joined') {
        this.at('joined')
        const grant = await this.grantBack(row)
        this.alive()
        // A removal that started meanwhile waits for this step, then revokes the grant: nothing is written here.
        if (!peers.advance(node, ['joined'], { grant, state: 'granted' })) return
        this.port.changed()
        continue
      }
      if (row.state === 'granted') {
        this.at('granted')
        // A grant the host held here already comes back with its own role: the ceremony goes on only once that role
        // follows the row's level (pending on the row until then, and this step is tried again).
        if (this.port.followRole && !(await this.port.followRole(node)))
          throw new NetError('peer_offline', "Networking hasn't applied its access yet.", {
            details: { reason: 'role_pending' }
          })
        this.alive()
        await this.waitOnline(node, engineLimits().pairbackDeadlineMs, () => this.dial(row))
        this.alive()
        // Its LAN routes, and only the ticked ones of the rest (§1.3).
        const routes = pairbackRoutes(this.helper().info, row.share ?? [], this.port.leakedRoute?.())
        await this.port.sessions.client(node).pairback({
          routes,
          ...(row.receipt ? { receipt: row.receipt } : {})
        })
        this.alive()
        // Both ways now, whatever single direction the row had before.
        peers.advance(node, ['granted'], { state: 'connected', ways: null })
        this.notAccepted.delete(node)
        this.port.changed()
        return
      }
      return
    }
  }

  /** `joined`: the grant the host holds here (`grant.add`, idempotent; a save that failed is repeated once). */
  private async grantBack(row: EnginePeerRow): Promise<string> {
    const role = this.roleOf(row.localId)
    const fields = {
      identity: row.endpoint,
      name: row.name,
      ...(row.receipt ? { receipt: row.receipt } : {}),
      ...(role ? { role } : {})
    }
    let answer: Record<string, unknown>
    try {
      answer = await this.helper().request('grant.add', fields)
    } catch (error) {
      if (helperCode(error) !== 'store_failed') throw error
      answer = await this.helper().request('grant.add', fields)
    }
    if (typeof answer.grant !== 'number' && typeof answer.grant !== 'string')
      throw new NetError('internal', 'The helper named no grant.')
    return String(answer.grant)
  }

  /**
   * `consented` at a start (§5.1 recovery): the join is repeated with the stored ticket, pinned; a host that has
   * this computer's grant already answers at once. When the ticket no longer joins, a connection to the host as an
   * ordinary caller proves the grant too.
   */
  private async rejoin(row: EnginePeerRow): Promise<void> {
    if (!row.ticket) return
    const facts = readTicket(row.ticket)
    let joined: Record<string, unknown>
    try {
      joined = await this.helper().request(
        'join',
        joinFields(this.helper(), row.ticket, row.approved ?? []),
        engineLimits().joinDeadlineMs
      )
    } catch (error) {
      if (isRefusal(error)) {
        this.notAccepted.add(row.localId)
        throw error
      }
      // The host was removed here while the join ran: the removal stands, and nothing dials it.
      if (isForgotten(error)) throw removedWhileJoining()
      // The host may hold this computer's grant already: a dial it admits proves it.
      await this.helper().dial(row.endpoint)
      joined = { identity: row.endpoint, name: row.name }
    }
    this.alive()
    this.joined(this.port.peers.get(row.localId), facts, joined)
  }

  // ---------------------------------------------------------------- joiner: Send link (§5.3)

  /**
   * Connect on a Send link: the consent journal holds the link (its ticket hash, the approved destinations and the
   * routes to share) before `join` is sent. A computer this one knows another way (added over SSH) keeps its row as
   * it is, with the link beside it as pending. The join waits while the owner types the code; only a `PAIRED` for
   * this ticket moves the row on, so an "already paired" answer (existing access) grants nothing back (§3.6).
   */
  private async joinLink(facts: TicketFacts, options: JoinOptions): Promise<EnginePeerRow> {
    if (facts.expiresAt !== undefined && facts.expiresAt * 1000 <= Date.now())
      throw linkError('expired')
    this.helper()
    // Connect approves the ticket's destinations (§1.3), as for a scanned code.
    const link: EngineLink = {
      ticket: facts.fragment,
      ticketHash: facts.hash,
      invitation: facts.invitation,
      approved: approvedHints(facts.routes),
      share: options.back === false ? [] : [...new Set(options.share ?? [])],
      ...(facts.expiresAt !== undefined ? { expiresAt: facts.expiresAt } : {}),
      pending: true,
      ...(options.back === false ? { oneWay: true } : {})
    }
    if (this.linkJoins.has(facts.invitation))
      throw new NetError('bad_request', 'This link is being joined already.', {
        details: { reason: 'busy' }
      })
    const { peers } = this.port
    const known = this.linkRow(undefined, facts.host)
    const row = known
      ? peers.update(known.localId, { link })!
      : peers.add({
          endpoint: facts.host,
          fingerprint: fingerprintOf(facts.host),
          grant: '',
          name: shortName(facts.host),
          state: 'consented',
          receipt: facts.invitation,
          invitation: facts.invitation,
          ticket: facts.fragment,
          link,
          pairedAt: Date.now()
        })
    this.unfinished.delete(row.localId)
    this.port.changed()
    this.at('consented')
    return this.runLink(row.localId, link)
  }

  /** The join of a Send link, first or repeated (a restart, Retry): the stored lists go with it. */
  private async runLink(node: NodeId, link: EngineLink): Promise<EnginePeerRow> {
    const running: NetEngineLinkJoin = { invitation: link.invitation, node, needsCode: false }
    this.linkJoins.set(link.invitation, running)
    this.port.changed()
    let answer: Record<string, unknown>
    try {
      answer = await this.helper().request(
        'join',
        {
          ticket: link.ticket,
          arrival: 'link',
          approved: engineControl('link-approvals-lost') ? [] : link.approved,
          // Never for a Send link: a pin held before is no proof of this ticket (§5.4).
          ...(engineControl('link-pinned-journal') ? { pinned: true } : {})
        },
        engineLimits().joinDeadlineMs
      )
    } catch (error) {
      const code = helperCode(error)
      if (!this.crashed && !this.stopped) {
        if (code && LINK_ENDED.has(code)) this.dropLink(node)
        else if (this.port.peers.get(node)?.link?.pending) this.unfinished.add(node)
      }
      if (code && (LINK_ENDED.has(code) || code in LINK_TEXT)) throw linkError(code)
      throw error
    } finally {
      if (this.linkJoins.get(link.invitation) === running) this.linkJoins.delete(link.invitation)
      this.port.changed()
    }
    this.alive()
    // "Already paired": the host lets this computer in already (an SSH add, say). That is existing access, not
    // this ticket's pairing: no row moves and nothing is granted back (§3.6).
    if (answer.already === true && !engineControl('already-grants-back')) {
      this.dropLink(node)
      this.port.changed()
      throw linkError('already')
    }
    return this.linkPaired(node, link, answer)
  }

  /**
   * The helper reported this ticket's `PAIRED` (the join's answer, or `join.status`'s `done`): the row is `joined`
   * (a row added over SSH converts and keeps its addresses), the helper may drop its completion record, and 1a's
   * pairing goes on, with the link's `share` list for pairback.
   */
  private linkPaired(
    node: NodeId,
    link: EngineLink,
    paired: Record<string, unknown>
  ): EnginePeerRow {
    this.at('join-replied')
    const { peers } = this.port
    const now = peers.get(node)
    if (!now || now.state === 'removing' || now.state === 'removed')
      throw new NetError('cancelled', 'Removed while joining.')
    const identity = typeof paired.identity === 'string' ? paired.identity : now.endpoint
    const name = typeof paired.name === 'string' && paired.name ? paired.name : shortName(identity)
    // A row added over SSH converts here, keeping its addresses (§3.6); the link's lists become the row's, so a
    // repeated grant-back and pairback use them as 1a's do.
    const saved = peers.update(node, {
      state: 'joined',
      ...(engineControl('ssh-row-not-converted') ? {} : { source: null }),
      endpoint: identity,
      name,
      receipt: link.invitation,
      invitation: link.invitation,
      ticket: null,
      approved: link.approved,
      share: link.share,
      link: null,
      // One way only while nothing lets that computer in here already (a row added over SSH, say).
      ways: link.oneWay && now.grant === '' ? 'out' : now.ways === 'out' ? null : (now.ways ?? null),
      oneWay: link.oneWay ? true : null
    })!
    this.unfinished.delete(node)
    void this.helper()
      .request('join.ack', { ticket_hash: link.ticketHash })
      .catch(() => undefined)
    this.helper().claim(identity)
    this.port.changed()
    void this.advance(node)
    return saved
  }

  /**
   * A row with a pending Send link at a start (§5.4), by that ticket's hash only: `done` → `joined`; a pending
   * outcome → the join again with the stored lists; otherwise "Pairing didn't finish". A pin the helper holds
   * promotes nothing.
   */
  private async recoverLink(row: EnginePeerRow): Promise<void> {
    const link = row.link!
    if (this.linkJoins.has(link.invitation)) return
    let status: Record<string, unknown> = {}
    try {
      status = await this.helper().request('join.status', { ticket_hash: link.ticketHash })
    } catch (error) {
      // A helper that does not know `join.status` (1.0) has no outcome to give.
      if (helperCode(error) === undefined) throw error
    }
    this.alive()
    const done = status.done
    if (done && typeof done === 'object') {
      this.linkPaired(row.localId, link, done as Record<string, unknown>)
      return
    }
    if (engineControl('pin-promotes-kind2')) {
      const listed = await this.helper().request('peers.list')
      const held = (Array.isArray(listed.peers) ? listed.peers : []).some(
        (peer: { identity?: unknown } | null) => peer?.identity === row.endpoint
      )
      if (held) {
        this.linkPaired(row.localId, link, { identity: row.endpoint })
        return
      }
    }
    if (status.pending === true) {
      await this.runLink(row.localId, link).catch(() => undefined)
      return
    }
    const valid = link.expiresAt === undefined || link.expiresAt * 1000 > Date.now()
    // A row added another way keeps nothing of a link that can no longer finish.
    if (!valid && row.state !== 'consented') this.dropLink(row.localId)
    else this.unfinished.add(row.localId)
    this.port.changed()
  }

  /** Retry on "Pairing didn't finish": the join again with the stored lists, while the ticket is valid. */
  async retryLink(node: NodeId): Promise<EnginePeerRow> {
    const row = this.port.peers.get(node)
    if (!row?.link?.pending) throw new NetError('bad_request', 'Nothing to retry.')
    if (row.link.expiresAt !== undefined && row.link.expiresAt * 1000 <= Date.now())
      throw linkError('expired')
    this.unfinished.delete(node)
    return this.runLink(node, row.link)
  }

  /** The code the owner typed for a Send link join (`join.code`); a malformed one is no attempt. */
  async submitCode(invitation: string, code: string): Promise<void> {
    try {
      await this.helper().request('join.code', { invitation, code })
    } catch (error) {
      if (helperCode(error) === 'bad_code')
        throw new NetError('bad_request', 'Type the six digits.', {
          details: { reason: 'bad_code' }
        })
      throw error
    }
    const running = this.linkJoins.get(invitation)
    if (running) {
      running.needsCode = false
      running.wrong = false
      this.port.changed()
    }
  }

  /** The link's ending left nothing to pair: a row it made goes; a row there before keeps all but the link. */
  private dropLink(node: NodeId): void {
    const { peers } = this.port
    this.unfinished.delete(node)
    const row = peers.get(node)
    if (!row?.link) return
    if (row.state === 'consented' && row.grant === '') peers.forgetUnpaired(node)
    else peers.update(node, { link: null })
  }

  /** A row a Send link may use: one serving, or one added another way (over SSH) and not removed. */
  private linkRow(node?: NodeId, endpoint?: string): EnginePeerRow | undefined {
    const usable = (row: EnginePeerRow): boolean =>
      isServingState(row.state) ||
      (row.source === 'ssh' && row.state !== 'removing' && row.state !== 'removed')
    if (node !== undefined) {
      const row = this.port.peers.get(node)
      return row && usable(row) ? row : undefined
    }
    return this.port.peers.all().find((row) => row.endpoint === endpoint && usable(row))
  }

  // ---------------------------------------------------------------- host: the other direction

  /** `enrolled`: the host writes `awaiting_pairback` for the computer it just let in (§5.1 step 3). */
  private enrolled(event: Record<string, unknown>): void {
    const identity = typeof event.identity === 'string' ? event.identity : undefined
    const grant =
      typeof event.grant === 'number' || typeof event.grant === 'string'
        ? String(event.grant)
        : undefined
    if (!identity || grant === undefined) return
    const invitation = typeof event.invitation === 'string' ? event.invitation : undefined
    this.at('enrolled')
    const name =
      (invitation && this.approvedNames.get(invitation)) ||
      (typeof event.name === 'string' && event.name) ||
      shortName(identity)
    if (invitation) this.approvedNames.delete(invitation)
    const shown = invitation ? this.linkInvites.get(invitation) : undefined
    const { peers } = this.port
    // A computer added over SSH that joined this one's Send link: its row converts now, at enrollment only (§3.6).
    const added = peers
      .all()
      .find(
        (row) =>
          row.endpoint === identity &&
          row.source === 'ssh' &&
          row.state !== 'removing' &&
          row.state !== 'removed'
      )
    if (added && !peers.holdsGrant(grant)) {
      // It uses this computer now. This computer added it over SSH (it keeps the route), so it uses that one too:
      // both ways. Added the other way round, only this one; a pairback, if it sends one, adds the other direction.
      // It takes the level picked with the link, as a device new here would.
      const reserved = peers.reserved(invitation)
      if (reserved) this.port.copyAccess?.(reserved, added.localId)
      peers.updateReleasing(
        added.localId,
        {
          grant,
          state: 'connected',
          ways: added.ssh?.routeId ? null : 'in',
          source: null,
          ...(invitation ? { receipt: invitation, invitation } : {})
        },
        reserved ? invitation : undefined
      )
      this.helper().claim(identity)
      void this.port.followRole?.(added.localId)
      this.port.changed()
    } else this.owe(identity, grant, name, invitation)
    if (shown) {
      const node = peers.byEndpoint(identity)?.localId
      if (node) shown.node = node
      // Used: the right code's try comes back, and no next code is shown.
      shown.attemptsLeft = this.triesBefore.get(shown.invitation) ?? shown.attemptsLeft
      shown.code = ''
      this.port.changed()
    }
  }

  /**
   * A row for a grant no row has (idempotent); its connections attach now. The other computer uses this one from
   * here on (`connected`, one way in); a pairback, if it sends one, adds the other direction.
   */
  private owe(identity: string, grant: string, name: string, receipt?: string): void {
    const { peers } = this.port
    if (peers.holdsGrant(grant)) return
    const existing = peers.byEndpoint(identity)
    // This computer joined that one (its row runs its own ceremony), or holds an older pairing with it.
    if (existing) {
      const letIn = existing.state === 'awaiting_pairback' || existing.state === 'connected'
      // The level the owner picked for this invitation, before the grant serves it (again on a repeat).
      const reserved = peers.reserved(receipt)
      if (letIn && reserved) this.port.copyAccess?.(reserved, existing.localId)
      peers.updateReleasing(
        existing.localId,
        letIn
          ? {
              grant,
              // A computer this one only used now uses this one too.
              ...(existing.ways === 'out' ? { ways: null } : {})
            }
          : {},
        reserved ? receipt : undefined
      )
      if (letIn) void this.port.followRole?.(existing.localId)
      return
    }
    // The row takes the id reserved with the owner's level in the same write: a stop before it leaves the
    // reservation for the next start's reconciliation.
    const row = peers.add(
      {
        endpoint: identity,
        fingerprint: fingerprintOf(identity),
        grant,
        name,
        state: 'connected',
        ways: 'in',
        ...(receipt ? { receipt, invitation: receipt } : {}),
        pairedAt: Date.now()
      },
      receipt
    )
    this.helper().claim(identity)
    void this.port.followRole?.(row.localId)
    this.port.changed()
  }

  /**
   * The role a grant made now takes, when the helper takes roles (`grant-roles`). A helper without them makes every
   * grant `owner`: it lets a device in at Full control only, and below that this refuses.
   */
  private roleOf(node: NodeId | undefined, access?: AccessPresetFields): string | undefined {
    const role = this.port.grantRole?.(node, access)
    if (this.helper().has('grant-roles')) return role
    if (role !== undefined && role !== OWNER_ROLE)
      throw new NetError('bad_request', 'Update networking to let it in below Full control.', {
        details: { reason: 'role_unsupported' }
      })
    return undefined
  }

  /**
   * Rows the host owes (§5.1 recovery: the app stopped between `enrolled` and its write): every live grant with no
   * row gets one, whatever its role (a device let in below Full control holds one that is not `owner`).
   */
  async reconcileGrants(): Promise<void> {
    const answer = await this.helper().request('grants.list')
    this.alive()
    const now = Date.now() / 1000
    for (const grant of Array.isArray(answer.grants) ? answer.grants : []) {
      if (!grant || typeof grant.identity !== 'string') continue
      // A grant an SSH add made belongs to its request, never to an owed row; a removed request's goes.
      const request = typeof grant.receipt === 'string' ? this.port.sshRequest?.(grant.receipt) : undefined
      if (request === 'removed' && !engineControl('removal-skips-unsaved-grant'))
        await this.helper().request('grant.remove', { grant: grant.grant }).catch(() => undefined)
      if (request) continue
      // Nor is one whose request this computer no longer keeps while its SSH row still waits: the row settles it.
      if (
        typeof grant.receipt === 'string' &&
        this.port.peers
          .all()
          .some((row) => row.source === 'ssh' && row.ssh?.requestId === grant.receipt)
      )
        continue
      if (typeof grant.expires_at === 'number' && grant.expires_at <= now) continue
      this.owe(
        grant.identity,
        String(grant.grant),
        typeof grant.name === 'string' && grant.name ? grant.name : shortName(grant.identity),
        typeof grant.receipt === 'string' ? grant.receipt : undefined
      )
    }
  }

  /**
   * `pairback` from the joiner (§5.1 step 5): the caller holds the grant this computer made (the session checked
   * it); its addresses in private ranges are recorded (the helper refuses others), this computer dials back, and
   * its own hello answering marks the pairing `connected`.
   */
  async pairback(caller: EngineCaller, request: { routes: string[] }): Promise<void> {
    const { peers } = this.port
    const row = peers.serving(caller.node)
    if (!row) throw new NetError('forbidden')
    // A row only let in has no client of its own: the pairback is the other computer letting this one in too.
    if (row.state === 'connected' && row.ways !== 'in' && this.port.sessions.online(row.localId)) return
    // An app without one-way pairing sends pairback whatever its owner chose: it is answered (nothing waits on it),
    // and this computer uses it only once its own owner adds it from here.
    if (row.ways === 'in' && this.callerSays(row.localId, 'one-way') !== true) return
    this.at('pairback')
    // LAN routes are dialled at once; the others wait on the row until the owner taps Use (§1.3).
    const split = splitPairback(request.routes)
    if (!split)
      throw new NetError('bad_request', 'Those addresses cannot be dialled.', {
        details: { reason: 'bad_route' }
      })
    const add = (routes: string[]) =>
      this.helper().request('peer.add', { identity: row.endpoint, name: row.name, routes })
    try {
      try {
        await add(split.automatic)
      } catch (error) {
        // A 1.0 helper refuses the whole list for one address outside a private range (loopback, say): the
        // private ones are kept.
        const usable = split.automatic.filter(privateRoute)
        if (helperCode(error) !== 'bad_route' || usable.length === split.automatic.length)
          throw error
        await add(usable)
      }
    } catch (error) {
      if (helperCode(error) === 'bad_route')
        throw new NetError('bad_request', 'Those addresses are not on a private network.', {
          details: { reason: 'bad_route' }
        })
      throw error
    }
    await this.offer(row, split.offered)
    // Both ways from here: the helper holds its peer record now, so this computer may dial it.
    if (row.ways === 'in') {
      peers.advance(row.localId, ['connected'], { ways: null })
      this.port.changed()
    }
    await this.waitOnline(row.localId, engineLimits().pairbackDeadlineMs, () => this.dial(row))
    this.alive()
    peers.advance(row.localId, ['awaiting_pairback'], { state: 'connected' })
    this.port.changed()
  }

  /**
   * The routes a pairback offered outside the automatic rule, kept on the row as "Addresses <B> offered" (those it
   * dials already are left out). Under the `route-leak` control they are used at once, first, without the owner.
   */
  private async offer(row: EnginePeerRow, offered: string[]): Promise<void> {
    const { peers } = this.port
    const known = row.addresses ?? []
    const fresh = offered.filter((route) => !known.includes(route))
    // A tailnet address is inside the owner's own tailnet: it is used at once, as a LAN one is, so a computer that
    // paired over Tailscale is reached back over Tailscale without a Use. Internet addresses and tunnels still wait,
    // and so does every address on a 1.0 helper, which takes owner addresses in private ranges only.
    const leak = engineControl('route-leak')
    let now = leak ? fresh : this.helper().speaks(1) ? fresh.filter(tailnetRoute) : []
    let waiting = fresh.filter((route) => !now.includes(route))
    if (now.length) {
      const addresses = [...now, ...known]
      try {
        await this.helper().request('peer.addresses.set', { identity: row.endpoint, routes: addresses })
        peers.setAddresses(row.localId, addresses)
      } catch (error) {
        if (leak) throw error
        // A helper that refuses them: they wait for Use like the others, and the pairback goes on.
        waiting = fresh
        now = []
      }
    }
    if (leak && now.length) return
    if (!waiting.length && !row.offered?.length) {
      if (now.length) this.port.changed()
      return
    }
    peers.update(row.localId, { offered: waiting })
    this.port.changed()
  }

  /**
   * The other computer said its name in `hello` (§5.1): a row still under its placeholder name (a Send link
   * enrolls with no approval, so no name) takes it. A name the row already has stays.
   */
  named(node: NodeId, said: string): void {
    const row = this.port.peers.serving(node)
    // Printable text only, trimmed and bounded as a link's name is.
    const name = said.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)
    if (!row || !name || row.name !== shortName(row.endpoint)) return
    this.port.peers.update(node, { name })
    this.port.changed()
  }

  /** The session features the other computer's app said in its last `hello` here (as a caller). */
  heard(node: NodeId, features: readonly string[]): void {
    this.callerFeatures.set(node, [...features])
    this.port.changed()
  }

  /** Whether the app that calls this computer as `node` said `feature`; undefined before its hello this run. */
  callerSays(node: NodeId, feature: string): boolean | undefined {
    return this.callerFeatures.get(node)?.includes(feature)
  }

  // ---------------------------------------------------------------- connections and recovery

  /** A client of a pairing is ready: waiters wake, and a pairing that owes its pairback sends it now. */
  clientReady(node: NodeId): void {
    this.notAccepted.delete(node)
    this.outsideWindow.delete(node)
    this.parked.delete(node)
    for (const wake of [...this.waiters]) wake()
    const row = this.port.peers.serving(node)
    if (
      row &&
      !skipsCeremony(row) &&
      (row.state === 'granted' ||
        row.state === 'joined' ||
        (row.source === 'ssh' && row.state === 'ssh_granted'))
    )
      void this.advance(node)
  }

  /**
   * After each helper `hello` (a start, or a helper started again): removals finish, each unfinished ceremony
   * resumes, the host's owed rows are written, and every pairing with an address is dialled again.
   */
  async recover(): Promise<void> {
    const { peers } = this.port
    for (const row of peers.inState('removing'))
      await this.finishRemovalLocked(row).catch(() => undefined)
    // A direction the owner removed stays removed: its grant goes before any owed row could take it back.
    for (const row of peers.all())
      if (row.revoking) await this.finishRevoke(row).catch(() => undefined)
    const reconciled = await this.reconcileGrants().then(
      () => true,
      () => false
    )
    // Invitations end with the helper run that made them: once every owed row is written, no reserved id is waiting
    // for one. While a row may still be owed, its reserved id and level stay for the next try.
    if (reconciled)
      try {
        peers.clearPendingAccess()
      } catch {
        // Cleared at the next start.
      }
    for (const row of peers.all()) {
      if (this.crashed || this.stopped) return
      if (
        row.state === 'consented' ||
        row.state === 'joined' ||
        row.state === 'granted' ||
        row.link?.pending
      )
        void this.advance(row.localId)
      if (
        (row.state === 'joined' ||
          row.state === 'granted' ||
          row.state === 'connected' ||
          row.state === 'ssh_granted') &&
        row.ways !== 'in' &&
        !this.parked.has(row.localId)
      )
        void this.dial(row).catch(() => undefined)
    }
  }

  /** A pairing step failed: it is tried again after `pairingRetryMs`, while this run lasts. */
  private retryLater(node: NodeId): void {
    if (this.retries.has(node) || this.stopped || this.crashed) return
    const timer = setTimeout(() => {
      this.retries.delete(node)
      // A parked SSH login waits for the owner's Retry: a step that would dial it again does not run.
      if (!this.stopped && !this.crashed && !this.parked.has(node)) void this.advance(node)
    }, engineLimits().pairingRetryMs)
    timer.unref?.()
    this.retries.set(node, timer)
  }

  /** The helper's events this module answers. */
  event(event: Record<string, unknown>): void {
    try {
      switch (event.ev) {
        case 'approval': {
          if (typeof event.request !== 'string' && typeof event.request !== 'number') return
          const request = String(event.request)
          this.approvals.set(request, {
            request,
            invitation: String(event.invitation ?? ''),
            name: typeof event.name === 'string' ? event.name : '',
            device: typeof event.device === 'string' ? event.device : '',
            ...(typeof event.identity === 'string' ? { identity: event.identity } : {})
          })
          this.port.changed()
          return
        }
        case 'enrolled':
          this.enrolled(event)
          return
        case 'invite.ended': {
          for (const [request, approval] of this.approvals)
            if (approval.invitation === event.invitation) this.approvals.delete(request)
          const shown = this.linkInvites.get(String(event.invitation))
          if (shown) shown.ended = String(event.reason ?? 'ended')
          this.port.changed()
          return
        }
        case 'invite.code': {
          const shown = this.linkInvites.get(String(event.invitation))
          if (!shown) return
          if (typeof event.code === 'string') shown.code = event.code
          if (typeof event.attempts_left === 'number') {
            this.triesBefore.set(shown.invitation, shown.attemptsLeft)
            shown.attemptsLeft = event.attempts_left
          }
          this.port.changed()
          return
        }
        case 'join.code_needed':
        case 'join.attempt_failed': {
          const running = this.linkJoins.get(String(event.invitation))
          if (!running) return
          running.needsCode = true
          if (typeof event.attempts_left === 'number') running.attemptsLeft = event.attempts_left
          running.wrong = event.ev === 'join.attempt_failed'
          this.port.changed()
          return
        }
        case 'grant.closed': {
          // A grant this computer issued is gone (its removal saved): whatever the pairing runs here ends.
          const grant = String(event.grant)
          for (const row of this.port.peers.all())
            if (row.grant === grant) this.port.teardown(row.localId)
          return
        }
        case 'dial.failed':
        case 'conn.down': {
          // A failed dial names its code in `why` (`reason` is its text); a closed connection in `reason`.
          const reason = String((event.ev === 'dial.failed' ? event.why : event.reason) ?? '')
          const row =
            typeof event.identity === 'string'
              ? this.port.peers.byEndpoint(event.identity)
              : undefined
          if (!row) return
          // An SSH login only the owner can fix: the helper stops (`retry_ms` null), and so does this computer.
          if (event.ev === 'dial.failed' && event.retry_ms === null && isSshParked(reason)) {
            this.park(row.localId, reason)
            return
          }
          if (
            reason === 'peer_certificate' &&
            /validity|window/i.test(String(event.reason ?? ''))
          ) {
            this.outsideWindow.add(row.localId)
            this.port.changed()
          }
          if (reason !== 'not_authorized' && reason !== 'grant_revoked') return
          this.notAccepted.add(row.localId)
          this.port.changed()
          return
        }
      }
    } catch {
      // A crash point a test set, or a write that failed: the next start or connection recovers it.
    }
  }

  // ---------------------------------------------------------------- removal

  /**
   * Remove (§5.4): the row is `removing` first (from then on nothing is served to it), the pairing's work ends,
   * the helper removes the grant (journaled) and forgets the peer, and one transaction prunes the rows it left and
   * makes the row a tombstone. Resolves once that committed; a failure leaves the row `removing`, still refused.
   */
  async remove(node: NodeId): Promise<void> {
    const { peers } = this.port
    const row = peers.get(node)
    if (!row) throw new NetError('bad_request', 'Unknown device.')
    if (row.state === 'removed') return
    const under = this.removals.get(node)
    if (under) return under
    const run = this.removing(node).finally(() => this.removals.delete(node))
    this.removals.set(node, run)
    return run
  }

  /**
   * Remove on one of a pairing's two rows: only that direction ends. `in` (it uses this computer) revokes the grant
   * here and keeps the peer record; `out` (this computer uses it) forgets the peer record and keeps the grant. A
   * pairing with only that direction, or one added over SSH, is removed whole.
   */
  async removeDirection(node: NodeId, direction: EngineWays): Promise<void> {
    const { peers } = this.port
    const row = peers.get(node)
    if (!row) throw new NetError('bad_request', 'Unknown device.')
    if (row.state === 'removed' || row.state === 'removing') return this.remove(node)
    const both = row.state === 'connected' && !row.ways && row.grant !== '' && !row.source
    if (!both) return this.remove(node)
    const under = this.removals.get(node) ?? this.running.get(node)
    if (under) await under.catch(() => undefined)
    const run = (direction === 'in' ? this.endIn(row) : this.endOut(row)).finally(() =>
      this.removals.delete(node)
    )
    this.removals.set(node, run)
    return run
  }

  /** It no longer uses this computer: serving stops first, then the helper drops the grant (`grant.revoke_local`). */
  private async endIn(row: EnginePeerRow): Promise<void> {
    const helper = this.helper()
    if (!helper.has('grant-revoke-local'))
      throw new NetError('bad_request', 'Update networking to remove one direction.', {
        details: { reason: 'not_supported' }
      })
    const { peers } = this.port
    const node = row.localId
    const grant = row.grant
    // From here nothing is served to it: no row holds the grant, and the row keeps it as revoking until the helper
    // has dropped it, so a stop in between finishes the removal at the next start.
    if (!peers.advance(node, ['connected'], { grant: '', ways: 'out', revoking: grant })) return
    this.port.endServing?.(node)
    this.port.changed()
    this.at('revoking')
    try {
      await helper.request('grant.revoke_local', { grant: Number(grant) })
    } catch (error) {
      // Still let in: the row says so again.
      if (helperCode(error) !== 'not_found') {
        peers.advance(node, ['connected'], { grant, ways: null, revoking: null })
        this.port.changed()
        throw new NetError('peer_offline', "Couldn't remove; try again.", {
          details: { reason: helperCode(error) ?? 'helper' }
        })
      }
    }
    peers.update(node, { revoking: null })
    this.port.changed()
  }

  /** A removed direction whose grant the helper may still hold (the app stopped in between): it goes now. */
  private async finishRevoke(row: EnginePeerRow): Promise<void> {
    const grant = row.revoking!
    try {
      await this.helper().request('grant.revoke_local', { grant: Number(grant) })
    } catch (error) {
      if (helperCode(error) !== 'not_found') throw error
    }
    this.alive()
    this.port.peers.update(row.localId, { revoking: null })
    this.port.changed()
  }

  /** This computer no longer uses it: the helper forgets its peer record; it may still use this computer. */
  private async endOut(row: EnginePeerRow): Promise<void> {
    const helper = this.helper()
    const { peers } = this.port
    const node = row.localId
    await helper.request('peer.forget', { identity: row.endpoint }).catch((error) => {
      throw new NetError('peer_offline', "Couldn't remove; try again.", {
        details: { reason: helperCode(error) ?? 'helper' }
      })
    })
    peers.advance(node, ['connected'], {
      ways: 'in',
      stoppedUsing: true,
      offered: null,
      approved: null,
      share: null,
      link: null
    })
    peers.setAddresses(node, [])
    helper.dropCallBack(row.endpoint)
    this.port.sessions.closeClients(node, 'peer_forgotten')
    this.notAccepted.delete(node)
    this.outsideWindow.delete(node)
    this.parked.delete(node)
    this.port.changed()
  }

  private async removing(node: NodeId): Promise<void> {
    const { peers } = this.port
    peers.advance(node, SERVING, { state: 'removing' })
    this.notAccepted.delete(node)
    this.parked.delete(node)
    this.port.changed()
    if (!engineControl('teardown-on-event-only')) this.port.teardown(node)
    // A step that waits for a connection stops now; one waiting on the helper (`grant.add`, say) ends first, so
    // the grant it made is there to revoke and it writes nothing after.
    for (const wake of [...this.waiters]) wake()
    this.at('removing')
    await this.running.get(node)?.catch(() => undefined)
    // A prepare of that computer running now ends first (it sees the row `removing` and records nothing more); its
    // grant is then there to remove.
    await this.finishRemovalLocked(peers.get(node)!)
  }

  /** Steps 2 and 3 under the lock the SSH prepares of that computer take (§3.6). */
  private finishRemovalLocked(row: EnginePeerRow): Promise<void> {
    const finish = () => this.finishRemoval(this.port.peers.get(row.localId) ?? row)
    return this.port.exclusive && row.endpoint
      ? this.port.exclusive(row.endpoint, finish)
      : finish()
  }

  /** Steps 2 and 3 of a removal; a replay that finds the grant or the peer gone already carries on. */
  private async finishRemoval(row: EnginePeerRow): Promise<void> {
    if (row.state !== 'removing') return
    if (!engineControl('teardown-on-event-only')) this.port.teardown(row.localId)
    const helper = this.port.helper()
    if (!helper) throw new NetError('peer_offline', "Couldn't remove; try again.")
    if (row.invitation && row.state === 'removing' && row.ticket)
      await helper.request('join.cancel', { invitation: row.invitation }).catch(() => undefined)
    if (row.link?.pending)
      await helper
        .request('join.cancel', { invitation: row.link.invitation })
        .catch(() => undefined)
    this.unfinished.delete(row.localId)
    try {
      // The row's grant, and any other this computer made for that endpoint (a `grant.add` whose answer the
      // removal overtook): none may outlive the removal and bring the pairing back.
      const grants = new Set<number>()
      for (const held of [row.grant, row.revoking ?? ''])
        if (held !== '' && Number.isSafeInteger(Number(held))) grants.add(Number(held))
      // The control removes only a grant the row holds: one an SSH add saved before its id was stored stays.
      const unsavedStays =
        row.source === 'ssh' && row.grant === '' && engineControl('removal-skips-unsaved-grant')
      const listed = unsavedStays ? { grants: [] } : await helper.request('grants.list')
      for (const grant of Array.isArray(listed.grants) ? listed.grants : [])
        if (grant && grant.identity === row.endpoint && Number.isSafeInteger(Number(grant.grant)))
          grants.add(Number(grant.grant))
      for (const grant of grants) await helper.request('grant.remove', { grant })
    } catch (error) {
      throw new NetError('peer_offline', "Couldn't remove; try again.", {
        details: { reason: helperCode(error) ?? 'helper' }
      })
    }
    this.at('grant-removed')
    // An SSH add B never answered knows B only by its request (`ssh:<id>`): the helper holds no peer for it.
    if (row.endpoint && !row.endpoint.startsWith('ssh:'))
      await helper.request('peer.forget', { identity: row.endpoint })
    // A: the SSH route it kept for the other computer goes too (its config and pin).
    if (row.ssh?.routeId)
      await helper.request('ssh.forget', { route_id: row.ssh.routeId }).catch(() => undefined)
    await this.port.removed?.(row)
    this.alive()
    this.port.peers.prune(row.localId)
    this.port.changed()
  }

  // ---------------------------------------------------------------- helpers

  private helper(): EngineHelper {
    const helper = this.port.helper()
    if (!helper) throw new NetError('peer_offline', 'Networking is starting.')
    return helper
  }

  private async dial(row: EnginePeerRow): Promise<void> {
    if (this.port.sessions.online(row.localId)) return
    await this.helper().dial(row.endpoint)
  }

  /** Waits until a client of `node` is ready, at most `ms`, asking `connect` now and after each retry wait. */
  private async waitOnline(node: NodeId, ms: number, connect: () => Promise<void>): Promise<void> {
    const until = Date.now() + ms
    while (!this.port.sessions.online(node)) {
      this.alive()
      if (!this.port.peers.serving(node)) throw new NetError('cancelled', 'Removed.')
      const left = until - Date.now()
      if (left <= 0) throw new NetError('peer_offline')
      let wake = (): void => undefined
      const woken = new Promise<void>((resolve) => (wake = resolve))
      const check = (): void => {
        if (this.port.sessions.online(node) || this.stopped || !this.port.peers.serving(node)) wake()
      }
      this.waiters.add(check)
      // A connection the other side refused (it had no row yet) is asked for again after a while.
      const timer = setTimeout(wake, Math.min(left, engineLimits().pairingRetryMs))
      try {
        await connect().catch(() => undefined)
        check()
        await woken
      } finally {
        clearTimeout(timer)
        this.waiters.delete(check)
      }
    }
  }

  /** A crash point of a step run outside the ceremony (asking for the other direction); throws once stopped. */
  checkpoint(step: PairingStep): void {
    this.at(step)
  }

  /** A test's crash point: from here this run writes nothing more. */
  private at(step: PairingStep): void {
    this.alive()
    if (this.port.crashAt?.(step)) {
      this.crashed = true
      throw new NetError('cancelled', `Stopped at ${step} for a test.`)
    }
  }
  private alive(): void {
    if (this.crashed || this.stopped) throw new NetError('cancelled')
  }
}

const SERVING = [
  'consented',
  'joined',
  'granted',
  'awaiting_pairback',
  'connected',
  'ssh_requested',
  'ssh_granting',
  'ssh_granted'
] as const

/** A Send link join that ended, as the joiner's dialog says it; `already` is existing access (§3.6). */
function linkError(reason: string): NetError {
  return new NetError('bad_request', LINK_TEXT[reason] ?? LINK_NOT_USED, {
    details: { reason: reason === 'already' ? 'link_not_used' : reason }
  })
}

/**
 * The helper's join answer when this computer removed the host while the join ran (`peer.forget` won): it stored
 * nothing, or what it stored went with the removal.
 */
const isForgotten = (error: unknown): boolean => helperCode(error) === 'forgotten'

const removedWhileJoining = (): NetError => new NetError('cancelled', 'Removed while joining.')

/**
 * A row this computer had with the host before Connect: one it only used turns both ways when "Also let" is ticked;
 * one that lets the host in already stays so (Connect never takes access away). Joining it is this owner adding the
 * use of it again, which a removal of that use no longer holds back.
 */
function joinWays(
  row: EnginePeerRow,
  back: boolean
): { ways?: EnginePeerRow['ways'] | null; oneWay: true | null; stoppedUsing: null } {
  if (back) return { oneWay: null, stoppedUsing: null, ...(row.ways === 'out' ? { ways: null } : {}) }
  return { oneWay: true, stoppedUsing: null, ...(!row.ways && row.grant === '' ? { ways: 'out' as const } : {}) }
}

/** The other computer refuses this one (it removed it, or never let it in). */
function isRefusal(error: unknown): boolean {
  const code = helperCode(error)
  return code === 'not_authorized' || code === 'grant_revoked' || code === 'pairing_declined'
}

/**
 * A join's fields (§1.3): the ticket, pinned, and to a 1.1 helper the hints Connect approved. A 1.0 helper dials
 * the private ones only and takes no `approved`.
 */
function joinFields(
  helper: EngineHelper,
  ticket: string,
  approved: readonly string[]
): Record<string, unknown> {
  return {
    ticket,
    pinned: true,
    ...(helper.speaks(1) && approved.length ? { approved: [...approved] } : {})
  }
}
