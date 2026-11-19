import { createHash } from 'node:crypto'
import { NetError } from '../../shared/net/errors'
import type { NodeId } from '../../shared/net'
import type { NetEngineApproval } from '../../shared/netEngine/local'
import type { EngineCaller } from '../net/contracts'
import { helperCode } from './helper/appChannel'
import type { EngineHelper } from './helper/connections'
import { engineControl, engineLimits } from './limits'
import { privateRoute } from './routes'
import type { EngineSessions } from './sessions'
import { isServingState, type EnginePeerRow, type EnginePeerStore } from './store'
import { pairingLink, readTicket } from './ticket'

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

export interface PairingPort {
  peers: EnginePeerStore
  sessions: EngineSessions
  helper(): EngineHelper | undefined
  /** Ends a pairing's Bridge work (§3.7); idempotent. */
  teardown(node: NodeId): void
  changed(): void
  /** A test stops this computer at `step` when this answers true. */
  crashAt?(step: PairingStep): boolean
}

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
  /** The step a pairing is running, so one runs at a time per pairing. */
  private readonly running = new Map<NodeId, Promise<void>>()
  /** Removals under way, so one runs at a time per pairing and a second Remove joins it. */
  private readonly removals = new Map<NodeId, Promise<void>>()
  private readonly waiters = new Set<() => void>()
  private readonly retries = new Map<NodeId, ReturnType<typeof setTimeout>>()
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
  accepted(node: NodeId): boolean {
    return !this.notAccepted.has(node)
  }
  /** Its last dial failed on a certificate outside its window: either computer's clock may be wrong. */
  certificateWindow(node: NodeId): boolean {
    return this.outsideWindow.has(node)
  }

  // ---------------------------------------------------------------- host: invitation and approval

  /** Show QR: a new invitation, and the link its code holds (with `name`, this computer's, for the question). */
  async invite(name?: string): Promise<{ invitation: string; uri: string; expiresAt?: number }> {
    const answer = await this.helper().request('invite.create')
    const ticket = String(answer.uri)
    return {
      invitation: String(answer.invitation),
      uri: name ? pairingLink(ticket.slice(ticket.lastIndexOf('#') + 1), name) : ticket,
      ...(typeof answer.expires_at === 'number' ? { expiresAt: answer.expires_at } : {})
    }
  }

  async cancelInvite(invitation: string): Promise<void> {
    await this.helper().request('invite.cancel', { invitation })
    for (const [request, approval] of this.approvals)
      if (approval.invitation === invitation) this.approvals.delete(request)
    this.port.changed()
  }

  /** The host's window answers "Is <computer> next to you?". Yes saves the grant (the helper does). */
  async approve(request: string, yes: boolean): Promise<void> {
    const approval = this.approvals.get(request)
    if (approval && yes) this.approvedNames.set(approval.invitation, approval.name)
    try {
      await this.helper().request('approval.answer', { request, yes })
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
  async join(link: string): Promise<EnginePeerRow> {
    const facts = readTicket(link)
    // The helper and the journal take the ticket alone, without the link around it.
    const ticket = link.trim().slice(link.trim().lastIndexOf('#') + 1)
    const helper = this.helper()
    const { peers } = this.port
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
        pairedAt: Date.now()
      })
    this.port.changed()
    this.at('consented')
    const joined = await helper.request(
      'join',
      { ticket, pinned: true },
      engineLimits().joinDeadlineMs
    )
    return this.joined(row, facts, joined)
  }

  /** `join` answered: `joined` is written (the ticket goes), the join's connection attaches, the ceremony goes on. */
  private joined(
    row: EnginePeerRow | undefined,
    facts: { host: string; invitation: string },
    joined: Record<string, unknown>
  ): EnginePeerRow {
    this.at('join-replied')
    const identity = typeof joined.identity === 'string' ? joined.identity : facts.host
    const name = typeof joined.name === 'string' && joined.name ? joined.name : shortName(identity)
    const { peers } = this.port
    // The row this join wrote or found was removed while the join ran: the removal stands.
    const now = row && peers.get(row.localId)
    if (row && (!now || !isServingState(now.state)))
      throw new NetError('cancelled', 'Removed while joining.')
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
      const row = peers.serving(node)
      if (!row) return
      if (row.state === 'consented') {
        await this.rejoin(row)
        if (peers.get(node)?.state === 'consented') return
        continue
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
        await this.waitOnline(node, engineLimits().pairbackDeadlineMs, () => this.dial(row))
        this.alive()
        const helper = this.helper()
        const routes = Array.isArray(helper.info.routes)
          ? helper.info.routes.filter(
              (route: unknown): route is string => typeof route === 'string'
            )
          : []
        await this.port.sessions.client(node).pairback({
          routes,
          ...(row.receipt ? { receipt: row.receipt } : {})
        })
        this.alive()
        peers.advance(node, ['granted'], { state: 'connected' })
        this.notAccepted.delete(node)
        this.port.changed()
        return
      }
      return
    }
  }

  /** `joined`: the grant the host holds here (`grant.add`, idempotent; a save that failed is repeated once). */
  private async grantBack(row: EnginePeerRow): Promise<string> {
    const fields = {
      identity: row.endpoint,
      name: row.name,
      ...(row.receipt ? { receipt: row.receipt } : {})
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
        { ticket: row.ticket, pinned: true },
        engineLimits().joinDeadlineMs
      )
    } catch (error) {
      if (isRefusal(error)) {
        this.notAccepted.add(row.localId)
        throw error
      }
      // The host may hold this computer's grant already: a dial it admits proves it.
      await this.helper().dial(row.endpoint)
      joined = { identity: row.endpoint, name: row.name }
    }
    this.alive()
    this.joined(this.port.peers.get(row.localId), facts, joined)
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
    this.owe(identity, grant, name, invitation)
  }

  /** A row in `awaiting_pairback` for a grant no row has (idempotent); its connections attach now. */
  private owe(identity: string, grant: string, name: string, receipt?: string): void {
    const { peers } = this.port
    if (peers.holdsGrant(grant)) return
    const existing = peers.byEndpoint(identity)
    // This computer joined that one (its row runs its own ceremony), or holds an older pairing with it.
    if (existing) {
      if (existing.state === 'awaiting_pairback' || existing.state === 'connected')
        peers.update(existing.localId, { grant })
      return
    }
    peers.add({
      endpoint: identity,
      fingerprint: fingerprintOf(identity),
      grant,
      name,
      state: 'awaiting_pairback',
      ...(receipt ? { receipt, invitation: receipt } : {}),
      pairedAt: Date.now()
    })
    this.helper().claim(identity)
    this.port.changed()
  }

  /**
   * Rows the host owes (§5.1 recovery: the app stopped between `enrolled` and its write): every live owner grant
   * with no row gets one in `awaiting_pairback`.
   */
  async reconcileGrants(): Promise<void> {
    const answer = await this.helper().request('grants.list')
    this.alive()
    const now = Date.now() / 1000
    for (const grant of Array.isArray(answer.grants) ? answer.grants : []) {
      if (!grant || typeof grant.identity !== 'string') continue
      if (grant.role !== undefined && grant.role !== 'owner') continue
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
    if (row.state === 'connected' && this.port.sessions.online(row.localId)) return
    this.at('pairback')
    const add = (routes: string[]) =>
      this.helper().request('peer.add', { identity: row.endpoint, name: row.name, routes })
    try {
      try {
        await add(request.routes)
      } catch (error) {
        // The helper refuses the whole list for one address outside a private range (a tailnet's, say), which
        // the other computer's helper lists too: the private ones are kept.
        const usable = request.routes.filter(privateRoute)
        if (helperCode(error) !== 'bad_route' || usable.length === request.routes.length)
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
    await this.waitOnline(row.localId, engineLimits().pairbackDeadlineMs, () => this.dial(row))
    this.alive()
    peers.advance(row.localId, ['awaiting_pairback'], { state: 'connected' })
    this.port.changed()
  }

  // ---------------------------------------------------------------- connections and recovery

  /** A client of a pairing is ready: waiters wake, and a pairing that owes its pairback sends it now. */
  clientReady(node: NodeId): void {
    this.notAccepted.delete(node)
    this.outsideWindow.delete(node)
    for (const wake of [...this.waiters]) wake()
    const row = this.port.peers.serving(node)
    if (row && (row.state === 'granted' || row.state === 'joined')) void this.advance(node)
  }

  /**
   * After each helper `hello` (a start, or a helper started again): removals finish, each unfinished ceremony
   * resumes, the host's owed rows are written, and every pairing with an address is dialled again.
   */
  async recover(): Promise<void> {
    const { peers } = this.port
    for (const row of peers.inState('removing'))
      await this.finishRemoval(row).catch(() => undefined)
    await this.reconcileGrants().catch(() => undefined)
    for (const row of peers.all()) {
      if (this.crashed || this.stopped) return
      if (row.state === 'consented' || row.state === 'joined' || row.state === 'granted')
        void this.advance(row.localId)
      if (row.state === 'joined' || row.state === 'granted' || row.state === 'connected')
        void this.dial(row).catch(() => undefined)
    }
  }

  /** A pairing step failed: it is tried again after `pairingRetryMs`, while this run lasts. */
  private retryLater(node: NodeId): void {
    if (this.retries.has(node) || this.stopped || this.crashed) return
    const timer = setTimeout(() => {
      this.retries.delete(node)
      if (!this.stopped && !this.crashed) void this.advance(node)
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
            device: typeof event.device === 'string' ? event.device : ''
          })
          this.port.changed()
          return
        }
        case 'enrolled':
          this.enrolled(event)
          return
        case 'invite.ended':
          for (const [request, approval] of this.approvals)
            if (approval.invitation === event.invitation) this.approvals.delete(request)
          this.port.changed()
          return
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

  private async removing(node: NodeId): Promise<void> {
    const { peers } = this.port
    peers.advance(node, SERVING, { state: 'removing' })
    this.notAccepted.delete(node)
    this.port.changed()
    if (!engineControl('teardown-on-event-only')) this.port.teardown(node)
    // A step that waits for a connection stops now; one waiting on the helper (`grant.add`, say) ends first, so
    // the grant it made is there to revoke and it writes nothing after.
    for (const wake of [...this.waiters]) wake()
    this.at('removing')
    await this.running.get(node)?.catch(() => undefined)
    await this.finishRemoval(peers.get(node)!)
  }

  /** Steps 2 and 3 of a removal; a replay that finds the grant or the peer gone already carries on. */
  private async finishRemoval(row: EnginePeerRow): Promise<void> {
    if (row.state !== 'removing') return
    if (!engineControl('teardown-on-event-only')) this.port.teardown(row.localId)
    const helper = this.port.helper()
    if (!helper) throw new NetError('peer_offline', "Couldn't remove; try again.")
    if (row.invitation && row.state === 'removing' && row.ticket)
      await helper.request('join.cancel', { invitation: row.invitation }).catch(() => undefined)
    try {
      // The row's grant, and any other this computer made for that endpoint (a `grant.add` whose answer the
      // removal overtook): none may outlive the removal and bring the pairing back.
      const grants = new Set<number>()
      if (row.grant !== '' && Number.isSafeInteger(Number(row.grant))) grants.add(Number(row.grant))
      const listed = await helper.request('grants.list')
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
    if (row.endpoint) await helper.request('peer.forget', { identity: row.endpoint })
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

const SERVING = ['consented', 'joined', 'granted', 'awaiting_pairback', 'connected'] as const

/** The other computer refuses this one (it removed it, or never let it in). */
function isRefusal(error: unknown): boolean {
  const code = helperCode(error)
  return code === 'not_authorized' || code === 'grant_revoked' || code === 'pairing_declined'
}
